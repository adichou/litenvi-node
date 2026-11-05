// lite-browser 用例（node:test 形态，可 `node --test` 或直跑）：纯浏览器承载——共享单例无头页，
// 浏览器经 lite-server 真实 loopback socket 访问内存服务（socket 前端回灌进程内管线，回包即
// 真实 handler 产物）；lite-browser 不再感知服务端口，导航由调用方 page.goto 到实际绑定端口。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { nativeReferenceEnv } from './native-reference-env.mjs';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';
import liteBrowser from '../lite-browser.mjs';

/** 场景：软链接依赖拥有独立 Playwright 安装时，浏览器模块不重复初始化调用方的测试框架。 */
test('独立安装：调用方已加载 @playwright/test 后仍可导入 lite-browser', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lite-browser-consumer-'));
  const require = createRequire(import.meta.url);
  try {
    for (const name of ['@playwright/test', 'playwright']) {
      const destination = path.join(root, 'node_modules', name);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.dirname(require.resolve(`${name}/package.json`)), destination, { recursive: true });
    }
    symlinkSync(path.dirname(require.resolve('playwright-core/package.json')), path.join(root, 'node_modules/playwright-core'), 'dir');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(path.join(root, 'consumer.cjs'))});
      const { expect } = require('@playwright/test');
      const initiator = process.__pw_initiator__;
      const { default: browser } = await import(${JSON.stringify(new URL('../lite-browser.mjs', import.meta.url).href)});
      expect(typeof browser.open).toBe('function');
      assert.equal(process.__pw_initiator__, initiator, '浏览器模块不能再次初始化测试框架');
    `], { encoding: 'utf8', env: nativeReferenceEnv(), timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `双份安装时导入应成功：${result.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** 场景：共享单例页——open 幂等复用、页面经真实 socket 取回包、观测账本入账、close 清空单例。 */
test('共享单例页：open 幂等、真实 socket 回包、账本入账、close 清空', async () => {
  // 输入：mock 两门面并登记页面壳 handler（/ 回 HTML、其余 404）
  liteHttp.t_mock();
  liteServer.t_mock();
  const server = liteServer.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><title>壳</title><body><h1>首页</h1></body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知接口' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // 绑定是异步的：实际端口在 listening 后才可用
  // 输入：首次 open 后再次 open（幂等口径）
  const origin = `http://127.0.0.1:${server.port}`; // 动态空闲口：实际绑定端口从 server.port / liteServer.t_port() 取
  const first = await liteBrowser.open({ locale: 'zh-CN' });
  const again = await liteBrowser.open({});
  // 预期 1：重复 open 复用同一共享实例
  assert.equal(again, first, 'open 幂等：重复调用复用同一共享实例');
  // 输入：共享页导航到实际绑定端口（调用方自行导航）
  const page = liteBrowser.page();
  await page.goto(origin);
  // 预期 2：页面标题来自真实 socket 回包
  assert.equal(await page.title(), '壳', '页面标题应来自真实 socket 回包');
  // 预期 3：DOM 断言命中真实路由 HTML
  assert.equal(await page.locator('h1').textContent(), '首页', 'DOM 断言应命中真实路由 HTML');
  // 预期 4：open 的 locale 透传 context（navigator.language 反映 zh-CN）
  assert.ok((await page.evaluate(() => navigator.language)).startsWith('zh'), 'locale 应透传到 context');
  // 输入：读取 lite-server 观测账本中的导航请求
  const hits = liteServer.t_requests().filter((r) => r.path === '/');
  // 预期 5：导航请求经 socket 前端入账恰一次
  assert.equal(hits.length, 1, '导航请求应经 socket 前端入账');
  // 预期 6：method 为 GET
  assert.equal(hits[0].method, 'GET', '导航请求 method 应为 GET');
  // 预期 7：status 回填 200
  assert.equal(hits[0].status, 200, '导航请求 status 应回填 200');
  // 预期 8：真实回包账本补 serverResponse
  assert.equal(hits[0].serverResponse, hits[0].response, '真实回包账本补 serverResponse');
  // 输入：close 关停共享实例后再取页
  await liteBrowser.close();
  // 预期 9：close 后单例清空（取页拒绝）
  assert.throws(() => liteBrowser.page(), /需先 open/, 'close 后单例清空');
  liteServer.t_unmock(); // 真实关停 socket：测试进程须自然退出
  liteHttp.t_unmock();
});

/** 场景：共享上下文——context() 返回 open 建立的同一上下文，弹层（target=_blank）经它捕获。 */
test('共享上下文：context() 同实例、弹层经 waitForEvent("page") 捕获并取回包', async () => {
  // 输入：登记含 target=_blank 链接的页面与弹层页 handler，open 后取 context 与共享页
  liteHttp.t_mock();
  liteServer.t_mock();
  const server = liteServer.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><title>主页</title><body><a id="pop" href="/popup.html" target="_blank">弹层</a></body></html>');
      return;
    }
    if (req.url === '/popup.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><title>弹层页</title><body><h1>弹层内容</h1></body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知接口' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.port}`;
  const opened = await liteBrowser.open({ locale: 'zh-CN' });
  const context = liteBrowser.context();
  try {
    // 预期 1：context() 即 open 返回实例携带的同一上下文
    assert.equal(context, opened.context, 'context() 应返回 open 建立的同一上下文');
    // 输入：挂弹层等待后点击 target=_blank 链接
    const page = liteBrowser.page();
    await page.goto(origin);
    const popupPromise = context.waitForEvent('page');
    await page.locator('#pop').click();
    const popup = await popupPromise;
    // 预期 2：弹层在共享上下文内打开并可等待
    assert.ok(popup, '弹层应经 context.waitForEvent("page") 捕获');
    // 预期 3：弹层页内容来自真实 socket 回包
    assert.equal(await popup.title(), '弹层页', '弹层标题应来自真实回包');
    // 预期 4：弹层 DOM 断言命中
    assert.equal(await popup.locator('h1').textContent(), '弹层内容', '弹层 DOM 应命中真实路由 HTML');
    // 输入：关闭弹层
    await popup.close();
    // 预期 5：弹层关闭后共享页仍在
    assert.equal(await page.title(), '主页', '共享页不应受弹层关闭影响');
  } finally {
    await liteBrowser.close();
    liteServer.t_unmock();
    liteHttp.t_unmock();
  }
});

/** 场景：有头模式参数只是 Playwright launch 参数的透传，无业务含义，不在套件内显式测试
 * （显式有头用例会弹出浏览器窗口）；此处保留一条守卫：模式只由显式参数决定——环境变量不参与
 * 解析，LITENVI_HEADLESS 不得使缺省无头变为有头（有头是调用处按需开启的特定场景能力，
 * 不能成为进程级全局属性）。 */
test('环境变量不参与模式解析：LITENVI_HEADLESS=0 不改变缺省无头', async () => {
  // 输入：临时置 LITENVI_HEADLESS=0（try/finally 还原，不污染同进程后续用例）
  const previous = process.env.LITENVI_HEADLESS;
  process.env.LITENVI_HEADLESS = '0';
  try {
    // 输入：env 有头存在时无参 open
    const opened = await liteBrowser.open({});
    // 预期 1：缺省仍为无头——env 不得改变模式
    assert.equal(opened.headless, true, '有头只是显式参数能力：env 不得改变缺省无头');
  } finally {
    if (previous === undefined) delete process.env.LITENVI_HEADLESS;
    else process.env.LITENVI_HEADLESS = previous;
    await liteBrowser.close();
  }
});

/** 场景：前置约束与 close 语义——未 open 时 page()/context() 拒绝，close 幂等静默。 */
test('前置约束：未 open 时 page()/context() 拒绝、close 未 open 静默 no-op', async () => {
  // 输入：未 open 状态（上一用例已 close 清空单例）下依次调用 page/context/close
  // 预期 1：page() 拒绝并提示先 open
  assert.throws(() => liteBrowser.page(), /需先 open/, '未 open 时取页应拒绝');
  // 预期 2：context() 拒绝并提示先 open
  assert.throws(() => liteBrowser.context(), /需先 open/, '未 open 时取上下文应拒绝');
  // 预期 3：close() 未 open 静默完成（no-op 不抛错不拒绝）
  await assert.doesNotReject(() => liteBrowser.close(), '未 open 的 close 应静默 no-op');
});
