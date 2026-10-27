// 父进程只负责浏览器与观测；模块替身和 FakeTimers 全部留在独立业务进程。
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Volume, createFsFromVolume } from 'memfs';
import { createFsView } from './fs.mjs';
import { applySnapshot } from './memory-snapshot.mjs';

// dispose 后闸门落定时 release 调用必然失败：显式吞掉，避免无人处理的 rejection。
const swallow = () => {};

export async function buildProcessEnvironment(options = {}) {
  const { initialData = () => {}, timeoutMs = 10_000, ...settings } = options;
  assert.ok(settings.srcRoot && settings.projectRoot, '进程环境需要 srcRoot 与 projectRoot');
  const allowed = ['srcRoot', 'projectRoot', 'env', 'now', 'initialStorage'];
  assert.ok(Object.keys(settings).every(key => allowed.includes(key)), '原生试点存在尚未支持的装配选项');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, '进程通信超时必须为正数');
  const volume = new Volume(), filesystem = createFsFromVolume(volume);
  initialData(filesystem);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = fork(fileURLToPath(new URL('./process-worker.mjs', import.meta.url)), [], {
    execArgv: ['--experimental-test-module-mocks'], serialization: 'advanced',
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let sequence = 0, closed = false, disposal, activeRequests = 0, terminationError;
  const pending = new Map(), requests = [], logs = [], unexpected = [];
  let observation = { git: [], now: 0, timers: 0 }, stderr = '';
  child.stdout.on('data', data => logs.push(String(data)));
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  function rejectPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
  const exited = new Promise(resolve => {
    child.on('error', error => { closed = true; terminationError = error; rejectPending(error); resolve(); });
    child.on('exit', (code, signal) => {
      closed = true;
      const error = new Error(`业务子进程退出：code=${code} signal=${signal}\n${stderr}`);
      if (code !== 0 || signal || !disposal) terminationError = error;
      rejectPending(error);
      resolve();
    });
  });
  child.on('message', message => {
    if (message.state) {
      observation = message.state;
      applySnapshot(volume, observation.filesystem);
      requests.splice(0, requests.length, ...observation.requests);
      logs.splice(0, logs.length, ...observation.logs);
      unexpected.splice(0, unexpected.length, ...observation.unexpected);
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
    else waiter.resolve(message.value);
  });
  function call(operation, args) {
    if (closed || (disposal && operation !== 'dispose')) return Promise.reject(new Error('业务进程已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`业务进程操作超时：${operation}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, operation, args }, error => {
          if (error && pending.delete(id)) { clearTimeout(timer); reject(error); }
        });
      } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function dispose() {
    if (!disposal) disposal = (async () => {
      try {
        if (!closed) await call('dispose');
        else throw terminationError;
      } finally {
        if (!closed) {
          const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          await exited;
          clearTimeout(timer);
        }
        volume.reset();
      }
      if (terminationError) throw terminationError;
    })();
    return disposal;
  }
  try {
    await call('initialize', { ...settings, files: volume.toJSON(undefined, {}, false, true) });
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], '业务环境装配和清理失败', { cause: error }); }
    throw error;
  }
  return Object.freeze({
    runtime: 'process', pid: child.pid, dispose, refresh: () => call('refresh'),
    fs: createFsView(filesystem), logs, unexpected,
    git: Object.freeze({ log: () => structuredClone(observation.git.log), isCommitted: pathspec => observation.git.committed.includes(pathspec), run: command => call('git', command) }),
    clock: Object.freeze({ get now() { return observation.now; }, countTimers: () => observation.timers,
      tickAsync: milliseconds => call('tick', milliseconds) }),
    http: Object.freeze({ requests, pendingCount: () => activeRequests,
      // 闸门式故障：wait 为父进程 promise 时不可序列化——注册为 gateId 闸门，
      // promise 落定后经 release 放行子进程侧挂起的匹配请求。
      // 返回 Promise<移除函数>：注册失败在此拒绝（非法故障配置），成功 resolve 出与 VM
      // 口径对齐的移除函数（撤销经 removeFault 消息调子进程侧句柄）。
      injectFault: fault => {
        const faultId = `fault-${++sequence}`;
        const { wait, ...rest } = fault;
        const gateId = fault && fault.wait instanceof Promise ? `gate-${++sequence}` : null;
        const registered = call('fault', { ...rest, faultId, ...(gateId ? { gateId } : {}) });
        if (gateId)
          registered.then(() => wait).finally(() => call('release', gateId).catch(swallow));
        return registered.then(() => () => call('removeFault', faultId).catch(swallow));
      },
      request(method, pathname, body) {
        activeRequests++;
        return call('request', [method, pathname, body]).finally(() => { activeRequests--; });
      },
    }),
  });
}
