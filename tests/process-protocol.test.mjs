import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { serialize } from 'node:v8';

// 只替换进程传输边界，协议编排、超时、快照和清理使用库的完整实现。
let behavior;
class Child extends EventEmitter {
  constructor() {
    super();
    this.pid = 123;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.behavior = behavior;
    behavior.child = this;
  }
  send(message, callback) {
    serialize(message);
    const { operation, id } = message;
    const config = this.behavior;
    if (config.throwOn === operation) throw new Error('send throw');
    if (config.errorOn === operation) return queueMicrotask(() => callback(new Error('send callback')));
    if (config.spawnError) return queueMicrotask(() => this.emit('error', new Error('spawn error')));
    if (config.hangOn === operation) {
      if (config.late) setTimeout(() => { callback(new Error('late send')); this.emit('message', { id, value: 'late' }); }, 30);
      return;
    }
    queueMicrotask(() => {
      this.stdout.emit('data', Buffer.from('stdout'));
      this.stderr.emit('data', Buffer.from('stderr'));
      this.emit('message', { id: 0 });
      const state = { filesystem: { files: { '/a': Buffer.from('value') }, deleted: [] },
        requests: [], logs: ['log'], unexpected: [], git: { log: [], committed: [] }, now: 10, timers: 0 };
      this.emit('message', { id, state, error: config.remoteOn === operation ? { message: 'remote error', name: 'TypeError' } : undefined });
      callback(null);
      if (operation === 'dispose' && !config.stayAlive) this.emit('exit', 0, null);
    });
  }
  kill(signal) { this.emit('exit', null, signal); }
}
mock.module('node:child_process', { namedExports: { fork: () => new Child() } });
const { buildProcessEnvironment } = await import('../process-environment.mjs');
const boot = options => buildProcessEnvironment({ srcRoot: '/src/entry.mjs', projectRoot: '/app', timeoutMs: 20, ...options });

test('IPC send failures, timeout and stale replies release waiters and preserve cleanup', async () => {
  for (const config of [{ throwOn: 'fault' }, { errorOn: 'fault' }, { hangOn: 'fault', late: true }, { remoteOn: 'fault' }]) {
    behavior = config;
    const environment = await boot();
    try {
      await assert.rejects(environment.http.injectFault({}), /send|超时|remote error/, '发送和远端失败应回传');
      if (config.late) await new Promise(resolve => setTimeout(resolve, 40));
      await environment.refresh();
      assert.equal(environment.fs.readTextFile('/a'), 'value', '错误后应仍能刷新快照');
      assert.equal(environment.clock.now, 10, '时钟观测应来自消息');
    } finally { await environment.dispose(); }
  }
});

test('startup and unexpected exits report errors even when no request is awaiting', async () => {
  behavior = { spawnError: true };
  await assert.rejects(boot(), error => error instanceof AggregateError && error.cause.message === 'spawn error', '启动失败和清理失败都应保留');
  behavior = { remoteOn: 'initialize' };
  await assert.rejects(boot(), /remote error/, '干净收尾后应保留原始启动错误');
  for (const event of ['error', 'exit']) {
    behavior = {};
    const environment = await boot();
    if (event === 'error') behavior.child.emit('error', new Error('worker error'));
    else behavior.child.emit('exit', 0, null);
    await assert.rejects(environment.dispose(), /worker error|业务子进程退出/, '空闲期退出不能被吞掉');
    await assert.rejects(environment.refresh(), /已关闭/, '已退出的进程不能继续发消息');
  }
});

test('disposal is bounded, idempotent and rejects new actions during cleanup', async () => {
  for (const config of [{ hangOn: 'dispose' }, { stayAlive: true }]) {
    behavior = config;
    const environment = await boot();
    const first = environment.dispose();
    assert.equal(environment.dispose(), first, '销毁必须幂等');
    await assert.rejects(environment.http.request('GET', '/'), /已关闭/, '销毁中不应接收新动作');
    if (config.hangOn) await assert.rejects(first, /操作超时/, '未响应的销毁应超时而非挂起');
    else await assert.rejects(first, /业务子进程退出/, '确认清理后仍挂起并被强制终止不能误报通过');
    assert.equal(environment.fs.exists('/a'), false, '强制退出后也应清除快照');
  }
});
