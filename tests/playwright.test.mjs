// 浏览器协议替身只控制资源边界；HTTP 响应由独立 VM 中完整的示例服务器生成。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { buildMockEnvironment } from '../environment.mjs';
import { openBrowserEnvironment } from '../environment.mjs';
import { protocol, origin } from './playwright-protocol.mjs';

const srcRoot = new URL('./fixtures/browser-server.mjs', import.meta.url).pathname;

test('内存路由保留正文、查询和真实响应，支持错误注入且不放行未知来源', async () => {
  const environment = await buildMockEnvironment({ srcRoot, projectRoot: '/app' });
  const delivered = [];
  let aborted = 0;
  const route = (url, method, body) => ({
    request: () => ({ url: () => url, method: () => method, postData: () => body }),
    fulfill: async response => delivered.push(response),
    abort: async () => { aborted += 1; },
  });
  try {
    const p = protocol();
    const fixture = await openBrowserEnvironment({ ...p.options, createEnvironment: () => environment });
    const handler = p.handlers[0];
    await handler(route(`${origin}/text?q=hello`, 'GET', null));
    assert.equal(delivered[0].body, 'text:hello');
    assert.equal(delivered[0].headers['content-type'], 'text/plain');
    await handler(route(`${origin}/echo`, 'POST', 'payload'));
    assert.deepEqual(JSON.parse(delivered[1].body), { posts: 1, method: 'POST', body: 'payload' });
    assert.equal(environment.http.requests[1].body, 'payload');
    environment.http.injectFault({ path: '/echo', status: 503, once: true });
    await handler(route(`${origin}/echo`, 'GET', null));
    assert.equal(delivered[2].status, 503);
    environment.http.injectFault({ path: '/echo', disconnect: true, once: true });
    await handler(route(`${origin}/echo`, 'GET', null));
    await handler(route('https://undeclared.invalid/', 'GET', null));
    await handler({ ...route(`${origin}/echo`, 'GET', null), fulfill: async () => { throw new Error('fulfill'); }, abort: async () => { throw new Error('abort'); } });
    assert.equal(aborted, 2);
    await assert.rejects(fixture.dispose(), error => {
      assert.equal(error.errors.length, 4);
      assert.match(error.errors[1].message, /Undeclared browser request/);
      assert.deepEqual(error.errors.slice(2).map(e => e.message), ['fulfill', 'abort']);
      return true;
    });
    const invalid = protocol();
    await assert.rejects(openBrowserEnvironment({ ...invalid.options, origin: 'invalid' }), /Invalid URL/);
  } finally { await environment.dispose(); }
});

test('装配注入浏览器并保留配置，全部清理且重复释放幂等', async () => {
  const p = protocol();
  const fixture = await openBrowserEnvironment({ ...p.options, setup: p.setup, launchOptions: { headless: false }, contextOptions: { serviceWorkers: 'allow' } });
  assert.deepEqual(p.calls, ['environment', 'setup', 'launch', 'context', 'route', 'page', 'goto']);
  assert.deepEqual(fixture.requests('GET', '/a'), [{ method: 'GET', path: '/a' }]);
  const first = fixture.dispose(), second = fixture.dispose();
  assert.equal(first, second);
  await first;
  assert.deepEqual(p.calls.slice(-3), ['context.close', 'browser.close', 'environment.close']);
});

test('装配各阶段失败自动清理，原始错误保留', async () => {
  for (const stage of ['environment', 'setup', 'launch', 'context', 'route', 'page', 'goto']) {
    const p = protocol({ failAt: stage });
    await assert.rejects(openBrowserEnvironment({ ...p.options, setup: p.setup }), error => error.message === stage);
    if (stage !== 'environment') assert.ok(p.calls.includes('environment.close'));
  }
});

test('页面和弹窗异常、清理失败全部留痕；失败资源不阻断后续释放', async () => {
  const clean = protocol();
  const fixture = await openBrowserEnvironment(clean.options);
  clean.page.emit('pageerror', new Error('main page'));
  const popup = new EventEmitter();
  clean.context.emit('page', popup);
  popup.emit('pageerror', new Error('popup'));
  await assert.rejects(fixture.dispose(), error => {
    assert.deepEqual(error.errors.map(e => e.message), ['main page', 'popup']);
    return true;
  });
  const broken = protocol({ closeErrors: ['context.close', 'browser.close', 'environment.close'] });
  const second = await openBrowserEnvironment(broken.options);
  await assert.rejects(second.dispose(), error => error.errors.length === 3);
  assert.deepEqual(broken.calls.slice(-3), ['context.close', 'browser.close', 'environment.close']);
  const startup = protocol({ failAt: 'goto', closeErrors: ['context.close'] });
  await assert.rejects(openBrowserEnvironment(startup.options), error => {
    assert.equal(error.cause.message, 'goto');
    assert.equal(error.errors[1].errors[0].message, 'context.close');
    return true;
  });
  const pending = protocol();
  pending.environment.http.pendingCount = () => 1;
  const third = await openBrowserEnvironment(pending.options);
  await assert.rejects(third.dispose(), /Browser environment errors/);
});
