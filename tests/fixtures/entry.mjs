// 最小主入口 fixture：environment 装配要求主入口可求值（本文件无副作用，仅证明加载边界通）。
// 被 VM 内调用的客户端模块见 storage-client.mjs（经 sideEntries 注入，返回面 exports.client）。
export const ready = true;
