// 跨项目只读 fs 视图：environment 暴露给用例的内存文件系统查询对象工厂。
// 只暴露读方法（Object.freeze 防篡改/扩充）；写世界的入口只有 environment 装配期的
// initialData 回调与被测业务自身（VM 内注入的 node:fs）。
// filesystem 为 memfs 实例（任意实现 readdirSync / readFileSync / existsSync 的对象均可）。
export function createFsView(filesystem) {
  return Object.freeze({
    readTextFile(absolutePath) { return filesystem.readFileSync(absolutePath, 'utf8'); },
    listDir(absolutePath) { return filesystem.readdirSync(absolutePath); },
    exists(absolutePath) { return filesystem.existsSync(absolutePath); },
  });
}
