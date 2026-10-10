// localStorage 替身客户端 fixture：在 VM 内直连全局 localStorage 读写的最小模块，
// 供 environment 用例经 sideEntries 加载，验证替身注入与观测面联通。
export function save(key, value) {
  localStorage.setItem(key, value);
}

export function load(key) {
  return localStorage.getItem(key);
}

export function remove(key) {
  localStorage.removeItem(key);
}

export function nowIso() {
  return new Date().toISOString();
}

// 未声明环境调用探针：process.exit 在环境内被 deny（记账 + 抛错）。
export function boom() {
  process.exit(1);
}
