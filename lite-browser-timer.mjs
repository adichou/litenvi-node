// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// 浏览器端信号和周期定时门面：业务显式导入，不改写页面全局。
// t_mock 同时挂起超时信号和周期定时，不支持选择性 Mock。
// interval gate 接管已通过门面注册的原生周期，并挂起后续注册；t_tickIntervals 推进一轮。
// t_unmock 取消在途信号、丢弃 gate 周期，之后的新调用恢复原生行为。
const f_nativeAbortSignal = globalThis.AbortSignal;
const f_nativeAbortController = globalThis.AbortController;
const f_nativeTimeout = f_nativeAbortSignal?.timeout?.bind(f_nativeAbortSignal);
const f_nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const f_nativeClearInterval = globalThis.clearInterval?.bind(globalThis);
let f_pending = null;
let f_intervalSeq = 0;
const f_intervals = new Map();

// 私有方法：仅在本文件解析 timeout 的浏览器参数；遵循 Web IDL EnforceRange 的数值转换。
function f_timeout(milliseconds) {
  if (!f_pending) return f_nativeTimeout(milliseconds);
  const delay = Math.trunc(+milliseconds);
  if (!Number.isFinite(delay) || delay < 0 || delay >= 2 ** 64) {
    throw new TypeError('AbortSignal.timeout 的 milliseconds 超出有效范围');
  }
  const controller = new f_nativeAbortController();
  f_pending.add(controller);
  return controller.signal;
}

// 私有方法：先摘除当前批次，再发送原生取消事件；事件中新建的信号留给下一批处理。
function f_abortPending(pending, reason) {
  const controllers = [...pending];
  pending.clear();
  for (const controller of controllers) controller.abort(reason);
}

// 外部变量：稳定的信号门面；默认和 t_mock 均保留原生原型及其他静态 API，允许所有调用方使用。
export const AbortSignal = f_nativeAbortSignal && new Proxy(f_nativeAbortSignal, {
  get(target, property, receiver) {
    if (property === 'timeout') return f_pending || f_nativeTimeout ? f_timeout : undefined;
    return Reflect.get(target, property, receiver);
  },
});

// 外部方法：默认返回原生句柄；gate 期间只登记回调，使用负数句柄避免与浏览器原生句柄冲突。
export function setInterval(callback, delay, ...args) {
  if (f_pending && typeof callback !== 'function') throw new TypeError('interval gate 需要函数回调');
  const native = f_pending ? null : f_nativeSetInterval(callback, delay, ...args);
  const id = native ?? --f_intervalSeq;
  f_intervals.set(id, { callback, args, native });
  return id;
}

// 外部方法：原始句柄在启用 gate 后仍可用于清除；不属于门面的句柄转交原生处理。
export function clearInterval(id) {
  const entry = f_intervals.get(id);
  f_intervals.delete(id);
  if (entry?.native === null) return;
  return f_nativeClearInterval(id);
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_mock(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || (options.mode !== undefined && options.mode !== 'gate')) {
    throw new TypeError('lite-browser-timer.t_mock 仅支持 gate 模式');
  }
  if ('signals' in options || 'intervals' in options) {
    throw new TypeError('lite-browser-timer.t_mock 不支持 signals/intervals 选项，信号与周期定时统一启用');
  }
  if (!f_nativeAbortSignal || !f_nativeAbortController) {
    throw new TypeError('lite-browser-timer.t_mock 需要原生 AbortSignal 和 AbortController');
  }
  if (!f_nativeSetInterval || !f_nativeClearInterval) throw new TypeError('interval gate 需要原生 setInterval 和 clearInterval');
  if (!f_pending) {
    for (const entry of f_intervals.values()) {
      f_nativeClearInterval(entry.native);
      entry.native = null;
    }
    f_pending = new Set();
  }
  return liteBrowserTimer;
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_unmock() {
  if (!f_pending) return;
  const pending = f_pending;
  f_pending = null;
  f_intervals.clear();
  f_abortPending(pending, new DOMException('The operation was aborted.', 'AbortError'));
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_fireSingalTimeout() {
  if (f_pending) f_abortPending(f_pending, new DOMException('The operation timed out.', 'TimeoutError'));
}

// 测试专用方法：推进当前批次并等待全部回调完成，再传播执行错误；新增周期留给下一轮。
export async function t_tickIntervals() {
  if (!f_pending) throw new Error('t_tickIntervals 需要 t_mock()');
  const results = await Promise.allSettled([...f_intervals].map(async ([id, entry]) => {
    if (f_pending && f_intervals.get(id) === entry) await Reflect.apply(entry.callback, globalThis, entry.args);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

const liteBrowserTimer = { AbortSignal, setInterval, clearInterval, t_mock, t_unmock, t_fireSingalTimeout, t_tickIntervals };
export default liteBrowserTimer;
