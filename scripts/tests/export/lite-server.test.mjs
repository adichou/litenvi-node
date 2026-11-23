// lite-server 门面用例（node:test 形态，可 `node --test` 或直跑）：服务端面（createServer）
// 独立门面——mock() 登记内存服务，listen 真实绑定 127.0.0.1（显式端口即绑该口，缺省动态
// 空闲口）：浏览器等真实客户端经真实 loopback socket 到达 socket 前端，前端把请求回灌进程内
// 管线（包内 transport 传输层故障 → handle() 中的真实 handler → 响应阶段故障），回包写回真实
// socket；进程内客户端进入同一内存路由（不经 socket）。inject 注入服务端
// 故障（handler 已执行，回包被 wait 闸门挂起或按 status 错误回包替换）——与 lite-http.t_inject
//（请求未达服务端即被传输层拦截）分层归属。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteHttp from '../../lite-http.mjs';
import liteServer from '../../lite-server.mjs';
import { i_urlInjectionRequest } from '../lite-http-helpers.mjs';



/** 场景：虚拟服务关闭走故障闸门，关闭后路由立即失效。 */
test('虚拟服务关闭同样遵守故障闸门且立即停止路由', async function test_虚拟服务关闭同样遵守故障闸门且立即停止路由() {
  // 输入：虚拟服务注入关闭故障后请求并解除注入。
  liteHttp.t_mock(); liteServer.t_mock();
  const gate = Promise.withResolvers();
  const server = liteServer.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen({ virtual: true, host: 'gate.test', port: 443 }, resolve));
  try {
    liteServer.t_inject({ operation: 'close', wait: gate.promise, once: true });
    let closed = false;
    const done = new Promise(resolve => server.close(() => { closed = true; resolve(); }));
    const refusal = await new Promise(resolve => liteHttp.request({ hostname: 'gate.test', port: 443 }).on('error', error => resolve(error.code)).end());
    assert.equal(refusal, 'ECONNREFUSED', '关闭后不应继续响应新请求');
    assert.equal(closed, false, '关闭回调应等待故障闸门');
    gate.resolve();
    await done;
    assert.equal(closed, true, '释放闸门后关闭应完成');
  } finally { gate.resolve(); liteServer.t_unmock(); liteHttp.t_unmock(); }
});

function f_get(port, path) {
  return new Promise((resolve) => {
    liteHttp.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, faulted: res.faulted === true }));
    }).on('error', (error) => resolve({ code: error.code })).end();
  });
}

async function f_withBoard(handler, run) {
  liteHttp.t_mock();
  liteServer.t_mock();
  const server = liteServer.createServer(handler).listen(0);
  await new Promise((resolve) => server.once('listening', resolve)); // 真实绑定异步：就绪后才取实际端口
  try {
    return await run(server.port);
  } finally {
    liteHttp.t_unmock();
    liteServer.t_unmock();
  }
}

const f_boardHandler = (req, res) => {
  const at = req.url.indexOf('?');
  const path = at === -1 ? req.url : req.url.slice(0, at);
  if (path === '/api/echo') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, url: req.url, echo: body || null }));
    });
    return;
  }
  if (path === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
    res.end('body{}');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '未知接口' }));
};

/** 场景：内存路由基本面——登记 handler 后 loopback 请求回包来自真实路由代码。 */
test('内存路由基本面：loopback GET 回包来自真实 handler', async function test_内存路由基本面_loopback_GET_回包来自真实_handler() {
  // 输入：登记带执行标记的 handler，经内存客户端 GET /api/echo?a=1
  let handlerRan = false;
  const out = await f_withBoard(
    (req, res) => {
      handlerRan = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    },
    (port) => f_get(port, '/api/echo?a=1'),
  );
  // 预期 1：应答真实 handler 的 200
  assert.equal(out.status, 200, '内存路由应答真实 handler 的 200');
  // 预期 2：回包内容来自真实路由代码（含查询串）
  assert.deepEqual(JSON.parse(out.body), { ok: true, url: '/api/echo?a=1' }, '回包内容应来自真实路由代码');
  // 预期 3：无故障时回包不带故障标记
  assert.equal(out.faulted, false, '无故障时回包不带故障标记');
  // 预期 4：handler 真实执行
  assert.equal(handlerRan, true, 'handler 应真实执行');
});

