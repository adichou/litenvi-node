// localStorage 替身与只读视图单测（模块对外方法直测，不依赖 VM 装配）：
// 替身读写 / String 化语义 / 删除清空 / 键序与长度；只读视图与替身联动、无写方法、防扩充。
import assert from 'node:assert/strict';
import { createLocalStorageMock, createLocalStorageView } from '../local-storage.mjs';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('替身读写：setItem/getItem 读回；未设键返回 null；键与值按 String 化存取', () => {
  const { mock } = createLocalStorageMock();
  mock.setItem('k', 'v');
  assert.equal(mock.getItem('k'), 'v', '已设键应读回同值');
  assert.equal(mock.getItem('missing'), null, '未设键应返回 null（对齐浏览器语义）');
  mock.setItem(1, 123);
  assert.equal(mock.getItem('1'), '123', '键与值应 String 化（浏览器只能存字符串）');
  assert.equal(mock.getItem(1), '123', '数字键按 String 化读取');
});

t('删除与清空：removeItem 移除单键；clear 全清；key(i) 与 length 随动', () => {
  const { mock } = createLocalStorageMock();
  mock.setItem('a', '1');
  mock.setItem('b', '2');
  assert.equal(mock.length, 2, '两条记录长度为 2');
  assert.equal(mock.key(0), 'a', 'key(0) 应返回首个键');
  mock.removeItem('a');
  assert.equal(mock.getItem('a'), null, 'removeItem 后应读不到');
  assert.equal(mock.length, 1, '移除后长度应递减');
  mock.clear();
  assert.equal(mock.length, 0, 'clear 后长度归零');
  assert.equal(mock.key(0), null, '清空后 key(0) 返回 null');
});

t('只读视图：与替身同源联动；不暴露写方法；冻结防扩充', () => {
  const { mock, view } = createLocalStorageMock();
  mock.setItem('k', 'v');
  assert.equal(view.getItem('k'), 'v', '视图应与替身同源读通');
  assert.equal(view.length, 1, '视图 length 应与替身一致');
  for (const method of ['setItem', 'removeItem', 'clear']) {
    assert.equal(view[method], undefined, `视图不得暴露写方法 ${method}（写世界入口仅被测业务自身）`);
  }
  assert.equal(Object.isFrozen(view), true, '视图应冻结防扩充');

  const standalone = createLocalStorageView(new Map([['x', 'y']]));
  assert.equal(standalone.getItem('x'), 'y', '视图工厂可独立包裹任意 Map 存储');
  assert.equal(standalone.length, 1, '独立视图长度正确');
});

const failures = cases.reduce((n, [name, fn]) => {
  try {
    fn();
    console.log(`✓ ${name}`);
    return n;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    return n + 1;
  }
}, 0);
if (failures) {
  console.error(`\n${cases.length} 个用例，失败 ${failures}`);
  process.exit(1);
}
console.log(`\n全部通过：${cases.length} 用例`);
