import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

test('worker reports IPC send callback failures with the original error', async () => {
  let receiver, calls = 0;
  const messages = [];
  const originalOn = process.on;
  process.send = () => {};
  const send = mock.method(process, 'send', (message, callback) => {
    messages.push(message);
    callback(++calls === 1 ? new Error('IPC send failure') : null);
  });
  const listen = mock.method(process, 'on', function(event, handler) {
    if (event === 'message') receiver = handler;
    else return originalOn.call(this, event, handler);
  });
  try {
    await import('../process-worker.mjs');
    listen.mock.restore();
    await receiver({ id: 1, operation: 'refresh' });
    assert.equal(messages.length, 2, '首条发送失败应尝试回传原始通信错误');
    assert.equal(messages[1].error.message, 'IPC send failure', '通信错误应保留原因');
  } finally {
    listen.mock.restore();
    send.mock.restore();
    delete process.send;
  }
});
