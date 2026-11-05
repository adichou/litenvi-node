// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-timer：定时器与时钟替身门面（有 t_mock/t_unmock）——Node 侧按模块遮蔽注入的时间边界。
// 注入方式：测试装配（node:module register hook）向被测模块源码头部注入
// `import { setTimeout, clearTimeout, setInterval, clearInterval, Date } from 'litenvi-node/lite-timer.mjs'`，
// ESM import 绑定遮蔽全局——仅被注入模块的定时器与 Date 运行在虚拟时钟上，宿主进程
//（测试运行器、socket、未被注入的模块）不受影响。未 t_mock 时五个绑定全部原样转发原生实现：
// 静态 import 恒在，开关只由 t_mock/t_unmock 控制，注入但不 t_mock 与未注入行为一致。
// 虚拟时钟为手动推进（冻结）语义：t_mock({ now? }) 从给定纪元（缺省当前真实时刻）起步，
// 定时器只在 t_advanceMs(ms) 推进时到期触发（tickAsync 口径：派发到期回调并让其微任务沉淀，
// 回调内新建的定时器等待后续推进）；Date.now() / new Date() / Date() 返回虚拟当前时刻，
// new Date(x) 与 parse/UTC 等静态面原样透传。句柄为时钟内部 id（数值），被注入模块的
// `handle.unref?.()` 等可选消费安全短路，不持真实事件循环句柄。
// 与 @sinonjs/fake-timers 的关系：复用其 createClock 独立时钟（与 VM 链 environment.mjs
// 同源），不使用 install——不触碰宿主全局，lite 链单进程内共存成为可能。
// 与 lite-browser-timer 的分工：那是页面端 AbortSignal.timeout 的 gate 门面（页面 bundle
// 显式导入）；本模块面向 Node 侧普通定时器与 Date 读取，两端互不感知。
// 未覆盖面（如实声明）：process.hrtime、performance、queueMicrotask 与真实 I/O 的到达
// 时刻不经本门面；setInterval 到期同样依赖 t_advanceMs 推进，不随真实时间自走。
// t_unmock 丢弃时钟与未触发定时器（不补触发——何时推进由测试决定，泄漏定时器随世界丢弃）。
// 重复 t_mock 幂等：保留既有时钟与纪元，后续 options 不改写既有配置（与 lite-process 口径一致）。
// 依赖方向（无环）：仅 @sinonjs/fake-timers，不依赖其他 lite-* 模块。
import FakeTimers from '@sinonjs/fake-timers';

const f_nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const f_nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const f_nativeSetInterval = globalThis.setInterval.bind(globalThis);
const f_nativeClearInterval = globalThis.clearInterval.bind(globalThis);
const f_nativeDate = globalThis.Date;
let f_clock = null; // 未设置 → 五个绑定原生透传；createClock 实例 → 虚拟时钟世界

// 私有方法：解析纪元与推进量；数值须有限，字符串须可解析为有限时间戳。
function f_epoch(value) {
  const at = typeof value === 'number' ? value : f_nativeDate.parse(String(value));
  if (!Number.isFinite(at)) throw new TypeError('lite-timer 的 now/milliseconds 应为有限数值或可解析时间');
  return at;
}

// 外部绑定：setTimeout/clearTimeout/setInterval/clearInterval——t_mock 后走虚拟时钟（到期依赖
// t_advanceMs 推进），未 t_mock 原样转发原生（含原生参数透传：额外实参、返回句柄）。
export function setTimeout(callback, delay, ...args) {
  if (f_clock) return f_clock.setTimeout(callback, delay, ...args);
  return f_nativeSetTimeout(callback, delay, ...args);
}

// 外部绑定：见 setTimeout。
export function clearTimeout(handle) {
  if (f_clock) return f_clock.clearTimeout(handle);
  return f_nativeClearTimeout(handle);
}

// 外部绑定：见 setTimeout。
export function setInterval(callback, delay, ...args) {
  if (f_clock) return f_clock.setInterval(callback, delay, ...args);
  return f_nativeSetInterval(callback, delay, ...args);
}

// 外部绑定：见 setTimeout。
export function clearInterval(handle) {
  if (f_clock) return f_clock.clearInterval(handle);
  return f_nativeClearInterval(handle);
}

// 外部绑定：Date 门面——静态 now 走虚拟时钟，new Date() / Date() 取虚拟当前时刻；其余
// 静态面（parse/UTC/…）、原型与 instanceof 链路保持原生。允许所有调用方使用。
export const Date = new Proxy(f_nativeDate, {
  get(target, property, receiver) {
    if (property === 'now') return f_clock ? () => f_clock.now : target.now;
    return Reflect.get(target, property, receiver);
  },
  construct(target, args) {
    if (f_clock && args.length === 0) return new f_nativeDate(f_clock.now);
    return Reflect.construct(target, args);
  },
  apply(target, thisArg, args) {
    if (f_clock && args.length === 0) return new f_nativeDate(f_clock.now).toISOString();
    return Reflect.apply(target, thisArg, args);
  },
});

// 测试专用方法：进入虚拟时钟世界。now 为起始纪元（缺省当前真实时刻）；重复调用保留既有时钟
// 与纪元，options 仅做校验不改写既有配置。仅测试代码可引用或调用，生产代码禁止使用。
export function t_mock(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('lite-timer.t_mock 需要 options 对象（可含 now 起始纪元）');
  }
  if (options.now !== undefined) f_epoch(options.now);
  if (f_clock) return liteTimer;
  f_clock = FakeTimers.createClock(f_epoch(options.now ?? f_nativeDate.now()));
  return liteTimer;
}

// 测试专用方法：卸载虚拟时钟。未触发定时器随时钟丢弃、不补触发；之后的绑定恢复原生透传。
// 幂等。仅测试代码可引用或调用，生产代码禁止使用。
export function t_unmock() {
  f_clock = null;
}

// 测试专用方法：推进虚拟时钟并派发到期回调（tickAsync 口径：回调间微任务沉淀）。仅 t_mock 后
// 可用；毫秒须为非负有限数值。仅测试代码可引用或调用，生产代码禁止使用。
export async function t_advanceMs(milliseconds) {
  if (!f_clock) throw new Error('lite-timer.t_advanceMs 需要 t_mock（当前为原生透传，无可推进时钟）');
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('lite-timer.t_advanceMs 的 milliseconds 应为非负有限数值');
  }
  await f_clock.tickAsync(milliseconds);
}

// 外部方法：当前时刻（虚拟或真实）。允许所有调用方使用。
export function now() {
  return f_clock ? f_clock.now : f_nativeDate.now();
}

const liteTimer = { t_mock, t_unmock, t_advanceMs, now, setTimeout, clearTimeout, setInterval, clearInterval, Date };
export default liteTimer;
