// lite-http 门面用例（node:test 形态，可 `node --test` 或直跑）：默认转发真实 node:http；
// mock() 设置内存 http 实现、unmock() 移除——注入（inject）是内存实现上的能力：命中规则收到
// 错误响应（500 等），未命中按 ECONNREFUSED 拒连（模拟接口无法访问）；规则随 unmock 一并丢弃。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteHttp from '../lite-http.mjs';
import http from 'node:http';
import liteServer from '../lite-server.mjs';
// ---------- 原生 HTTP 对照夹具（自原独立文件 http-reference.mjs 迁入；lite-server 套件经本文件导出复用） ----------

/** 对照 handler：同一份请求/响应行为供客户端面、服务端面用例复用。 */
export function referenceHandler(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('X-Reference', 'retained');
    if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Set-Cookie': ['a=1', 'b=2'] });
      res.write(Buffer.from([0, 255, 128]));
      res.end(Buffer.from([65, 0]));
    } else if (req.url === '/empty') {
      res.writeHead(204);
      res.end('ignored');
    } else {
      res.writeHead(req.url.startsWith('/missing') ? 404 : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url,
        type: req.headers['content-type'] ?? null, probe: req.headers['x-probe'] ?? null,
        body: Buffer.concat(chunks).toString('hex'), header: res.getHeader('X-Reference') }));
    }
  });
}

/** 对照请求：同一客户端观测面（多形态重载/事件序/字节与请求头快照）。 */
export function requestSnapshot(client, port, { path = '/echo?q=%E4%B8%AD', method = 'POST', form = 'options', get = false, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const events = [], output = [];
    let deadline, snapshot;
    let buffers = true, writeBoolean = true;
    const options = { hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { 'X-Probe': 'forwarded', 'Content-Type': 'application/octet-stream' } };
    const callback = res => {
      events.push('callback');
      res.on('error', reject);
      res.on('data', chunk => { buffers &&= Buffer.isBuffer(chunk); output.push(Buffer.from(chunk)); });
      res.on('end', () => {
        events.push('end');
        snapshot = { status: res.statusCode, body: Buffer.concat(output).toString('hex'), buffers, writeBoolean, events,
          headers: Object.fromEntries(['content-type', 'x-reference', 'set-cookie'].filter(key => res.headers[key] !== undefined).map(key => [key, res.headers[key]])) };
      });
    };
    const send = get ? client.get.bind(client) : client.request.bind(client);
    const url = `http://127.0.0.1:${port}${path}`;
    const req = form === 'options' ? send(options, callback)
      : form === 'url-options' ? send(new URL(url), { method, headers: options.headers, agent: false }, callback)
      : send(form === 'url' ? new URL(url) : url, callback);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    deadline = setTimeout(() => { req.destroy(); reject(new Error('HTTP 对照请求超时')); }, 2000);
    req.on('response', () => events.push('response'));
    req.on('close', () => {
      if (snapshot) { clearTimeout(deadline); events.push('close'); resolve(snapshot); }
    });
    if (!get) {
      for (const chunk of chunks) { const returned = req.write(chunk); writeBoolean = writeBoolean && typeof returned === 'boolean'; }
      req.end();
    }
  });
}

/** 对照取消：destroy(error) 事件序与 destroyed 标记。 */
export function destroySnapshot(client, port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const deadline = setTimeout(() => reject(new Error('HTTP destroy 对照超时')), 2000);
    const req = client.request({ hostname: '127.00.0.1', port });
    req.on('response', () => events.push('response'));
    req.on('error', error => events.push({ event: 'error', message: error.message, code: error.code }));
    req.on('close', () => { clearTimeout(deadline); resolve({ events: [...events, 'close'], destroyed: req.destroyed }); });
    req.destroy(Object.assign(new Error('reference-stop'), { code: 'REFERENCE_STOP' }));
  });
}

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

/** 场景：相同 HTTP 请求分别由原生与内存客户端执行，核对请求/响应、字节和事件。 */
test('真实 HTTP 对照：request/get、URL 重载、请求头、二进制正文与取消事件', async () => {
  const scenario = async memory => {
    if (memory) { liteHttp.mock(); liteServer.mock(); }
    const server = (memory ? liteServer : http).createServer(referenceHandler);
    server.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const port = memory ? server.port : server.address().port;
    const client = memory ? liteHttp : http;
    try {
      // 输入：对象、URL、URL+options、get 重载以及文本和原始二进制请求体
      const responses = [];
      for (const options of [
        { chunks: ['中文', Buffer.from([0, 255, 128])] },
        { form: 'url-options', chunks: ['body'] },
        { form: 'url', method: 'GET' }, { form: 'string', get: true, method: 'GET' },
        { get: true, method: 'POST' }, { path: '/binary', method: 'GET' },
        { path: '/empty', method: 'GET' }, { path: '/echo', method: 'HEAD' },
        { path: '/missing', method: 'GET' },
      ]) responses.push(await requestSnapshot(client, port, options));
      responses.push(await destroySnapshot(client, port));
      return responses;
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (memory) { liteHttp.unmock(); liteServer.unmock(); }
    }
  };
  // 预期 1：应用层请求/响应字段、原始字节、回调顺序及 destroy(error) 事件与原生一致
  const expected = await scenario(false);
  assert.deepEqual(await scenario(true), expected, '内存 HTTP 客户端应与原生客户端的对应行为一致');
});

