import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';
import liteBrowser from '../lite-browser.mjs';

test('lite-browser：共享单例页经内存通道取回包，home 复位起点', async () => {
  liteHttp.mock();
  liteServer.mock();
  const server = liteServer.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><title>壳</title><body><h1>首页</h1></body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知接口' }));
  });
  server.listen(28888);
  const first = await liteBrowser.open({ port: 28888 });
  const again = await liteBrowser.open({ port: 28888 });
  assert.equal(again, first, 'open 幂等：重复调用复用同一共享实例');
  await liteBrowser.home();
  assert.equal(await liteBrowser.page().title(), '壳', '页面标题应来自内存路由回包');
  assert.equal(await liteBrowser.page().locator('h1').textContent(), '首页', 'DOM 断言应命中内存路由的 HTML');
  await liteBrowser.close();
  assert.throws(() => liteBrowser.page(), /需先 open/, 'close 后单例清空');
});
