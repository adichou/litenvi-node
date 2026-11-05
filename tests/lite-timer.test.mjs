// lite-timer 门面的黑盒用例：公共绑定按遮蔽导入形态消费（与注入装配一致），原生 API 作为对照。
// 真实时间等待一律显式走 globalThis.setTimeout——用例自身导入的 setTimeout 在 mock 后是虚拟时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteTimer, { setTimeout, clearTimeout, setInterval, clearInterval, Date } from '../lite-timer.mjs';

const NativeDate = globalThis.Date;
const realSleep = (ms) => new Promise(resolve => globalThis.setTimeout(resolve, ms));

/** 场景：未 mock 时五个绑定原样转发——真实计时、原生 Date 面，advanceMs 明确拒绝。 */
test('默认透传：真实定时器、原生 Date、advanceMs 拒绝', async () => {
  liteTimer.t_unmock();
  const before = NativeDate.now();
  assert.ok(Math.abs(liteTimer.now() - before) < 1_000, '未 mock 的 now() 应为真实当前时刻');
  assert.ok(Math.abs(Date.now() - before) < 1_000, '遮蔽 Date.now 未 mock 应转发原生');
  const fired = await new Promise(resolve => setTimeout(() => resolve('ran'), 5));
  assert.equal(fired, 'ran', '未 mock 的 setTimeout 应按真实时间触发');
  assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z', '带参构造应透传原生');
  assert.equal(Date.parse('2026-01-02T03:04:05.000Z'), NativeDate.parse('2026-01-02T03:04:05.000Z'), 'parse 应透传原生');
  await assert.rejects(() => liteTimer.t_advanceMs(1), /需要 t_mock/, '未 mock 时推进应明确拒绝');
  assert.equal(typeof clearTimeout(NativeDate.now()), 'undefined', 'clearTimeout 未 mock 应转发原生');
});

/** 场景：mock 后世界冻结在纪元——Date 三形态取虚拟时刻，定时器只随 advanceMs 到期，先后按到期序。 */
test('虚拟时钟：纪元冻结、手动推进、到期序与回调内新建定时器', async () => {
  liteTimer.t_unmock();
  const epoch = liteTimer.t_mock({ now: '2026-10-08T04:00:00.000Z' });
  try {
    assert.equal(liteTimer.now(), NativeDate.parse('2026-10-08T04:00:00.000Z'), 'now() 应为纪元');
    assert.equal(Date.now(), NativeDate.parse('2026-10-08T04:00:00.000Z'), 'Date.now 应为虚拟时刻');
    assert.equal(new Date().toISOString(), '2026-10-08T04:00:00.000Z', 'new Date() 应取虚拟当前时刻');
    assert.equal(Date(), '2026-10-08T04:00:00.000Z', 'Date() 函数形态应返回虚拟时刻 ISO');
    assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z', '带参构造不受 mock 影响');
    assert.equal(Date.UTC(2026, 0, 2), NativeDate.UTC(2026, 0, 2), 'UTC 静态面应透传');

    const seen = [];
    setTimeout((a, b) => seen.push(['later', a, b]), 500, 'x', 1);
    setTimeout(() => seen.push(['sooner', Date.now()]), 200);
    await realSleep(30);
    assert.deepEqual(seen, [], '真实时间流逝不得触发冻结世界的定时器');
    await liteTimer.t_advanceMs(199);
    assert.deepEqual(seen, [], '未到期的定时器不得提前触发');
    await liteTimer.t_advanceMs(301);
    assert.deepEqual(seen.map(([tag]) => tag), ['sooner', 'later'], '推进应按到期先后派发');
    assert.equal(seen[0][1], NativeDate.parse('2026-10-08T04:00:00.000Z') + 200, '回调内 Date.now 应为该定时器的虚拟到期时刻');
    assert.deepEqual(seen[1].slice(1), ['x', 1], '额外实参应透传回调');
    assert.equal(liteTimer.now(), NativeDate.parse('2026-10-08T04:00:00.500Z'), '推进后 now 应为累计虚拟时刻');

    const chained = [];
    setTimeout(() => { chained.push('parent'); setTimeout(() => chained.push('child'), 100); }, 0);
    await liteTimer.t_advanceMs(1);
    assert.deepEqual(chained, ['parent'], '回调内新建定时器应留给后续推进');
    await liteTimer.t_advanceMs(100);
    assert.deepEqual(chained, ['parent', 'child'], '后续推进应派发回调内新建的定时器');
    assert.equal(typeof epoch, 'object', 'mock 应返回公共门面');
  } finally { liteTimer.t_unmock(); }
});

