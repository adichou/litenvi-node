// sourceURL 归属探针（真实磁盘模块）：模块加载时捕获自身调用栈命名——经 lite-cmd-eslint
// 迷你加载器以真实路径 import 时，栈帧以 //# sourceURL 注入的真实源码路径命名；诊断消息
// 把首帧文本带出供用例断言归属。仅测试使用，零业务语义。
const frame = String(new Error().stack || '').split('\n')[1] || '';

export default {
  meta: { schema: [] },
  create(context) {
    return {
      Program(node) { context.report({ node, message: `probe-frame:${frame}` }); },
    };
  },
};
