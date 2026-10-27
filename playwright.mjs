// 可选浏览器适配层：Playwright 由调用方注入，核心环境无浏览器依赖。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 资源复制与路由安装由公开装配入口统一管理。
function copyDirectoryToMemory(filesystem, sourceDirectory, targetDirectory) {
  assert.ok(path.posix.isAbsolute(targetDirectory), 'Memory target must be an absolute path');
  const source = sourceDirectory instanceof URL ? fileURLToPath(sourceDirectory) : sourceDirectory;
  filesystem.mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.posix.join(targetDirectory, entry.name);
    if (entry.isDirectory()) copyDirectoryToMemory(filesystem, from, to);
    else if (entry.isFile()) filesystem.writeFileSync(to, readFileSync(from));
    else throw new Error(`Unsupported source entry: ${from}`);
  }
}


function createMemoryRoute(environment, { origin, errors }) {
  const allowedOrigin = new URL(origin).origin;
  return async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.origin, allowedOrigin, `Undeclared browser request: ${url.href}`);
      const response = await environment.http.request(request.method(), `${url.pathname}${url.search}`, request.postData() ?? undefined);
      await route.fulfill({ status: response.status, headers: response.headers, body: response.text ?? JSON.stringify(response.json) });
    } catch (error) {
      errors.push(error);
      try { await route.abort(); }
      catch (abortError) { errors.push(abortError); }
    }
  };
}

export async function openBrowserEnvironment({ createEnvironment, browserType, origin, url, setup = () => {}, launchOptions = {}, contextOptions = {}, resources = [], initialData }) {
  const cleanup = [], errors = [];
  let disposal;
  function dispose() {
    if (!disposal) disposal = (async () => {
      const cleanupErrors = [];
      for (const close of cleanup.reverse()) {
        try { await close(); }
        catch (error) { cleanupErrors.push(error); }
      }
      if (errors.length || cleanupErrors.length) throw new AggregateError([...errors, ...cleanupErrors], 'Browser environment errors');
    })();
    return disposal;
  }
  try {
    let initialized = false;
    const environment = await createEnvironment(filesystem => {
      for (const { source, target } of resources) copyDirectoryToMemory(filesystem, source, target);
      initialData?.(filesystem);
      initialized = true;
    });
    cleanup.push(async () => {
      await environment.dispose();
      assert.equal(environment.http.pendingCount(), 0, 'Memory HTTP requests must be released');
    });
    // 工厂必须在环境装配阶段执行初始化，不能把资源配置悄悄忽略。
    assert.ok(initialized || (resources.length === 0 && initialData === undefined), 'createEnvironment must invoke initialData during memory initialization');
    await setup(environment);
    const browser = await browserType.launch({ headless: true, ...launchOptions });
    cleanup.push(() => browser.close());
    const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
    cleanup.push(() => context.close());
    context.on('page', page => page.on('pageerror', error => errors.push(error)));
    await context.route('**/*', createMemoryRoute(environment, { origin, errors }));
    const page = await context.newPage();
    await page.goto(url);
    return {
      environment, browser, context, page, dispose,
      requests: (method, pathname) => environment.http.requests.filter(request => request.method === method && request.path === pathname),
    };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser startup and cleanup failed', { cause: error }); }
    throw error;
  }
}
