// lite-server 门面用例（node:test 形态，可 `node --test` 或直跑）：服务端面（createServer）
// 独立门面——mock() 登记内存服务，listen 真实绑定 127.0.0.1（显式端口即绑该口，缺省动态
// 空闲口）：浏览器等真实客户端经真实 loopback socket 到达 socket 前端，前端把请求回灌进程内
// 管线（liteHttp.request 传输层故障 → handle() 服务端故障 → 真实 handler），回包写回真实
// socket；进程内直调 liteHttp.request 仍走 handle() 内存路由（不经 socket）。inject 注入服务端
// 故障（handler 已执行，回包被 wait 闸门挂起或按 status 错误回包替换）——与 lite-http.inject
//（请求未达服务端即被传输层拦截）分层归属。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';
import { referenceHandler, requestSnapshot } from './lite-http.test.mjs'; // 对照夹具迁至 lite-http.test.mjs（http-reference.mjs 已删）

function get(port, path) {
  return new Promise((resolve) => {
    liteHttp.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, faulted: res.faulted === true }));
    }).on('error', (error) => resolve({ code: error.code })).end();
  });
}

// 真实 socket 客户端：浏览器等真实流量的最小替身——真 TCP 到达 socket 前端
function realGet(port, path, { destroyAfter = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (destroyAfter > 0) setTimeout(() => req.destroy(), destroyAfter);
  });
}

function realPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withBoard(handler, run) {
  liteHttp.mock();
  liteServer.mock();
  const server = liteServer.createServer(handler).listen(0);
  await new Promise((resolve) => server.once('listening', resolve)); // 真实绑定异步：就绪后才取实际端口
  try {
    return await run(server.port);
  } finally {
    liteHttp.unmock();
    liteServer.unmock();
  }
}