/** 场景：无监听服务——mock 但未登记服务或端口不符时按拒连。 */
test('无监听服务：未登记服务/端口不符按 ECONNREFUSED 拒连', async function test_无监听服务_未登记服务_端口不符按_ECONNREFUSED_拒连() {
  // 输入：mock 两门面但不 createServer，探活默认端口
  liteHttp.t_mock();
  liteServer.t_mock();
  try {
    const refused = await f_get(8888, '/api/health');
    // 预期 1：未登记服务按拒连
    assert.equal(refused.code, 'ECONNREFUSED', '未登记服务应按拒连');
    // 输入：探活另一个端口
    const wrongPort = await f_get(9999, '/api/health');
    // 预期 2：端口不符按拒连
    assert.equal(wrongPort.code, 'ECONNREFUSED', '端口不符应按拒连');
  } finally {
    liteHttp.t_unmock();
    liteServer.t_unmock();
  }
});

/** 场景：服务端故障替换回包——handler 已执行，注入 503 替换真实回包。 */
test('服务端故障：注入 503 替换回包、handler 已执行、回包带故障标记', async function test_服务端故障_注入_503_替换回包_handler_已执行_回包带故障标记() {
  // 输入：登记带执行标记的 handler，注入 503 服务端故障后请求
  let handlerRan = false;
  const out = await f_withBoard(
    (req, res) => {
      handlerRan = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    async (port) => {
      const removeFault = liteServer.t_inject({ path: '/api/health', status: 503, body: { error: '服务暂不可用' } });
      const out = await f_get(port, '/api/health');
      removeFault();
      return out;
    },
  );
  // 预期 1：响应阶段故障下 handler 已执行（与传输层拦截的分层差异）
  assert.equal(handlerRan, true, '响应阶段故障下 handler 应已执行（与传输层拦截的分层差异）');
  // 预期 2：客户端收到注入的 503
  assert.equal(out.status, 503, '客户端应收到注入的 503');
  // 预期 3：错误正文来自注入规则
  assert.equal(JSON.parse(out.body).error, '服务暂不可用', '错误正文应来自注入规则');
  // 预期 4：故障替换回包带标记
  assert.equal(out.faulted, true, '故障替换回包应带标记');
});

/** 场景：wait 闸门挂起回包——放行前无回包，放行后送达真实回包。 */
test('wait 闸门：放行前无回包、放行后真实回包不带故障标记', async function test_wait_闸门_放行前无回包_放行后真实回包不带故障标记() {
  // 输入：注入 wait 闸门的服务端故障，200ms 内观察是否有回包
  const gate = Promise.withResolvers();
  const pending = await f_withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    async (port) => {
      const removeGate = liteServer.t_inject({ path: '/api/slow', wait: gate.promise });
      const req = f_get(port, '/api/slow');
      const raced = await Promise.race([req, new Promise((r) => setTimeout(() => r({ held: true }), 200))]);
      removeGate();
      return raced;
    },
  );
  // 预期 1：闸门放行前无回包
  assert.equal(pending.held, true, '闸门放行前不应有回包');
  // 输入：释放闸门后重新注入并立即放行
  gate.resolve();
  const out = await f_withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    (port) => {
      const g = Promise.withResolvers();
      const req = f_get(port, '/api/slow');
      const removeGate = liteServer.t_inject({ path: '/api/slow', wait: g.promise });
      g.resolve();
      removeGate();
      return req;
    },
  );
  // 预期 2：放行后收到真实 handler 的 200
  assert.equal(out.status, 200, '放行后应收到真实 handler 回包');
  // 预期 3：真实回包不带故障标记
  assert.equal(out.faulted, false, '真实回包不带故障标记');
});

