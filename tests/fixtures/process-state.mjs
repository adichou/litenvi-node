// 两个世界必须各自加载这个依赖，不能只给入口加查询参数。
let count = 0;
export const bump = () => ++count;
