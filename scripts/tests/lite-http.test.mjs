// lite-http 门面用例（node:test 形态，可 `node --test` 或直跑）：默认转发真实 node:http；
// mock() 设置内存 http 实现、unmock() 移除——注入（inject）是内存实现上的能力：命中规则收到
// 错误响应（500 等），未命中按 ECONNREFUSED 拒连（模拟接口无法访问）；规则随 unmock 一并丢弃。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';
import { t_urlInjectionRequest } from './lite-http-helpers.mjs';

// probeHealth 形状的探活（回调式 http.request 消费门面）。
function f_probe(port, path = '/api/health') {
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

/** 场景：传输层故障注入——命中规则的请求收到注入的错误响应。 */
test('注入 500：命中路径的探活收到 500 与错误正文', async () => {
  // 输入：mock 后对探活路径注入 500 故障
  liteHttp.t_mock();
  let removeFault;
  try {
    removeFault = liteHttp.t_inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
    const broken = await f_probe(8888);
    // 预期 1：探活判失败
    assert.equal(broken.ok, false, '注入 500 应判探活失败');
    // 预期 2：状态码为注入的 500
    assert.equal(broken.status, 500, '状态码应为注入的 500');
    // 预期 3：错误正文来自注入规则
    assert.equal(JSON.parse(broken.body).error, '心跳接口不可达', '错误正文应来自注入规则');
  } finally {
    removeFault?.();
    liteHttp.t_unmock();
  }
});

/** 场景：规则未命中——无规则路径按拒连模拟接口无法访问。 */
test('规则未命中：无规则路径按 ECONNREFUSED 拒连', async () => {
  // 输入：对 /api/health 注入规则后探活无规则的 /api/other
  liteHttp.t_mock();
  let removeFault;
  try {
    removeFault = liteHttp.t_inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
    const missed = await f_probe(8888, '/api/other');
    // 预期 1：探活失败
    assert.equal(missed.ok, false, '未命中路径应探活失败');
    // 预期 2：按 ECONNREFUSED 拒连
    assert.equal(missed.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
  } finally {
    removeFault?.();
    liteHttp.t_unmock();
  }
});

/** 场景：get 简写——http.get 形状与 request 同口径受注入规则约束。 */
test('get 简写：与 request 同口径命中注入 500', async () => {
  // 输入：注入 500 后经 liteHttp.get 发起请求
  liteHttp.t_mock();
  let removeFault;
  try {
    removeFault = liteHttp.t_inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
    const result = await new Promise((resolve) => {
      liteHttp.get({ hostname: '127.0.0.1', port: 8888, path: '/api/health' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', (error) => resolve({ code: error.code }));
    });
    // 预期 1：get 简写收到注入的 500
    assert.equal(result.status, 500, 'get 简写应同样收到注入的 500');
    // 预期 2：错误正文来自注入规则
    assert.equal(JSON.parse(result.body).error, '心跳接口不可达', '错误正文应来自注入规则');
  } finally {
    removeFault?.();
    liteHttp.t_unmock();
  }
});

/** 场景：非法注入与前置约束——2xx 成功回包替换拒绝、未 mock 即注入拒绝。 */
test('非法注入与前置约束：2xx 拒绝、未 mock 即 inject 拒绝', async () => {
  // 输入：mock 后注入 200 成功回包
  liteHttp.t_mock();
  try {
    // 预期 1：拒绝（仅允许错误状态 400–599）
    assert.throws(() => liteHttp.t_inject({ path: '/api/health', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
  } finally {
    liteHttp.t_unmock();
  }
  // 输入：未 mock 状态下注入 500
  // 预期 2：拒绝并提示先 mock
  assert.throws(() => liteHttp.t_inject({ path: '/api/health', status: 500 }), /先 t_mock/, '未设置内存实现时注入应拒绝');
});

/** 场景：移除函数——注入返回的移除函数撤规则后回到拒连，且幂等。 */
test('移除函数：撤规则后回到拒连、重复调用幂等', async () => {
  // 输入：注入 500 后调用返回的移除函数（两次验证幂等）
  liteHttp.t_mock();
  try {
    const remove = liteHttp.t_inject({ path: '/api/health', status: 500 });
    // 预期 1：移除前规则生效（500）
    assert.equal((await f_probe(8888)).status, 500, '移除前规则应生效');
    remove();
    remove(); // 幂等
    const refused = await f_probe(8888);
    // 预期 2：移除后不再命中规则
    assert.equal(refused.ok, false, '移除后应不再命中规则');
    // 预期 3：回到 ECONNREFUSED 拒连
    assert.equal(refused.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
  } finally {
    liteHttp.t_unmock();
  }
});

/** 场景：幂等与恢复——重复 mock 复用既有规则，unmock 回真实 node:http。 */
test('幂等与恢复：重复 mock 保留规则、unmock 回真实实现', async () => {
  // 输入：注入规则后重复 mock（幂等）、再 unmock 探活
  liteHttp.t_mock();
  const removeFault = liteHttp.t_inject({ path: '/api/health', status: 500 });
  liteHttp.t_mock(); // 幂等：复用当前内存实现，不丢规则
  // 预期 1：重复 mock 不丢弃已注入规则
  assert.equal((await f_probe(8888)).status, 500, '重复 mock 不应丢弃已注入规则');
  // 输入：unmock 后探活无人监听端口
  removeFault();
  liteHttp.t_unmock();
  const refused = await f_probe(1);
  // 预期 2：回到真实 node:http connect 语义
  assert.equal(refused.code, 'ECONNREFUSED', 'unmock 后应回到真实 node:http connect 语义');
});

/** 场景：URL 定向传输故障，来源、端口、完整查询串与方法分别隔离，未命中不消耗 once。 */
test('URL 注入：绝对地址、路径、查询顺序、方法与 once 隔离', async () => {
  liteHttp.t_mock();
  liteServer.t_mock();
  let handled = 0;
  const server = liteServer.createServer((req, res) => { handled++; res.end('handler'); }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://localhost:${server.port}`;
    const send = (path, extra = {}) => t_urlInjectionRequest(liteHttp, { hostname: 'localhost', port: server.port, path, ...extra });
    // 输入：规范化主机名和 fragment 的绝对 URL，同时限定 POST、旧 path/query 条件与 once
    liteHttp.t_inject({ url: new URL(`${base.toUpperCase()}/same?a=1&b=2#ignored`), method: 'POST', path: '/same', query: { a: 1 }, status: 503, once: true });
    const misses = [
      await send('/same?a=1&b=2'),
      await send('/same?b=2&a=1', { method: 'POST' }),
      await send('/same?a=1&b=2&c=3', { method: 'POST' }),
      await send('/same?a=1&b=2', { method: 'POST', hostname: '127.0.0.1' }),
      await send('/same?a=1&b=2', { method: 'POST', headers: { Host: `localhost:${server.port + 1}` } }),
    ];
    // 预期 1：同路径的其他方法、查询串、主机和端口均应到达真实 handler
    assert.deepEqual(misses.map(out => out.status), [200, 200, 200, 200, 200], '不同 URL 或方法不能命中或消耗 once');
    // 预期 2：完整匹配后才消耗 once，传输层命中不执行 handler
    assert.equal((await send('/same?a=1&b=2', { method: 'POST' })).status, 503, '精确 URL 和 POST 应命中');
    assert.equal(handled, 5, '传输故障应在 handler 前拦截');
    assert.equal((await send('/same?a=1&b=2', { method: 'POST' })).status, 200, 'once 后应恢复 handler');
    // 输入：路径 URL 跨来源生效，重复参数与顺序保留；删除后恢复真实响应
    const remove = liteHttp.t_inject({ url: '/same?x=1&x=2#ignored', status: 502 });
    // 预期 3：路径规则不限定来源，但严格比较完整查询串
    assert.equal((await send('/same?x=1&x=2', { hostname: 'other.test' })).status, 502, '路径 URL 应跨来源命中');
    assert.equal((await send('/same?x=2&x=1')).status, 200, '重复查询参数顺序不同不能命中');
    assert.equal((await send('/same?x=1&x=2', { method: 'POST' })).status, 502, '未限定 method 时各方法均可命中 URL');
    remove(); remove();
    assert.equal((await send('/same?x=1&x=2')).status, 200, '移除 URL 规则应幂等恢复');
    // 输入：省略默认端口的 URL 规则，使用显式 80 端口与 fragment 的 URL 请求
    const removeHttp504 = liteHttp.t_inject({ url: 'http://EXAMPLE.test/default', status: 504 });
    // 预期 4：默认端口和主机名规范化，fragment 不参与匹配
    assert.equal((await t_urlInjectionRequest(liteHttp, new URL('http://example.test:80/default#ignored'))).status, 504, '默认端口、主机大小写和 fragment 应规范化');
    const removeHttps504 = liteHttp.t_inject({ url: new URL('https://example.test/default'), status: 504 });
    assert.equal((await t_urlInjectionRequest(liteHttp, new URL('https://example.test:443/default'))).status, 504, 'HTTPS URL 对象应使用默认 443 端口匹配');
    assert.equal((await t_urlInjectionRequest(liteHttp, 'https://example.test/default')).status, 504, 'HTTPS 字符串应与 URL 对象保持一致');
    // 预期 5：非法 URL 在登记时拒绝，不留给请求阶段报错
    for (const url of ['', 'relative', '//example.test/same', 'ftp://example.test/same', 1, {}])
      assert.throws(() => liteHttp.t_inject({ url, status: 503 }), /url/, '非法 URL 应在注入时拒绝');
    removeHttp504();
    removeHttps504();
  } finally { liteHttp.t_unmock(); liteServer.t_unmock(); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-http.mjs 导入的
 * 门面与库内部相对导入必须是同一实例，否则注入规则会静默分裂（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async () => {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('../lite-http.mjs');
  assert.equal(selfRef.default, liteHttp, '同一模块经不同 specifier 应共享同一实例');
});

/** 场景：https 客户端面——未 mock 原样转发 node:https（拒连错误与 http 同形态），mock 后走
 * 同一内存传输且协议标记进入匹配 URL，注入规则对 https 请求同样命中；未命中按拒连不外联。 */
test('https 面：未 mock 真实转发，mock 后同内存传输且注入命中', async () => {
  // 输入 1：未 mock 对无人监听端口发起 httpsRequest，捕获拒连错误
  liteHttp.t_unmock();
  const refused = await new Promise(resolve => {
    const req = liteHttp.httpsRequest({ hostname: '127.0.0.1', port: 1, path: '/x', agent: false });
    req.on('error', error => resolve({ code: error.code, syscall: error.syscall }));
    req.end();
    req.setTimeout(2000, () => { req.destroy(); resolve({ timeout: true }); }); // socket 空闲兜底，防真实网络不拒连挂死
  });
  // 预期 1：真实 https 层拒连（ECONNREFUSED），证明转发的是 node:https 而非内存实现
  assert.equal(refused.code, 'ECONNREFUSED', '未 mock 的 httpsRequest 应转发真实 node:https 拒连');
  assert.equal(refused.syscall, 'connect', '拒连应发生在 connect 系统调用');

  // 输入 2：mock 后对象形态 httpsRequest——协议缺省补 https:，注入规则按 https origin 命中
  liteHttp.t_mock();
  liteServer.t_mock();
  try {
    const rm = liteHttp.t_inject({ url: 'https://asc.invalid/v1/profiles', method: 'GET', status: 503, error: 'ASC 不可达' });
    const hit = await new Promise(resolve => {
      liteHttp.httpsRequest({ hostname: 'asc.invalid', path: '/v1/profiles' }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', error => resolve({ error: error.message })).end();
    });
    // 预期 2：注入命中（503 + 注入正文）——协议标记由 https 面补齐，与原生 https.request
    // 对无协议 options 的缺省行为一致
    assert.equal(hit.status, 503, '注入规则应对 https 请求命中');
    assert.match(hit.body, /ASC 不可达/, '注入错误正文应回给调用方');
    rm();

    // 输入 3：未命中注入的 https 请求按无监听拒连（内存世界不真实外联）
    const miss = await new Promise(resolve => {
      liteHttp.httpsRequest({ hostname: 'asc.invalid', path: '/v1/other' }, () => resolve({ responded: true }))
        .on('error', error => resolve({ code: error.code })).end();
    });
    // 预期 3：未命中的 https 请求按 ECONNREFUSED 拒连，不真实外联
    assert.equal(miss.code, 'ECONNREFUSED', '未命中注入的 https 请求应拒连而非真实外联');
  } finally {
    liteHttp.t_unmock();
    liteServer.t_unmock();
  }
});

// 私有方法：通过公开客户端接口发送请求，同时保留取消句柄。
const f_send = (path = '/', options = {}) => {
  let req;
  const response = new Promise((resolve, reject) => {
    req = liteHttp.request({ hostname: 'transport.test', port: 443, path, ...options }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers, faulted: res.faulted }));
    });
    req.on('error', reject);
    req.end();
  });
  return { req, response };
};

/** 场景：客户端复位只清传输层故障，服务登记及响应阶段故障继续有效。 */
test('客户端复位不清服务路由与服务端故障', async () => {
  // 输入：两层故障同时生效后，只卸载并重建客户端。
  liteHttp.t_unmock(); liteServer.t_unmock();
  liteServer.t_mock(); liteHttp.t_mock();
  let handled = 0;
  let removeServerFault, removeClientFault;
  const server = liteServer.createServer((_req, res) => { handled++; res.end('handler'); });
  try {
    await new Promise(resolve => server.listen({ virtual: true, host: 'transport.test', port: 443 }, resolve));
    removeServerFault = liteServer.t_inject({ path: '/', status: 502 });
    removeClientFault = liteHttp.t_inject({ path: '/', status: 503 });
    assert.equal((await f_send().response).status, 503, '传输层故障应先于服务端处理');
    assert.equal(handled, 0, '传输层故障不应执行 handler');
    liteHttp.t_unmock(); liteHttp.t_mock();
    assert.equal((await f_send().response).status, 502, '客户端复位后应保留服务端故障');
    assert.equal(handled, 1, '服务路由应继续执行原 handler');
  } finally { removeServerFault?.(); removeClientFault?.(); liteHttp.t_unmock(); liteServer.t_unmock(); }
});

/** 场景：传输闸门命中后取消请求，once 已消耗且取消请求不会抵达 handler。 */
test('传输闸门取消不投递且 once 不阻塞后续请求', async () => {
  // 输入：请求命中一次性传输闸门后主动取消，再释放闸门并请求相同地址。
  liteHttp.t_unmock(); liteServer.t_unmock();
  liteHttp.t_mock(); liteServer.t_mock();
  const gate = Promise.withResolvers();
  let handled = 0;
  const server = liteServer.createServer((_req, res) => { handled++; res.end('healthy'); });
  try {
    await new Promise(resolve => server.listen({ virtual: true, host: 'transport.test', port: 443 }, resolve));
    liteHttp.t_inject({ path: '/', wait: gate.promise, once: true });
    const held = f_send();
    let delivered = false;
    held.req.on('response', () => { delivered = true; });
    const closed = new Promise(resolve => held.req.once('close', resolve));
    held.req.destroy();
    await closed;
    gate.resolve();
    assert.equal((await f_send().response).body.toString(), 'healthy', 'once 闸门不能继续拦截后续请求');
    assert.equal(handled, 1, '仅后续健康请求可以执行 handler');
    assert.equal(delivered, false, '取消请求不得收到响应');
  } finally { gate.resolve(); liteServer.t_unmock(); liteHttp.t_unmock(); }
});

/** 场景：客户端重建不改写已领取的故障，旧请求与新请求分别使用各自的配置。 */
test('客户端重建后在途请求保留已命中故障', async () => {
  // 输入：旧客户端已有请求等待故障闸门，重建后发送新请求，再放行旧请求。
  liteHttp.t_unmock(); liteServer.t_unmock();
  liteHttp.t_mock(); liteServer.t_mock();
  const gate = Promise.withResolvers();
  const server = liteServer.createServer((_req, res) => res.end('healthy'));
  let held;
  try {
    await new Promise(resolve => server.listen({ virtual: true, host: 'transport.test', port: 443 }, resolve));
    liteHttp.t_inject({ path: '/', wait: gate.promise, status: 503, once: true });
    held = f_send();
    liteHttp.t_unmock(); liteHttp.t_mock();
    assert.equal((await f_send().response).body.toString(), 'healthy', '新客户端不能继承旧客户端故障');
    gate.resolve();
    assert.equal((await held.response).status, 503, '旧请求应保留已命中的故障');
  } finally { gate.resolve(); if (held) await held.response; liteServer.t_unmock(); liteHttp.t_unmock(); }
});
