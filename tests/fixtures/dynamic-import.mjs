// 主世界动态导入探针：top-level await import() 在 VM 主入口（非子进程世界）也应走模块替身
// ——node:os 动态导入拿到 mock（homedir 固定落点），相对模块动态导入走同一加载边界。
import http from 'node:http';

export const loaded = {};
loaded.os = await import('node:os');
loaded.client = await import('./storage-client.mjs');

http.createServer((_req, res) => {
  res.end('ok');
}).listen(8888, '127.0.0.1');
loaded.events = await import('node:events');
