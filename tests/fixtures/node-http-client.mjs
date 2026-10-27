// 世界内 Node http 客户端探针：回调式 http.request/get 打 127.0.0.1——验证进程内 loopback
// 通道（同端口经内存路由真实服务、故障注入同口径生效、端口不符按 ECONNREFUSED 拒连、
// 非 loopback 地址按未声明调用记账）。探针形状对齐真实 CLI 的守护进程探活（probeHealth）。
import http from 'node:http';

export function probe(port, path = '/counter') {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', timeout: 1500 },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
      }
    );
    req.on('error', error => resolve({ ok: false, code: error.code }));
    req.end();
  });
}

export function getProbe(port) {
  return new Promise(resolve => {
    http.get({ hostname: '127.0.0.1', port, path: '/counter' }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: data }));
    }).on('error', error => resolve({ ok: false, code: error.code }));
  });
}

export function external() {
  return new Promise(resolve => {
    try {
      const req = http.request({ hostname: 'api.example.com', path: '/', method: 'GET' }, () => resolve('unexpected'));
      req.on('error', error => resolve(error.message));
      req.end();
    } catch (error) {
      resolve(error.message);
    }
  });
}