const boardHandler = (req, res) => {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** 场景：原生客户端访问相同 handler，核对原生与内存服务的响应及监听/关闭生命周期。 */
test('真实 Server 对照：监听地址、回调、响应头、字节与关闭事件', async () => {
  const scenario = async memory => {
    if (memory) { liteHttp.mock(); liteServer.mock(); }
    const events = [];
    const server = (memory ? liteServer : http).createServer(referenceHandler);
    const before = { listening: server.listening, address: server.address() };
    server.on('listening', () => events.push('listening'));
    const listening = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    // 输入：使用 listen(port, callback) 重载，经真实回环 socket 请求同一 handler
    server.listen(0, () => events.push('listen-callback'));
    await listening;
    const address = server.address();
    const responses = [];
    try {
      for (const options of [{ chunks: ['中', Buffer.from([0, 255])] }, { path: '/binary', method: 'GET' },
        { path: '/empty', method: 'GET' }, { path: '/echo', method: 'HEAD' }, { path: '/missing', method: 'GET' }])
        responses.push(await requestSnapshot(http, address.port, options));
      const during = { listening: server.listening, portValid: address.port > 0 };
      server.on('close', () => events.push('close'));
      await new Promise(resolve => server.close(() => { events.push('close-callback'); resolve(); }));
      return { before, during, after: { listening: server.listening, address: server.address() }, events, responses };
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (memory) { liteHttp.unmock(); liteServer.unmock(); }
    }
  };
  const expected = await scenario(false);
  // 预期 1：仅动态端口、自动 Date/连接头不参与比较，服务生命周期与应用回包完整对齐
  assert.deepEqual(await scenario(true), expected, '内存 Server 应与原生 Server 的对应行为一致');
});

/** 场景：内存路由基本面——登记 handler 后 loopback 请求回包来自真实路由代码。 */
test('内存路由基本面：loopback GET 回包来自真实 handler', async () => {
  // 输入：登记带执行标记的 handler，经内存客户端 GET /api/echo?a=1
  let handlerRan = false;
  const out = await withBoard(
    (req, res) => {
      handlerRan = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    },
    (port) => get(port, '/api/echo?a=1'),
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
test('无监听服务：未登记服务/端口不符按 ECONNREFUSED 拒连', async () => {
  // 输入：mock 两门面但不 createServer，探活默认端口
  liteHttp.mock();
  liteServer.mock();
  try {
    const refused = await get(8888, '/api/health');
    // 预期 1：未登记服务按拒连
    assert.equal(refused.code, 'ECONNREFUSED', '未登记服务应按拒连');
    // 输入：探活另一个端口
    const wrongPort = await get(9999, '/api/health');
    // 预期 2：端口不符按拒连
    assert.equal(wrongPort.code, 'ECONNREFUSED', '端口不符应按拒连');
  } finally {
    liteHttp.unmock();
    liteServer.unmock();
  }
});

/** 场景：服务端故障替换回包——handler 已执行，注入 503 替换真实回包。 */
test('服务端故障：注入 503 替换回包、handler 已执行、回包带故障标记', async () => {
  // 输入：登记带执行标记的 handler，注入 503 服务端故障后请求
  let handlerRan = false;
  const out = await withBoard(
    (req, res) => {
      handlerRan = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    async (port) => {
      liteServer.inject({ path: '/api/health', status: 503, body: { error: '服务暂不可用' } });
      return get(port, '/api/health');
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
test('wait 闸门：放行前无回包、放行后真实回包不带故障标记', async () => {
  // 输入：注入 wait 闸门的服务端故障，200ms 内观察是否有回包
  const gate = Promise.withResolvers();
  const pending = await withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    async (port) => {
      liteServer.inject({ path: '/api/slow', wait: gate.promise });
      const req = get(port, '/api/slow');
      return Promise.race([req, new Promise((r) => setTimeout(() => r({ held: true }), 200))]);
    },
  );
  // 预期 1：闸门放行前无回包
  assert.equal(pending.held, true, '闸门放行前不应有回包');
  // 输入：释放闸门后重新注入并立即放行
  gate.resolve();
  const out = await withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    (port) => {
      const g = Promise.withResolvers();
      const req = get(port, '/api/slow');
      liteServer.inject({ path: '/api/slow', wait: g.promise });
      g.resolve();
      return req;
    },
  );
  // 预期 2：放行后收到真实 handler 的 200
  assert.equal(out.status, 200, '放行后应收到真实 handler 回包');
  // 预期 3：真实回包不带故障标记
  assert.equal(out.faulted, false, '真实回包不带故障标记');
});

/** 场景：once 自毁与非法注入——once 只拦一次，2xx/phase 字段与未 mock 注入均拒绝。 */
test('once 自毁与注入校验：只拦一次、2xx/phase/未 mock 注入拒绝', async () => {
  // 输入：注入 once 503 后连续两次请求
  const out = await withBoard(
    (req, res) => res.end(JSON.stringify({ ok: true })),
    async (port) => {
      liteServer.inject({ path: '/api/once', status: 503, once: true });
      const first = await get(port, '/api/once');
      const second = await get(port, '/api/once');
      // 输入：注入 200 成功回包
      // 预期 1：2xx 成功回包替换拒绝
      assert.throws(() => liteServer.inject({ path: '/x', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
      // 输入：带 phase 字段注入
      // 预期 2：phase 字段拒绝（阶段已由注入入口本身表达）
      assert.throws(() => liteServer.inject({ path: '/x', status: 503, phase: 'response' }), /不支持字段/, '阶段字段已由注入入口本身表达');
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
  assert.throws(() => liteServer.inject({ status: 503 }), /先 mock/, '未设置内存实现时注入应拒绝');
});

/** 场景：真实 socket 回灌管线与观测账本——真 TCP 流量回包来自真实 handler，账本按契约记录。 */
test('socket 前端：真 TCP GET/POST 回灌管线、账本契约、缓存头区分', async () => {
  // 输入：真 socket 客户端 GET API / GET 静态 / POST API，随后读账本并 resetRequests
  const out = await withBoard(boardHandler, async (port) => {
    const api = await realGet(port, '/api/echo?a=1');
    const asset = await realGet(port, '/style.css');
    const post = await realPost(port, '/api/echo', '载荷');
    // 账本断言须在 run 内完成：withBoard 收尾 unmock 后账本随实例丢弃
    const recs = liteServer.requests().filter((r) => r.path === '/api/echo' || r.path === '/style.css');
    const live = liteServer.liveRequests();
    const liveLen = live.length;
    liteServer.resetRequests(); // 原地清空不换引用（须在 run 内：unmock 后为 no-op）
    return { api, asset, post, port, recs, liveLen, liveCleared: live.length };
  });
  // 预期 1：真实 socket 请求应答真实 handler 的 200
  assert.equal(out.api.status, 200, '真实 socket 请求应答真实 handler 的 200');
  // 预期 2：GET 回包内容来自真实路由代码
  assert.deepEqual(JSON.parse(out.api.body), { ok: true, url: '/api/echo?a=1', echo: null }, 'GET 回包内容应来自真实路由代码');
  // 预期 3：/api/ 保持服务端 no-store
  assert.equal(out.api.headers['cache-control'], 'no-store', '/api/ 保持服务端 no-store（故障与轮询依赖新鲜回包）');
  // 预期 4：非 /api/ 静态资源覆盖为可缓存
  assert.equal(out.asset.headers['cache-control'], 'public, max-age=3600', '非 /api/ 静态资源应覆盖为可缓存');
  // 预期 5：POST 请求体经回灌管线到达 handler
  assert.equal(JSON.parse(out.post.body).echo, '载荷', 'POST 请求体应经回灌管线到达 handler');
  // 预期 6：content-length 按回写字节重算
  assert.equal(Number(out.post.headers['content-length']), Buffer.byteLength(out.post.body), 'content-length 应按回写字节重算');
  const recs = out.recs;
  // 预期 7：账本记录全部到达请求
  assert.equal(recs.length, 3, 'socket 前端账本应记录全部到达请求');
  const [api, asset, post] = recs;
  // 预期 8：账本契约（path 不含查询串、query 单列、body 为请求体文本）
  assert.deepEqual(
    [api.method, api.path, api.query, api.body, asset.query, post.body],
    ['GET', '/api/echo', '?a=1', null, '', '载荷'],
    '账本契约：path 不含查询串（query 单列）、body 为请求体文本',
  );
  // 预期 9：完成请求回填 status
  assert.equal(api.status, 200, '完成请求回填 status');
  // 预期 10：response 带解析后的 JSON 回包
  assert.equal(api.response.json.ok, true, 'response 应带解析后的 JSON 回包');
  // 预期 11：真实路由产物同引 serverResponse
  assert.equal(api.serverResponse, api.response, '真实路由产物应同引 serverResponse');
  // 预期 12：活账本与快照同源
  assert.equal(out.liveLen, 3, '活账本与快照同源');
  // 预期 13：resetRequests 原地清空不换引用
  assert.equal(out.liveCleared, 0, 'resetRequests 原地清空不换引用');
});

/** 场景：故障对 socket 流量生效——传输层 503 与服务端 wait 闸门对真 TCP 客户端同样生效。 */
test('socket 故障：传输层 503/服务端闸门对真 socket 生效、账本 serverResponse 区分', async () => {
  // 输入：注入传输层 503（once）后真 socket 两次请求；再注入服务端 wait 闸门，观察早退与放行
  const out = await withBoard(boardHandler, async (port) => {
    liteHttp.inject({ method: 'GET', path: '/api/echo', status: 503, body: { error: '传输不可用' }, once: true });
    const faulted = await realGet(port, '/api/echo');
    const recovered = await realGet(port, '/api/echo');
    const gate = Promise.withResolvers();
    liteServer.inject({ method: 'GET', path: '/style.css', wait: gate.promise });
    const held = realGet(port, '/style.css');
    const early = await Promise.race([held, sleep(200).then(() => ({ held: true }))]);
    gate.resolve();
    const released = await held;
    const recs = liteServer.requests();
    return { faulted, recovered, early, released, recs };
  });
  // 预期 1：传输层故障替换真 socket 回包
  assert.equal(out.faulted.status, 503, '传输层故障应替换真 socket 回包');
  // 预期 2：错误正文来自注入规则
  assert.equal(JSON.parse(out.faulted.body).error, '传输不可用', '错误正文应来自注入规则');
  // 预期 3：once 自毁后回到真实回包
  assert.equal(out.recovered.status, 200, 'once 自毁后回到真实回包');
  // 预期 4：闸门放行前真 socket 无回包
  assert.equal(out.early.held, true, 'wait 闸门放行前真 socket 不应有回包');
  // 预期 5：放行后回包送达真实 socket
  assert.equal(out.released.status, 200, '放行后回包送达真实 socket');
  const recs = out.recs;
  const faultRec = recs.find((r) => r.path === '/api/echo' && r.status === 503);
  const gateRec = recs.find((r) => r.path === '/style.css');
  // 预期 6：故障回包入账
  assert.ok(faultRec, '故障回包应入账');
  // 预期 7：账本 response 为最终送达回包
  assert.equal(faultRec.response.json.error, '传输不可用', '账本 response 为最终送达回包');
  // 预期 8：故障替换时账本缺 serverResponse（仅真实路由产物）
  assert.equal(faultRec.serverResponse, undefined, '故障替换时账本缺 serverResponse（仅真实路由产物）');
  // 预期 9：闸门请求入账
  assert.ok(gateRec, '闸门请求应入账');
  // 预期 10：闸门放行后账本回填
  assert.equal(gateRec.status, 200, '闸门放行后账本回填');
  // 预期 11：真实回包账本补 serverResponse
  assert.equal(gateRec.serverResponse, gateRec.response, '真实回包账本补 serverResponse');
});

/** 场景：socket 中断联动取消——闸门挂起期间客户端弃连，放行后不投递、账本停在 status 0。 */
test('socket 中断：弃连联动取消投递、账本停在 status 0、服务继续可用', async () => {
  // 输入：闸门挂起期间真 socket 客户端 50ms 后弃连，放行闸门再发起后续请求
  const out = await withBoard(boardHandler, async (port) => {
    const gate = Promise.withResolvers();
    liteServer.inject({ method: 'GET', path: '/api/echo', wait: gate.promise });
    const dropping = realGet(port, '/api/echo', { destroyAfter: 50 }).catch((error) => ({ code: error.code }));
    await sleep(150); // 等弃连传播到前端（res close → done → destroy 内存请求）
    const dropped = await dropping;
    gate.resolve();
    await sleep(50); // 放行后无投递（isAborted 短路）
    const after = await realGet(port, '/style.css');
    const rec = liteServer.requests().find((r) => r.path === '/api/echo');
    return { dropped, after, rec };
  });
  // 预期 1：弃连客户端见到连接错误而非回包
  assert.ok(out.dropped.code !== undefined, '弃连客户端应见连接错误而非回包');
  // 预期 2：中断后服务继续可用
  assert.equal(out.after.status, 200, '中断后服务应继续可用');
  const rec = out.rec;
  // 预期 3：中断请求在账本
  assert.ok(rec, '中断请求应在账本');
  // 预期 4：中断请求账本停在 status 0（对齐旧 route.abort 观测）
  assert.equal(rec.status, 0, '中断请求账本停在 status 0（对齐旧 route.abort 观测）');
  // 预期 5：中断请求不回填 response
  assert.equal(rec.response, undefined, '中断请求不回填 response');
});

/** 场景：闸门失败按管线异常收场——wait promise 拒绝时连接拆除、账本停在 status 0。 */
test('闸门失败：wait 拒绝按请求错误收场、连接拆除、账本不回填', async () => {
  // 输入：注入 wait 已拒绝的闸门后真 socket 请求
  const out = await withBoard(boardHandler, async (port) => {
    const boom = Promise.reject(new Error('闸门崩溃'));
    boom.catch(() => {}); // 预挂兜底：注入期无请求消费不触发 unhandledRejection，真实 await 仍按拒绝传播
    liteServer.inject({ method: 'GET', path: '/api/echo', wait: boom });
    const failed = await realGet(port, '/api/echo').catch((error) => ({ code: error.code }));
    const rec = liteServer.requests().find((r) => r.path === '/api/echo');
    return { failed, rec };
  });
  // 预期 1：闸门失败按请求错误收场（连接拆除）
  assert.ok(out.failed.code !== undefined, '闸门失败应按请求错误收场（连接拆除）');
  // 预期 2：管线异常账本停在 status 0
  assert.equal(out.rec.status, 0, '管线异常账本停在 status 0');
  // 预期 3：管线异常不回填 response
  assert.equal(out.rec.response, undefined, '管线异常不回填 response');
});

/** 场景：防误用守卫——lite-server mock 但 lite-http 未 mock 时 socket 前端明确报错，不外联。 */
test('防误用守卫：lite-http 未 mock 时 socket 前端 500 明确报错、无真实外联', async () => {
  // 输入：仅 mock lite-server 并监听（lite-http 全程未 mock），真 socket 请求
  liteServer.mock();
  const server = liteServer.createServer(boardHandler).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const refused = await realGet(server.port, '/api/echo');
    // 预期 1：收到 500 明确报错
    assert.equal(refused.status, 500, '未 mock lite-http 时 socket 前端应明确报错');
    // 预期 2：报错指引先 liteHttp.mock()
    assert.match(refused.body, /liteHttp\.mock/, '报错应指引先 liteHttp.mock()');
  } finally {
    liteServer.unmock();
  }
  // 预期 3：本用例全程 lite-http 未 mock
  assert.equal(liteHttp.isMocked(), false, '本用例全程 lite-http 未 mock');
});

/** 场景：端口策略与关停——动态口/显式口绑定、unmock 真实关停拒连、未 mock 门面空态。 */
test('端口策略与关停：动态/显式口、unmock 关停拒连、未 mock 空态', async () => {
  // 输入：未 mock 时查询端口与账本
  // 预期 1：无绑定端口（null）
  assert.equal(liteServer.port(), null, '未 mock 时无绑定端口');
  // 预期 2：账本为空集
  assert.deepEqual(liteServer.requests(), [], '未 mock 时账本为空集');
  // 输入：第一段会话——缺省 listen 动态空闲口
  liteHttp.mock();
  liteServer.mock();
  const dynamic = liteServer.createServer(boardHandler);
  dynamic.listen(); // 缺省：动态空闲口
  await new Promise((resolve) => dynamic.once('listening', resolve));
  // 预期 3：动态口为非 0 的实际绑定值
  assert.ok(Number.isInteger(liteServer.port()) && liteServer.port() > 0, '缺省 listen 应绑动态空闲口（非 0）');
  // 输入：真 socket 请求动态口
  const dynamicHit = await realGet(liteServer.port(), '/style.css');
  // 预期 4：动态口真实可达
  assert.equal(dynamicHit.status, 200, '动态口真实可达');
  liteServer.unmock();
  liteHttp.unmock();
  // 输入：第二段会话——显式端口绑定
  const explicit = await freePort();
  liteHttp.mock();
  liteServer.mock();
  const pinned = liteServer.createServer(boardHandler).listen(explicit);
  await new Promise((resolve) => pinned.once('listening', resolve));
  // 预期 5：显式端口绑定该口
  assert.equal(pinned.port, explicit, '显式端口应绑定该口');
  // 预期 6：门面暴露实际绑定端口
  assert.equal(liteServer.port(), explicit, '门面应暴露实际绑定端口');
  // 输入：真 socket 请求显式口
  const hit = await realGet(explicit, '/style.css');
  // 预期 7：显式口真实可达
  assert.equal(hit.status, 200, '显式口真实可达');
  // 输入：unmock 真实关停 socket，轮询直到拒连
  liteServer.unmock(); // 真实关停 socket（关停为异步收尾：拆中的监听口短暂 RST，终态拒连）
  let refused = null;
  for (let i = 0; i < 20; i++) {
    refused = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: explicit, path: '/' }, () => resolve({ connected: true }));
      req.on('error', (error) => resolve({ code: error.code }));
    });
    if (refused.code === 'ECONNREFUSED') break;
    await sleep(50);
  }
  // 预期 8：unmock 后真实 socket 关停拒连
  assert.equal(refused.code, 'ECONNREFUSED', 'unmock 后真实 socket 应关停拒连');
  liteHttp.unmock();
});

/** 场景：未 listen 即 close——无 socket 可关时回调即时送达。 */
test('未 listen 即 close：回调即时送达', async () => {
  // 输入：mock 后 createServer 不 listen 直接 close
  liteHttp.mock();
  liteServer.mock();
  try {
    const server = liteServer.createServer(boardHandler);
    const closed = await new Promise((resolve) => server.close(() => resolve(true)));
    // 预期 1：close 回调即时送达
    assert.equal(closed, true, '未 listen 的 close 回调应即时送达');
  } finally {
    liteServer.unmock();
    liteHttp.unmock();
  }
});