/** 场景：重复 mock 幂等保留既有纪元与在途定时器；推进继续可用。 */
test('幂等 mock：纪元不被改写、在途定时器保留', async () => {
  liteTimer.t_unmock();
  liteTimer.t_mock({ now: 1_000 });
  try {
    const fired = [];
    setTimeout(() => fired.push('kept'), 100);
    assert.equal(liteTimer.t_mock(), liteTimer, '重复 mock 应返回同一门面');
    liteTimer.t_mock({ now: 999_999 });
    assert.equal(liteTimer.now(), 1_000, '重复 mock 不得改写既有纪元');
    await liteTimer.t_advanceMs(100);
    assert.deepEqual(fired, ['kept'], '重复 mock 不得丢弃在途定时器');
  } finally { liteTimer.t_unmock(); }
});

/** 场景：setInterval 随每次推进到期、clearInterval 停止；clearTimeout 取消未到期定时器。 */
test('周期定时器与取消：interval 逐次到期、clear 系生效', async () => {
  liteTimer.t_unmock();
  liteTimer.t_mock({ now: 0 });
  try {
    const ticks = [];
    const handle = setInterval(() => ticks.push(Date.now()), 50);
    await liteTimer.t_advanceMs(120);
    assert.deepEqual(ticks, [50, 100], '跨步推进应按期派发每次到期');
    clearInterval(handle);
    await liteTimer.t_advanceMs(200);
    assert.equal(ticks.length, 2, 'clearInterval 后不得再派发');
    const cancelled = setTimeout(() => ticks.push('ghost'), 10);
    clearTimeout(cancelled);
    await liteTimer.t_advanceMs(50);
    assert.equal(ticks.length, 2, 'clearTimeout 应取消未到期定时器');
  } finally { liteTimer.t_unmock(); }
});

/** 场景：unmock 丢弃未触发定时器并恢复原生——此后真实计时与真实 Date 生效。 */
test('unmock：在途定时器丢弃、原生计时恢复', async () => {
  liteTimer.t_unmock();
  liteTimer.t_mock({ now: 0 });
  const ghost = [];
  setTimeout(() => ghost.push('fired'), 100);
  liteTimer.t_unmock();
  liteTimer.t_unmock();
  await assert.rejects(() => liteTimer.t_advanceMs(1), /需要 t_mock/, '卸载后推进应明确拒绝');
  const realFired = await new Promise(resolve => setTimeout(() => resolve('ran'), 5));
  assert.equal(realFired, 'ran', '卸载后 setTimeout 应恢复真实计时');
  const at = NativeDate.now();
  assert.ok(Math.abs(Date.now() - at) < 1_000, '卸载后 Date.now 应恢复原生');
  await realSleep(30);
  assert.deepEqual(ghost, [], '被丢弃的虚拟定时器不得再触发');
});

/** 场景：非法入参按类型拒绝——mock 形状与纪元、推进量、未 mock 推进。 */
test('入参校验：mock 形状/纪元、advanceMs 数值与状态', async () => {
  liteTimer.t_unmock();
  for (const bad of [null, false, [], 'mock']) {
    assert.throws(() => liteTimer.t_mock(bad), TypeError, `mock(${String(bad)}) 应拒绝非法形状`);
  }
  for (const bad of ['garbage', Number.NaN, { valueOf: () => 1 }]) {
    assert.throws(() => liteTimer.t_mock({ now: bad }), TypeError, `纪元 ${String(bad)} 应拒绝`);
  }
  await assert.rejects(() => liteTimer.t_advanceMs(0), /需要 t_mock/, '未 mock 推进应拒绝');
  liteTimer.t_mock({ now: 0 });
  try {
    liteTimer.t_mock({ now: 'garbage' });
    assert.fail('已 mock 状态下纪元校验不得跳过');
  } catch (error) { assert.equal(error.name, 'TypeError', '已 mock 状态下纪元校验仍应生效'); }
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
    await assert.rejects(() => liteTimer.t_advanceMs(bad), TypeError, `推进量 ${String(bad)} 应拒绝`);
  }
  await assert.doesNotReject(() => liteTimer.t_advanceMs(0), '零推进应合法');
});
