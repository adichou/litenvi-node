// 子进程依赖新鲜度 fixture：模块级计数器——每次 spawn 都是新进程新模块缓存，永远从 1 计数。
let count = 0;
export const bump = () => ++count;
