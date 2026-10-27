// lite-http 门面用例：默认转发真实 node:http；mock() 设置内存 http 实现、unmock() 移除——
// 注入（inject）是内存实现上的能力：命中规则收到错误响应（500 等），未命中按 ECONNREFUSED
// 拒连（模拟接口无法访问）；规则随 unmock 一并丢弃。
import assert from 'node:assert/strict';
import liteHttp from '../lite-http.mjs';
import { runCases } from './run-cases.mjs';

// probeHealth 形状的探活（回调式 http.request 消费门面）。
function probe(port, path = '/api/health') {
  return new Promise((resolve) => {
    const req = liteHttp.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', timeout: 1500 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
      }
    );
    req.on('error', (error) => resolve({ ok: false, code: error.code }));
    req.end();
  });
}

await runCases([
    /** 场景：默认真实实现；输入：未 mock 时请求 loopback 无人监听端口；预期：真实 node:http 的 ECONNREFUSED。 */
    async function defaultDelegatesToNodeHttp() {
        const refused = await probe(1);
        assert.equal(refused.ok, false, '无人监听端口应探活失败');
        assert.equal(refused.code, 'ECONNREFUSED', '错误应来自真实 node:http connect 语义');
    },
    /** 场景：注入 500；输入：mock 后对探活路径注入规则；预期：回调收到 500 与错误正文，探活 ok=false。 */
    async function injected500BreaksHeartbeat() {
        liteHttp.mock();
        try {
            liteHttp.inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
            const broken = await probe(8888);
            assert.equal(broken.ok, false, '注入 500 应判探活失败');
            assert.equal(broken.status, 500, '状态码应为注入的 500');
            assert.equal(JSON.parse(broken.body).error, '心跳接口不可达', '错误正文应来自注入规则');
        }
        finally {
            liteHttp.unmock();
        }
    },
    /** 场景：规则未命中；输入：内存实现下请求无规则路径；预期：按 ECONNREFUSED 拒连（接口无法访问）。 */
    async function unmatchedPathIsRefused() {
        liteHttp.mock();
        try {
            liteHttp.inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
            const missed = await probe(8888, '/api/other');
            assert.equal(missed.ok, false, '未命中路径应探活失败');
            assert.equal(missed.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
        }
        finally {
            liteHttp.unmock();
        }
    },
    /** 场景：get 简写；输入：http.get 形状调用；预期：与 request 同口径注入 500。 */
    async function getShorthandMatchesRequest() {
        liteHttp.mock();
        try {
            liteHttp.inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
            const result = await new Promise((resolve) => {
                liteHttp.get({ hostname: '127.0.0.1', port: 8888, path: '/api/health' }, (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => resolve({ status: res.statusCode, body: data }));
                }).on('error', (error) => resolve({ code: error.code }));
            });
            assert.equal(result.status, 500, 'get 简写应同样收到注入的 500');
            assert.equal(JSON.parse(result.body).error, '心跳接口不可达', '错误正文应来自注入规则');
        }
        finally {
            liteHttp.unmock();
        }
    },
    /** 场景：非法注入与前置约束；输入：2xx 状态、未 mock 即 inject；预期：均拒绝。 */
    async function invalidInjectionIsRejected() {
        liteHttp.mock();
        try {
            assert.throws(() => liteHttp.inject({ path: '/api/health', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
        }
        finally {
            liteHttp.unmock();
        }
        assert.throws(() => liteHttp.inject({ path: '/api/health', status: 500 }), /先 mock/, '未设置内存实现时注入应拒绝');
    },
    /** 场景：移除函数；输入：注入后调用返回的移除函数；预期：规则移除后回到拒连。 */
    async function injectionRemoverRestoresRefusal() {
        liteHttp.mock();
        try {
            const remove = liteHttp.inject({ path: '/api/health', status: 500 });
            assert.equal((await probe(8888)).status, 500, '移除前规则应生效');
            remove();
            remove(); // 幂等
            const refused = await probe(8888);
            assert.equal(refused.ok, false, '移除后应不再命中规则');
            assert.equal(refused.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
        }
        finally {
            liteHttp.unmock();
        }
    },
    /** 场景：mock 幂等与 unmock 丢弃；输入：重复 mock、unmock 后再请求；预期：重复 mock 保留规则，unmock 回真实实现。 */
    async function mockIdempotentAndUnmockDropsRules() {
        liteHttp.mock();
        liteHttp.inject({ path: '/api/health', status: 500 });
        liteHttp.mock(); // 幂等：复用当前内存实现，不丢规则
        assert.equal((await probe(8888)).status, 500, '重复 mock 不应丢弃已注入规则');
        liteHttp.unmock();
        const refused = await probe(1);
        assert.equal(refused.code, 'ECONNREFUSED', 'unmock 后应回到真实 node:http connect 语义');
    },
]);