/** 场景：默认真实实现——未 mock 时走真实 node:http 的 connect 语义。 */
test('默认真实实现：未 mock 时无人监听端口按真实 ECONNREFUSED 拒连', async () => {
  // 输入：未 mock 状态下探活无人监听的 1 号端口
  const refused = await probe(1);
  // 预期 1：探活失败
  assert.equal(refused.ok, false, '无人监听端口应探活失败');
  // 预期 2：错误码来自真实 node:http 的 ECONNREFUSED
  assert.equal(refused.code, 'ECONNREFUSED', '错误应来自真实 node:http connect 语义');
});

/** 场景：传输层故障注入——命中规则的请求收到注入的错误响应。 */
test('注入 500：命中路径的探活收到 500 与错误正文', async () => {
  // 输入：mock 后对探活路径注入 500 故障
  liteHttp.mock();
  try {
    liteHttp.inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
    const broken = await probe(8888);
    // 预期 1：探活判失败
    assert.equal(broken.ok, false, '注入 500 应判探活失败');
    // 预期 2：状态码为注入的 500
    assert.equal(broken.status, 500, '状态码应为注入的 500');
    // 预期 3：错误正文来自注入规则
    assert.equal(JSON.parse(broken.body).error, '心跳接口不可达', '错误正文应来自注入规则');
  } finally {
    liteHttp.unmock();
  }
});

/** 场景：规则未命中——无规则路径按拒连模拟接口无法访问。 */
test('规则未命中：无规则路径按 ECONNREFUSED 拒连', async () => {
  // 输入：对 /api/health 注入规则后探活无规则的 /api/other
  liteHttp.mock();
  try {
    liteHttp.inject({ path: '/api/health', status: 500, error: '心跳接口不可达' });
    const missed = await probe(8888, '/api/other');
    // 预期 1：探活失败
    assert.equal(missed.ok, false, '未命中路径应探活失败');
    // 预期 2：按 ECONNREFUSED 拒连
    assert.equal(missed.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
  } finally {
    liteHttp.unmock();
  }
});

/** 场景：get 简写——http.get 形状与 request 同口径受注入规则约束。 */
test('get 简写：与 request 同口径命中注入 500', async () => {
  // 输入：注入 500 后经 liteHttp.get 发起请求
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
    // 预期 1：get 简写收到注入的 500
    assert.equal(result.status, 500, 'get 简写应同样收到注入的 500');
    // 预期 2：错误正文来自注入规则
    assert.equal(JSON.parse(result.body).error, '心跳接口不可达', '错误正文应来自注入规则');
  } finally {
    liteHttp.unmock();
  }
});

/** 场景：非法注入与前置约束——2xx 成功回包替换拒绝、未 mock 即注入拒绝。 */
test('非法注入与前置约束：2xx 拒绝、未 mock 即 inject 拒绝', async () => {
  // 输入：mock 后注入 200 成功回包
  liteHttp.mock();
  try {
    // 预期 1：拒绝（仅允许错误状态 400–599）
    assert.throws(() => liteHttp.inject({ path: '/api/health', status: 200, body: { ok: true } }), /400–599/, '不允许成功回包替换');
  } finally {
    liteHttp.unmock();
  }
  // 输入：未 mock 状态下注入 500
  // 预期 2：拒绝并提示先 mock
  assert.throws(() => liteHttp.inject({ path: '/api/health', status: 500 }), /先 mock/, '未设置内存实现时注入应拒绝');
});

