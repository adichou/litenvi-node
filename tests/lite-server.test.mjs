// lite-server 门面用例：服务端面（createServer）独立门面——mock() 登记内存服务（listen 只记
// 端口、不绑 socket），lite-http 内存客户端的 loopback 请求经 handle() 路由到真实 handler
//（回包即真实路由代码产物）；inject 注入服务端故障（handler 已执行，回包被 wait 闸门挂起或
// 按 status 错误回包替换）——与 lite-http.inject（请求未达服务端即被传输层拦截）分层归属。
import assert from 'node:assert/strict';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';
import { runCases } from './run-cases.mjs';

function get(port, path) {
  return new Promise((resolve) => {
    liteHttp.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, faulted: res.faulted === true }));
    }).on('error', (error) => resolve({ code: error.code })).end();
  });
}

async function withBoard(handler, run) {
  liteHttp.mock();
  liteServer.mock();
  liteServer.createServer(handler).listen(8888);
  try {
    return await run();
  } finally {
    liteHttp.unmock();
    liteServer.unmock();
  }
}

await runCases([
    /** 场景：内存路由基本面；输入：登记 handler + listen 后 loopback GET；预期：回包来自真实 handler。 */
    async function routesLoopbackToRealHandler() {
        let handlerRan = false;
        const out = await withBoard(
            (req, res) => {
                handlerRan = true;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url: req.url }));
            },
            () => get(8888, '/api/echo?a=1'),
        );
        assert.equal(out.status, 200, '内存路由应答真实 handler 的 200');
        assert.deepEqual(JSON.parse(out.body), { ok: true, url: '/api/echo?a=1' }, '回包内容应来自真实路由代码');
        assert.equal(out.faulted, false, '无故障时回包不带故障标记');
        assert.equal(handlerRan, true, 'handler 应真实执行');
    },
    /** 场景：无监听服务；输入：mock 但未登记服务 / 端口不符；预期：客户端按 ECONNREFUSED 拒连。 */
    async function noServerIsRefused() {
        liteHttp.mock();
        liteServer.mock();
        try {
            const refused = await get(8888, '/api/health');
            assert.equal(refused.code, 'ECONNREFUSED', '未登记服务应按拒连');
            const wrongPort = await get(9999, '/api/health');
            assert.equal(wrongPort.code, 'ECONNREFUSED', '端口不符应按拒连');
        }
        finally {
            liteHttp.unmock();
            liteServer.unmock();
        }
    },
    /** 场景：服务端故障替换回包；输入：handler 执行后注入 503；预期：handler 已跑、客户端收到 503 故障回包。 */
    async function serverFaultReplacesResponse() {
        let handlerRan = false;
        const out = await withBoard(
            (req, res) => {
                handlerRan = true;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            },
            async () => {
                liteServer.inject({ path: '/api/health', status: 503, body: { error: '服务暂不可用' } });
                return get(8888, '/api/health');
            },
        );
        assert.equal(handlerRan, true, '响应阶段故障下 handler 应已执行（与传输层拦截的分层差异）');
        assert.equal(out.status, 503, '客户端应收到注入的 503');
        assert.equal(JSON.parse(out.body).error, '服务暂不可用', '错误正文应来自注入规则');
        assert.equal(out.faulted, true, '故障替换回包应带标记');
    },
    /** 场景：wait 闸门挂起回包；输入：注入 wait Promise 的服务端故障；预期：放行前无回包、放行后真实回包。 */
    async function serverWaitGateHoldsResponse() {
        const gate = Promise.withResolvers();
        const pending = await withBoard(
            (req, res) => res.end(JSON.stringify({ ok: true })),
            async () => {
                liteServer.inject({ path: '/api/slow', wait: gate.promise });
                const req = get(8888, '/api/slow');
                return Promise.race([req, new Promise((r) => setTimeout(() => r({ held: true }), 200))]);
            },
        );
        assert.equal(pending.held, true, '闸门放行前不应有回包');
        gate.resolve();
        const out = await withBoard(
            (req, res) => res.end(JSON.stringify({ ok: true })),
            () => {
                const g = Promise.withResolvers();
                const req = get(8888, '/api/slow');
                liteServer.inject({ path: '/api/slow', wait: g.promise });
                g.resolve();
                return req;
            },
        );
        assert.equal(out.status, 200, '放行后应收到真实 handler 回包');
        assert.equal(out.faulted, false, '真实回包不带故障标记');
    },
    /** 场景：once 自毁与非法注入；输入：once 命中后再次请求、2xx/phase 字段注入；预期：once 只拦一次、非法注入拒绝。 */
    async function onceSelfDestructsAndInjectionIsValidated() {
        const out = await withBoard(
            (req, res) => res.end(JSON.stringify({ ok: true })),
            async () => {
                liteServer.inject({ path: '/api/once', status: 503, once: true });
                const first = await get(8888, '/api/once');
                const second = await get(8888, '/api/once');
                assert.throws(() => liteServer.inject({ path: '/x', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
                assert.throws(() => liteServer.inject({ path: '/x', status: 503, phase: 'response' }), /不支持字段/, '阶段字段已由注入入口本身表达');
                return { first, second };
            },
        );
        assert.equal(out.first.status, 503, '首次请求应命中故障');
        assert.equal(out.first.faulted, true, '故障回包应带标记');
        assert.equal(out.second.status, 200, 'once 命中即自毁，第二次应回到真实回包');
        assert.equal(out.second.faulted, false, '真实回包不带故障标记');
        assert.throws(() => liteServer.inject({ status: 503 }), /先 mock/, '未设置内存实现时注入应拒绝');
    },
]);
