// localStorage / sessionStorage 替身客户端 fixture：在 VM 内直连全局两条键值存储通道读写
// 的最小模块，供 environment 用例经 sideEntries 加载，验证替身注入与观测面联通。
export function save(key, value) {
  localStorage.setItem(key, value);
}

export function load(key) {
  return localStorage.getItem(key);
}

export function remove(key) {
  localStorage.removeItem(key);
}

export function sessionSave(key, value) {
  sessionStorage.setItem(key, value);
}

export function sessionLoad(key) {
  return sessionStorage.getItem(key);
}

export function windowIsSessionChannel() {
  return typeof window !== 'undefined' && window.sessionStorage === sessionStorage;
}

export function nowIso() {
  return new Date().toISOString();
}

// 未声明环境调用探针：process.exit 在环境内被 deny（记账 + 抛错）。
export function boom() {
  process.exit(1);
}
