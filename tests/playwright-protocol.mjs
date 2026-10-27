// 测试专用浏览器协议边界：捕获路由安装与资源关闭，不替换适配器逻辑。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
export const origin = 'http://example.test';

export function protocol({ failAt = '', closeErrors = [] } = {}) {
  const calls = [], handlers = [], page = new EventEmitter(), context = new EventEmitter();
  function step(name) {
    calls.push(name);
    if (failAt === name || closeErrors.includes(name)) throw new Error(name);
  }
  const environment = {
    http: { requests: [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }, { method: 'POST', path: '/a' }], pendingCount: () => 0 },
    dispose: async () => step('environment.close'),
  };
  page.goto = async url => { step('goto'); assert.equal(url, origin); };
  context.route = async (pattern, handler) => { step('route'); assert.equal(pattern, '**/*'); assert.equal(typeof handler, 'function'); handlers.push(handler); };
  context.newPage = async () => { step('page'); context.emit('page', page); return page; };
  context.close = async () => step('context.close');
  const browser = {
    newContext: async options => { step('context'); assert.equal(options.serviceWorkers, 'block'); return context; },
    close: async () => step('browser.close'),
  };
  const browserType = { launch: async options => { step('launch'); assert.equal(typeof options.headless, 'boolean'); return browser; } };
  return {
    calls, handlers, page, context, environment,
    options: { createEnvironment: async () => { step('environment'); return environment; }, browserType, origin, url: origin },
    setup: async () => step('setup'),
  };
}

