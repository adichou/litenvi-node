// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// 浏览器端信号门面：业务显式导入 AbortSignal 或默认对象的 AbortSignal，不改写页面全局。
// 默认透传原生实现；t_mock 后仅 timeout 使用 gate，t_triggerSignalTimeout 触发当前批次。
// t_unmock 以 AbortError 清理仍挂起的 t_mock 信号，之后新建的信号恢复原生行为。
const f_nativeAbortSignal = globalThis.AbortSignal;
const f_nativeAbortController = globalThis.AbortController;
const f_nativeTimeout = f_nativeAbortSignal?.timeout?.bind(f_nativeAbortSignal);
let f_pending = null;

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

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_mock(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || (options.mode !== undefined && options.mode !== 'gate')) {
    throw new TypeError('lite-browser-timer.t_mock 仅支持 gate 模式');
  }
  if (!f_nativeAbortSignal || !f_nativeAbortController) {
    throw new TypeError('lite-browser-timer.t_mock 需要原生 AbortSignal 和 AbortController');
  }
  f_pending ??= new Set();
  return liteBrowserTimer;
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_unmock() {
  if (!f_pending) return;
  const pending = f_pending;
  f_pending = null;
  f_abortPending(pending, new DOMException('The operation was aborted.', 'AbortError'));
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
export function t_triggerSignalTimeout() {
  if (f_pending) f_abortPending(f_pending, new DOMException('The operation timed out.', 'TimeoutError'));
}

const liteBrowserTimer = { AbortSignal, t_mock, t_unmock, t_triggerSignalTimeout };
export default liteBrowserTimer;