/** 场景：once 自毁与非法注入——once 只拦一次，2xx/phase 字段与未 mock 注入均拒绝。 */
test('once 自毁与注入校验：只拦一次、2xx/phase/未 mock 注入拒绝', async function test_once_自毁与注入校验_只拦一次_2xx_phase_未_mock_注入拒绝() {
  // 输入：注入 once 503 后连续两次请求
  const out = await f_withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    async (port) => {
      liteServer.t_inject({ path: '/api/once', status: 503, once: true });
      const first = await f_get(port, '/api/once');
      const second = await f_get(port, '/api/once');
      // 输入：注入 200 成功回包
      // 预期 1：2xx 成功回包替换拒绝
      assert.throws(() => liteServer.t_inject({ path: '/x', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
      // 输入：带 phase 字段注入
      // 预期 2：phase 字段拒绝（阶段已由注入入口本身表达）
      assert.throws(() => liteServer.t_inject({ path: '/x', status: 503, phase: 'response' }), /不支持字段/, '阶段字段已由注入入口本身表达');
      return { first, second };
    },
  );
  // 预期 3：首次请求命中 503 故障
  assert.equal(out.first.status, 503, '首次请求应命中故障');
  // 预期 4：故障回包带标记
  assert.equal(out.first.faulted, true, '故障回包应带标记');
  // 预期 5：once 命中即自毁，第二次回到真实 200
  assert.equal(out.second.status, 200, 'once 命中即自毁，第二次应回到真实回包');
  // 预期 6：真实回包不带故障标记
  assert.equal(out.second.faulted, false, '真实回包不带故障标记');
  // 输入：unmock 后注入 503
  // 预期 7：未 mock 时注入拒绝
  assert.throws(() => liteServer.t_inject({ status: 503 }), /先 t_mock/, '未设置内存实现时注入应拒绝');
});







/** 场景：未 listen 即 close——无 socket 可关时回调即时送达。 */
test('未 listen 即 close：回调即时送达', async function test_未_listen_即_close_回调即时送达() {
  // 输入：mock 后 createServer 不 listen 直接 close
  liteHttp.t_mock();
  liteServer.t_mock();
  try {
    const server = liteServer.createServer(f_boardHandler);
    const closed = await new Promise((resolve) => server.close(() => resolve(true)));
    // 预期 1：close 回调即时送达
    assert.equal(closed, true, '未 listen 的 close 回调应即时送达');
  } finally {
    liteServer.t_unmock();
    liteHttp.t_unmock();
  }
});






/** 场景：关闭故障注入可延迟关闭回调，解除注入后回调完成。 */
test('服务关闭故障闸门延迟关闭回调并可释放', async function test_服务关闭故障闸门延迟关闭回调并可释放() {
  // 输入：关闭回调挂故障闸门，延迟后释放并确认回调完成。
  liteHttp.t_mock();
  liteServer.t_mock();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  try {
    const server = liteServer.createServer((_req, res) => res.end('ok')).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    liteServer.t_inject({ operation: 'close', wait, once: true });
    assert.equal((await f_get(server.port, '/')).status, 200, '关闭故障不得影响普通请求');
    let closed = false;
    const done = new Promise(resolve => server.close(() => { closed = true; resolve(); }));
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 30))]);
    assert.equal(closed, false, '闸门未释放前关闭回调应挂起');
    release();
    await done;
    assert.equal(closed, true, '释放闸门后关闭应完成');
  } finally { release(); liteServer.t_unmock(); liteHttp.t_unmock(); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-server.mjs 导入的
 * 门面与库内部相对导入必须是同一实例，否则服务账本会静默分裂（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async function test_包自引用_specifier_与相对导入共享同一单例() {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('../../lite-server.mjs');
  assert.equal(selfRef.default, liteServer, '同一模块经不同 specifier 应共享同一实例');
});

/** 场景：服务端复位撤销旧路由且不清客户端故障，重建后只执行新 handler。 */
test('服务端复位撤销旧路由并保留客户端故障', async function test_服务端复位撤销旧路由并保留客户端故障() {
  // 输入：保留客户端配置，卸载服务端后在相同地址登记新服务。
  const f_send = (path = '/') => i_urlInjectionRequest(liteHttp, { hostname: 'transport.test', port: 443, path });
  liteHttp.t_unmock(); liteServer.t_unmock();
  liteHttp.t_mock(); liteServer.t_mock();
  let oldHandled = 0;
  let removeServerFault, removeClientFault;
  const old = liteServer.createServer((_req, res) => { oldHandled++; res.end('old'); });
  try {
    await new Promise(resolve => old.listen({ virtual: true, host: 'transport.test', port: 443 }, resolve));
    removeClientFault = liteHttp.t_inject({ path: '/fault', status: 503 });
    removeServerFault = liteServer.t_inject({ path: '/', status: 502 });
    liteServer.t_unmock();
    await assert.rejects(f_send(), { code: 'ECONNREFUSED' }, '服务端卸载后不能访问旧路由');
    assert.equal((await f_send('/fault')).status, 503, '服务端卸载不能清客户端故障');
    liteServer.t_mock();
    const fresh = liteServer.createServer((_req, res) => res.end('new'));
    await new Promise(resolve => fresh.listen({ virtual: true, host: 'transport.test', port: 443 }, resolve));
    assert.equal((await f_send()).body.toString(), 'new', '重新装配应仅使用新 handler 且不残留服务端故障');
    assert.equal(oldHandled, 0, '卸载后不得执行旧 handler');
  } finally { removeServerFault?.(); removeClientFault?.(); liteServer.t_unmock(); liteHttp.t_unmock(); }
});
