import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

// 直接驱动 IPC 仅检查协议边界；成功业务读写另由完整环境与浏览器用例验证。
test('worker rejects unknown commands and requests before initialization and can dispose empty state', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(new URL('../process-worker.mjs', import.meta.url), [], {
    execArgv: ['--experimental-test-module-mocks'], serialization: 'advanced',
    env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let id = 0;
  async function call(operation, args) {
    const reply = once(child, 'message');
    child.send({ id: ++id, operation, args });
    return (await reply)[0];
  }
  const exit = once(child, 'exit');
  try {
    assert.match((await call('unknown')).error.message, /未知进程操作/, '未知动作应回传错误');
    assert.ok((await call('request', ['GET', '/'])).error, '未初始化不能执行业务请求');
    assert.equal((await call('refresh')).state, null, '未初始化时观测应为空');
  } finally {
    assert.equal((await call('dispose')).error, undefined, '未初始化也应允许幂等清理');
    assert.equal((await exit)[0], 0, '清理完成后应正常退出');
  }
});
