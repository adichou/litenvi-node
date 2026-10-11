// Storage 接口的跨项目内存替身与只读视图：environment 注入 VM 全局的键值存储通道，
// localStorage 与 sessionStorage 共用同一实现（浏览器中两者本就是同一 Storage 接口的
// 两个实例，行为差异只在生命周期/作用域——内存替身内不可观测，无需分化代码）。
// 替身（createStorageMock().mock）注入 VM 供前端代码直连读写（浏览器同构 API）；只读
// 视图（createStorageView）经返回面暴露给用例断言——写世界的入口只有被测业务自身
// （与 fs / git 观测面同一口径）。每次调用返回独立实例（独立存储空间，通道互不串扰）；
// 存储为内存 Map 实现，随环境销毁，不跨环境共享。
export function createStorageMock() {
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
    view: createStorageView(store),
    store,
  };
}

// 只读视图：只暴露读方法（Object.freeze 防篡改/扩充）；键与值均按 String 化存取（对齐
// 浏览器 Storage 语义——只能存字符串，取不到的键返回 null）。
export function createStorageView(store) {
  return Object.freeze({
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
    key(i) { return [...store.keys()][i] ?? null; },
    get length() { return store.size; },
  });
}
