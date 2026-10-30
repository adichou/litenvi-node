// 一个进程只装配一个业务世界；父进程通过 IPC 发送动作并接收只读快照。
import { buildMockEnvironment } from './environment.mjs';
import { loadNativeModules } from './native-modules.mjs';
import { createSnapshotReader } from './memory-snapshot.mjs';
import { setImmediate as immediate } from 'node:timers';

const host = process;
const send = message => new Promise((resolve, reject) => host.send(message, error => error ? reject(error) : resolve()));
const flush = () => new Promise(resolve => immediate(resolve));
let environment, snapshot;
// 闸门故障：gateId → resolve；父进程 promise 释放前，匹配请求在子进程侧挂起。
const gates = new Map();
// 故障撤销句柄：faultId → transport 移除函数（函数过不了 IPC，句柄留在本进程）。
const removers = new Map();

function state() {
  if (!environment) return null;
  return { filesystem: snapshot(), requests: environment.http.requests.map(({ signal, ...entry }) => entry),
    logs: environment.logs, unexpected: environment.unexpected,
    // Git 观测整面快照：log（提交账本）+ committed（已入库 pathspec，支撑 isCommitted）。
    git: { log: environment.git.log(), committed: environment.git.committed() },
    now: environment.clock.now, timers: environment.clock.countTimers() };
}

host.on('message', async ({ id, operation, args }) => {
  try {
    let value;
    if (operation === 'initialize') {
      const { files, ...options } = args;
      // 页面侧请求不经父进程调用：发出（observe，含闸门挂起的在途可见）与落定（settle）
      // 均推送观测；推送串行排队（REQ-20261024-001）。
      let pushChain = Promise.resolve();
      const pushState = () => {
        pushChain = pushChain
          .then(() => flush())
          .then(() => send({ state: state() }))
          .catch(() => {});
      };
      environment = await buildMockEnvironment({ ...options,
        onHttpObserve: pushState, onHttpSettle: pushState,
      initialData(filesystem) {
        // memfs 保持初始化期唯一写通道；数据在父进程执行用户播种后传入。
        filesystem.__vol.fromJSON(files);
        snapshot = createSnapshotReader(filesystem.__vol);
      }, loadModules: (opts) => loadNativeModules({ ...opts, packageAllowlist: options.packageAllowlist }) });
    } else if (operation === 'request') {
      value = await environment.http.request(...args);
    } else if (operation === 'fault') {
      // faultId：父进程撤销句柄——transport 的移除函数留在本进程，经 removeFault 消息调用。
      const { gateId, faultId, ...fault } = args;
      const remove = gateId != null
        ? (() => {
            let release;
            const promise = new Promise(resolve => { release = resolve; });
            gates.set(gateId, release);
            return environment.http.injectFault({ ...fault, wait: promise });
          })()
        : environment.http.injectFault(fault);
      removers.set(faultId, remove);
    } else if (operation === 'removeFault') {
      removers.get(args)?.();
      removers.delete(args);
    } else if (operation === 'release') {
      gates.get(args)?.();
      gates.delete(args);
    } else if (operation === 'git') {
      value = environment.git.run(args);
    } else if (operation === 'tick') {
      await environment.clock.tickAsync(args);
    } else if (operation === 'refresh') {
      // 只刷新观测，不执行业务写入。
    } else if (operation === 'dispose') {
      await flush();
      await environment?.dispose();
    } else {
      throw new Error(`未知进程操作：${operation}`);
    }
    await flush();
    await send({ id, value, state: state() });
  } catch (error) {
    await send({ id, error: { message: error.message, name: error.name, stack: error.stack }, state: state() });
  } finally {
    if (operation === 'dispose') host.disconnect();
  }
});
