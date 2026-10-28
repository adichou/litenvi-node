// lite-command：内存命令实现的注册表与分派器——lite-spawn mock 后，(command, args) 分派
// 到此处执行。命令集（lite-command-node / lite-command-git / lite-command-macos …）在导入
// 时自注册：impl 形如 { run(args, options, child, call)?, runSync(args, options, call)? }——
// run 服务异步 spawn（驱动子进程事件面），runSync 服务 spawnSync（返回同步结果对象面）。
// 命令集可桥接其他 lite-xx 门面（如 ls → lite-fs 内存卷、git → lite-command-git 的账本
// 语义）。注册表为模块级单例；命令按全名精确匹配，绝对路径命令按 basename 兜底
//（/usr/bin/open 与 open 命中同一实现）。
const registry = new Map(); // command → impl

export function register(name, impl) {
    registry.set(String(name), impl);
    return () => registry.delete(String(name));
}

// 命令名解析：全名精确优先，绝对路径形态按末段 basename 兜底；未注册返回 null
export function implOf(command) {
    const name = String(command ?? '');
    return registry.get(name) ?? registry.get(name.split('/').pop()) ?? null;
}

export function registered() { return [...registry.keys()]; }

export default { register, implOf, registered };
