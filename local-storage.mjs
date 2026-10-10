// 跨项目 localStorage 内存替身与只读视图：environment 注入 VM 全局的键值偏好记忆通道。
// 替身（createLocalStorageMock().mock）注入 VM 供前端代码直连读写（浏览器同构 API）；
// 只读视图（createLocalStorageView）经返回面暴露给用例断言——写世界的入口只有被测业务
// 自身（与 fs / git 观测面同一口径）。存储为内存 Map 实现，随环境销毁，不跨环境共享。
export function createLocalStorageMock() {
  const store = new Map();
  return {
    mock: {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); },
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    view: createLocalStorageView(store),
    store,
  };
}

// 只读视图：只暴露读方法（Object.freeze 防篡改/扩充）；键与值均按 String 化存取（对齐
// 浏览器 localStorage 语义——只能存字符串，取不到的键返回 null）。
export function createLocalStorageView(store) {
  return Object.freeze({
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
    key(i) { return [...store.keys()][i] ?? null; },
    get length() { return store.size; },
  });
}
