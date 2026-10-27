// 独立示例应用：真实页面与真实路由供适配器合同和浏览器集成验证。
import http from 'node:http';
import fs from 'node:fs';
let posts = 0;
http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://example.test');
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync('/site/index.html'));
    return;
  }
  if (url.pathname === '/text') {
    response.setHeader('content-type', 'text/plain');
    response.end(`text:${url.searchParams.get('q')}`);
    return;
  }
  let body = '';
  await new Promise((resolve, reject) => {
    request.on('data', chunk => { body += chunk; });
    request.on('end', resolve);
    request.on('error', reject);
  });
  if (request.method === 'POST') posts += 1;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ posts, method: request.method, body }));
}).listen(8888, '127.0.0.1');
