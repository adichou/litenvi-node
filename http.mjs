// 跨项目假 HTTP 传输层：服务端不绑定真实端口（createServer 只收 handler，listen / close
// 全内存模拟），客户端 request() 直接把内存 req/res 流喂给服务端 handler——零真实 socket。
// 记账（deny）由调用方注入：未实现的 http.request / get 与重复 createServer 都按未声明
// 调用失败并记录。
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

const BASE = 'http://mock-environment.local';

export function createHttpTransport({ deny }) {
  const requests = []; // append-only 请求流水账：只有 push，没有修改与删除
  let server = null;
  let disposed = false;

  // 注入 VM 的 'node:http' 替身。
  const httpMock = {
    request: deny('http.request'), get: deny('http.get'),
    createServer(handler) {
      if (server) return deny('额外 HTTP 服务')();
      server = Object.assign(new EventEmitter(), {
        listening: false,
        handler(req, res) {
          requests.push({ method: req.method, path: new URL(req.url, BASE).pathname });
          handler(req, res);
        },
        listen(_port, _host, ready) {
          this.listening = true;
          if (ready) queueMicrotask(ready);
          queueMicrotask(() => this.emit('listening'));
          return this;
        },
        close(cb) {
          if (!this.listening) {
            const error = Object.assign(new Error('ERR_SERVER_NOT_RUNNING'), { code: 'ERR_SERVER_NOT_RUNNING' });
            if (cb) queueMicrotask(() => cb(error));
            return this;
          }
          this.listening = false;
          if (cb) queueMicrotask(() => cb(null));
          queueMicrotask(() => this.emit('close'));
          return this;
        },
      });
      return server;
    },
  };

  // 假 req：Duplex 充当服务端读取侧；body（JSON 文本）与 EOF 在下一微任务推入，
  // 模拟真实网络中请求体异步到达，且保证服务端先挂好 data/end 监听。
  function fakeRequest({ method, url, headers, body }) {
    const req = new Duplex({ read() {} });
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1', remotePort: 0 };
    queueMicrotask(() => {
      if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
      req.push(null);
    });
    return req;
  }

  // 假 res：服务端 write/end 的内容转发到读取侧，客户端按 data/end 消费。
  function fakeResponse() {
    const res = new Duplex({
      read() {},
      write(chunk, _enc, cb) { res.push(chunk); cb(); },
      final(cb) { res.push(null); cb(); },
    });
    res.statusCode = 200;
    res.headers = {};
    res.writeHead = (code, extra) => { res.statusCode = code; Object.assign(res.headers, extra || {}); return res; };
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    return res;
  }

  // 用例侧请求入口：直调服务端 handler，返回 { status, json, headers, text }。
  // JSON 响应解析为 json；非 JSON 的非空响应（流式/二进制端点的正常形态）原样带回 text，
  // json 为 null；空响应按环境故障拒绝。
  function request(method, pathname, body) {
    if (disposed) throw new Error('Mock 环境已释放');
    // 项目专属的公共查询参数（如 ATB 的 project）由项目 utils 层拼进 pathname，这里保持通用。
    const url = new URL(pathname, BASE);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => req.destroy(new Error('Mock 环境请求超时')), 5000);
      const settle = (fn, value) => { clearTimeout(timer); fn(value); };
      // 真实 http.request 会自动补 Host 头；依赖回环 Host 的服务端守卫需要它放行，假传输层显式提供。
      const headers = { host: '127.0.0.1' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const req = fakeRequest({ method, url: `${url.pathname}${url.search}`, headers, body });
      const res = fakeResponse();
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', (error) => settle(reject, error));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON：流式/二进制端点 */ }
        if (parsed === null && text.trim() === '') {
          settle(reject, new Error('接口未返回 JSON：（空响应）'));
          return;
        }
        settle(resolve, {
          status: res.statusCode,
          json: parsed,
          headers: res.headers,
          text: parsed === null ? text : undefined,
        });
      });
      req.on('error', (error) => settle(reject, error));
      try { server.handler(req, res); }
      catch (error) { settle(reject, error); }
    });
  }

  return {
    httpMock,
    request,
    requests,
    isListening: () => !!server?.listening,
    waitForListening() {
      if (this.isListening()) return Promise.resolve();
      return new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    },
    async close() {
      disposed = true;
      if (server?.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      server?.removeAllListeners();
    },
  };
}