/** 场景：移除函数——注入返回的移除函数撤规则后回到拒连，且幂等。 */
test('移除函数：撤规则后回到拒连、重复调用幂等', async () => {
  // 输入：注入 500 后调用返回的移除函数（两次验证幂等）
  liteHttp.mock();
  try {
    const remove = liteHttp.inject({ path: '/api/health', status: 500 });
    // 预期 1：移除前规则生效（500）
    assert.equal((await probe(8888)).status, 500, '移除前规则应生效');
    remove();
    remove(); // 幂等
    const refused = await probe(8888);
    // 预期 2：移除后不再命中规则
    assert.equal(refused.ok, false, '移除后应不再命中规则');
    // 预期 3：回到 ECONNREFUSED 拒连
    assert.equal(refused.code, 'ECONNREFUSED', '未命中应按拒连模拟无法访问');
  } finally {
    liteHttp.unmock();
  }
});

/** 场景：幂等与恢复——重复 mock 复用既有规则，unmock 回真实 node:http。 */
test('幂等与恢复：重复 mock 保留规则、unmock 回真实实现', async () => {
  // 输入：注入规则后重复 mock（幂等）、再 unmock 探活
  liteHttp.mock();
  liteHttp.inject({ path: '/api/health', status: 500 });
  liteHttp.mock(); // 幂等：复用当前内存实现，不丢规则
  // 预期 1：重复 mock 不丢弃已注入规则
  assert.equal((await probe(8888)).status, 500, '重复 mock 不应丢弃已注入规则');
  // 输入：unmock 后探活无人监听端口
  liteHttp.unmock();
  const refused = await probe(1);
  // 预期 2：回到真实 node:http connect 语义
  assert.equal(refused.code, 'ECONNREFUSED', 'unmock 后应回到真实 node:http connect 语义');
});

/** URL 注入请求夹具：公开 request 接口，超时销毁请求以保证失败用例能收尾。 */
export function _urlInjectionRequest(client, options) {
  return new Promise((resolve, reject) => {
    const req = client.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, body }); });
      res.on('error', error => { clearTimeout(deadline); reject(error); });
    });
    const deadline = setTimeout(() => req.destroy(new Error('URL 注入请求超时')), 2000);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    req.end();
  });
}

/** 场景：URL 定向传输故障，来源、端口、完整查询串与方法分别隔离，未命中不消耗 once。 */
test('URL 注入：绝对地址、路径、查询顺序、方法与 once 隔离', async () => {
  liteHttp.mock();
  liteServer.mock();
  let handled = 0;
  const server = liteServer.createServer((req, res) => { handled++; res.end('handler'); }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://localhost:${server.port}`;
    const send = (path, extra = {}) => _urlInjectionRequest(liteHttp, { hostname: 'localhost', port: server.port, path, ...extra });
    // 输入：规范化主机名和 fragment 的绝对 URL，同时限定 POST、旧 path/query 条件与 once
    liteHttp.inject({ url: new URL(`${base.toUpperCase()}/same?a=1&b=2#ignored`), method: 'POST', path: '/same', query: { a: 1 }, status: 503, once: true });
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
    const remove = liteHttp.inject({ url: '/same?x=1&x=2#ignored', status: 502 });
    // 预期 3：路径规则不限定来源，但严格比较完整查询串
    assert.equal((await send('/same?x=1&x=2', { hostname: 'other.test' })).status, 502, '路径 URL 应跨来源命中');
    assert.equal((await send('/same?x=2&x=1')).status, 200, '重复查询参数顺序不同不能命中');
    assert.equal((await send('/same?x=1&x=2', { method: 'POST' })).status, 502, '未限定 method 时各方法均可命中 URL');
    remove(); remove();
    assert.equal((await send('/same?x=1&x=2')).status, 200, '移除 URL 规则应幂等恢复');
    // 输入：省略默认端口的 URL 规则，使用显式 80 端口与 fragment 的 URL 请求
    liteHttp.inject({ url: 'http://EXAMPLE.test/default', status: 504 });
    // 预期 4：默认端口和主机名规范化，fragment 不参与匹配
    assert.equal((await _urlInjectionRequest(liteHttp, new URL('http://example.test:80/default#ignored'))).status, 504, '默认端口、主机大小写和 fragment 应规范化');
    liteHttp.inject({ url: new URL('https://example.test/default'), status: 504 });
    assert.equal((await _urlInjectionRequest(liteHttp, new URL('https://example.test:443/default'))).status, 504, 'HTTPS URL 对象应使用默认 443 端口匹配');
    assert.equal((await _urlInjectionRequest(liteHttp, 'https://example.test/default')).status, 504, 'HTTPS 字符串应与 URL 对象保持一致');
    // 预期 5：非法 URL 在登记时拒绝，不留给请求阶段报错
    for (const url of ['', 'relative', '//example.test/same', 'ftp://example.test/same', 1, {}])
      assert.throws(() => liteHttp.inject({ url, status: 503 }), /url/, '非法 URL 应在注入时拒绝');
  } finally { liteHttp.unmock(); liteServer.unmock(); }
});
