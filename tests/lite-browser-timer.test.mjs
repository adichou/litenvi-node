// 浏览器定时门面的黑盒用例：真实页面显式导入模块，原生 API 作为响应和类型的对照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import timer from '../lite-browser-timer.mjs';
import liteBrowser from '../lite-browser.mjs';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';

async function withTimerPage(run, setupScript = '') {
  liteHttp.t_mock(); liteServer.t_mock();
  const server = liteServer.createServer((req, res) => {
    if (req.url === '/timer.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(fs.readFileSync(new URL('../lite-browser-timer.mjs', import.meta.url)));
    } else if (req.url === '/slow') res.end('response-body');
    else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><script>${setupScript}</script><script type="module">
        import timer, { AbortSignal } from '/timer.mjs';
        window.timerFixture = { timer, AbortSignal, cachedTimeout: AbortSignal?.timeout };
      </script>`);
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { page } = await liteBrowser.open();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() => !!window.timerFixture);
    return await run(page);
  } finally {
    await liteBrowser.close(); liteServer.t_unmock(); liteHttp.t_unmock();
  }
}

/** 场景：门面默认调用原生 API，保留信号类型、组合与构造错误，并且不覆盖页面全局。 */
test('默认透传：原生超时、abort/any、instanceof 与全局引用保持一致', async () => {
  assert.equal(typeof timer.t_mock, 'function', '模块应能在 Node 中加载公共控制接口');
  await withTimerPage(async page => {
    const result = await page.evaluate(async () => {
      const { timer, AbortSignal: Signal } = window.timerFixture;
      const signal = Signal.timeout(5);
      const timeout = await new Promise(resolve => signal.addEventListener('abort', () => resolve(signal.reason.name)));
      const manual = Signal.abort('manual');
      const combined = Signal.any([manual]);
      let constructorError;
      try { new Signal(); } catch (error) { constructorError = error.name; }
      return { timeout, reason: combined.reason, instance: signal instanceof AbortSignal,
        facadeInstance: signal instanceof Signal, prototype: Signal.prototype === AbortSignal.prototype,
        shared: timer.AbortSignal === Signal, constructorError,
        nativeUnchanged: window.nativeTimeout === AbortSignal.timeout };
    });
    assert.deepEqual(result, { timeout: 'TimeoutError', reason: 'manual', instance: true, facadeInstance: true,
      prototype: true, shared: true, constructorError: 'TypeError', nativeUnchanged: true }, '默认行为和原生类型应保持一致');
  }, 'window.nativeTimeout = AbortSignal.timeout;');
});

/** 场景：mock 可幂等启用，缓存的门面函数也受控制；触发仅结束本批信号，unmock 清理并恢复。 */
test('gate 生命周期：幂等、缓存入口、分批触发、清理与恢复', async () => {
  await withTimerPage(async page => {
    const pending = await page.evaluate(async () => {
      const { timer, cachedTimeout } = window.timerFixture;
      const first = timer.t_mock();
      window.gateProbe = { a: cachedTimeout(1), b: timer.AbortSignal.timeout(1) };
      const same = timer.t_mock() === first && first === timer;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { same, aborted: [window.gateProbe.a.aborted, window.gateProbe.b.aborted],
        nativeUnchanged: window.nativeTimeout === AbortSignal.timeout };
    });
    assert.deepEqual(pending, { same: true, aborted: [false, false], nativeUnchanged: true }, 'gate 应挂起门面信号且不替换原生入口');
    const triggered = await page.evaluate(() => {
      const { timer } = window.timerFixture;
      window.gateProbe.a.addEventListener('abort', () => { window.gateProbe.next = timer.AbortSignal.timeout(1); });
      timer.t_triggerSignalTimeout();
      const result = [window.gateProbe.a.reason.name, window.gateProbe.b.reason.name,
        window.gateProbe.a.reason instanceof DOMException, window.gateProbe.next.aborted];
      timer.t_triggerSignalTimeout();
      result.push(window.gateProbe.next.reason.name);
      timer.t_triggerSignalTimeout();
      return result;
    });
    assert.deepEqual(triggered, ['TimeoutError', 'TimeoutError', true, false, 'TimeoutError'], '触发应使用原生错误，回调中新建信号留给下一次触发');
    const restored = await page.evaluate(async () => {
      const { timer } = window.timerFixture;
      const pending = timer.AbortSignal.timeout(60_000);
      timer.t_unmock(); timer.t_unmock(); timer.t_triggerSignalTimeout();
      const signal = timer.AbortSignal.timeout(5);
      const reason = await new Promise(resolve => signal.addEventListener('abort', () => resolve(signal.reason.name)));
      return [pending.reason.name, reason, window.nativeTimeout === AbortSignal.timeout];
    });
    assert.deepEqual(restored, ['AbortError', 'TimeoutError', true], '卸载应取消在途 mock 并恢复之后的真实超时');
  }, 'window.nativeTimeout = AbortSignal.timeout;');
});

/** 场景：真实 fetch 使用门面信号；gate 触发后走原生超时失败分支，撤销后可正常请求。 */
test('真实请求：超时中止 fetch，撤销后正常返回', async () => {
  let release;
  await withTimerPage(async page => {
    const gate = new Promise(resolve => { release = resolve; });
    const remove = liteServer.t_inject({ url: '/slow', wait: gate });
    try {
      const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/slow');
      await page.evaluate(() => {
        const { timer, cachedTimeout } = window.timerFixture;
        timer.t_mock(); window.fetchProbe = { state: 'pending' };
        fetch('/slow', { signal: cachedTimeout(1) }).then(response => response.text()).then(
          body => { window.fetchProbe = { state: 'done', body }; },
          error => { window.fetchProbe = { state: 'failed', name: error.name }; },
        );
      });
      await sent;
      await page.evaluate(() => window.timerFixture.timer.t_triggerSignalTimeout());
      await page.waitForFunction(() => window.fetchProbe.state !== 'pending');
      assert.deepEqual(await page.evaluate(() => window.fetchProbe), { state: 'failed', name: 'TimeoutError' }, '真实 fetch 应识别门面信号并报告超时');
      release(); remove();
      const response = await page.evaluate(async () => {
        const { timer } = window.timerFixture;
        timer.t_unmock();
        return fetch('/slow', { signal: timer.AbortSignal.timeout(1000) }).then(response => response.text());
      });
      assert.equal(response, 'response-body', '撤销 mock 后请求应正常返回业务内容');
    } finally { release(); remove(); }
  });
});

/** 场景：非法超时参数与原生错误类型一致；不存在 scale 模式；页面导航获得新的默认实例。 */
test('入参与导航：错误类型对照、拒绝 scale、导航复位', async () => {
  await withTimerPage(async page => {
    const invalid = await page.evaluate(() => {
      const { timer } = window.timerFixture;
      let scale;
      try { timer.t_mock({ mode: 'scale' }); } catch (error) { scale = error.name; }
      timer.t_mock();
      const errors = [undefined, -1, NaN, Infinity, 2 ** 64, 1n, Symbol()].map(value => {
        const failure = operation => { try { operation(); } catch (error) { return error.name; } };
        return [failure(() => AbortSignal.timeout(value)), failure(() => timer.AbortSignal.timeout(value))];
      });
      return { scale, errors };
    });
    assert.equal(invalid.scale, 'TypeError', '应拒绝已移除的 scale 模式');
    for (const [native, mock] of invalid.errors) assert.equal(mock, native, 'mock 的非法参数错误类型应与原生一致');
    await page.reload(); await page.waitForFunction(() => !!window.timerFixture);
    assert.equal(await page.evaluate(() => new Promise(resolve => {
      const signal = window.timerFixture.AbortSignal.timeout(5);
      signal.addEventListener('abort', () => resolve(signal.reason.name));
    })), 'TimeoutError', '导航后的新模块实例应恢复默认原生行为');
  });
});

/** 场景：旧环境没有 AbortSignal 时可安全加载门面，业务可检测能力并降级。 */
test('能力缺失：安全加载并明确拒绝 mock', async () => {
  await withTimerPage(async page => {
    assert.deepEqual(await page.evaluate(() => {
      const { timer, AbortSignal: Signal } = window.timerFixture;
      let error;
      try { timer.t_mock(); } catch (failure) { error = failure.name; }
      return { absent: Signal === undefined && timer.AbortSignal === undefined, error };
    }), { absent: true, error: 'TypeError' }, '缺少原生信号能力时应允许检测并明确拒绝启用');
  }, 'window.AbortSignal = undefined;');
});

/** 场景：Node 与页面的同名模块状态隔离，公共 gate 控制和清理在各自上下文生效。 */
test('上下文隔离：Node 门面控制不改原生对象，也不影响浏览器默认计时', async () => {
  const native = globalThis.AbortSignal;
  const nativeTimeout = native.timeout;
  const cached = timer.AbortSignal.timeout;
  timer.t_triggerSignalTimeout(); timer.t_unmock();
  for (const options of [null, false, [], { mode: 'scale' }]) {
    assert.throws(() => timer.t_mock(options), TypeError, '非法 mock 参数应拒绝');
  }
  try {
    assert.equal(timer.t_mock(), timer, 'mock 应返回同一个公共门面');
    const pending = cached(1);
    assert.equal(timer.t_mock({ mode: 'gate' }), timer, '重复 mock 不应丢失已有信号');
    for (const milliseconds of [-1, NaN, Infinity, 2 ** 64]) {
      assert.throws(() => timer.AbortSignal.timeout(milliseconds), TypeError, '非法超时应拒绝');
    }
    const abort = timer.AbortSignal.abort('manual');
    assert.equal(timer.AbortSignal.any([abort]).reason, 'manual', '非 timeout 静态 API 仍应原生透传');
    assert.equal(pending instanceof timer.AbortSignal, true, '门面应保留原生原型');
    timer.t_triggerSignalTimeout();
    assert.equal(pending.reason.name, 'TimeoutError', 'Node gate 也应产生原生超时原因');
    await withTimerPage(async page => {
      assert.equal(await page.evaluate(() => new Promise(resolve => {
        const signal = window.timerFixture.AbortSignal.timeout(5);
        signal.addEventListener('abort', () => resolve(signal.reason.name));
      })), 'TimeoutError', 'Node 的 mock 状态不能跨进程影响页面模块');
    });
    const cancelled = cached(1);
    timer.t_unmock();
    assert.equal(cancelled.reason.name, 'AbortError', '卸载应取消未结束的 gate');
    const real = cached(5);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(real.reason.name, 'TimeoutError', '缓存门面入口在卸载后应恢复原生计时');
    assert.equal(globalThis.AbortSignal, native, '原生全局类不应改写');
    assert.equal(native.timeout, nativeTimeout, '原生静态方法不应改写');
  } finally { timer.t_unmock(); }
});
