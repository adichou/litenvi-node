// buildMockEnvironment 通用面用例：Storage 双通道（localStorage / sessionStorage）注入与只读
// 观测、时钟冻结、跨环境隔离、未声明调用记账（deny）与环境收口、fs 只读视图联通。
// 项目无关——只测环境自身能力。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMockEnvironment } from '../environment.mjs';
import { runCases } from './run-cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(here, 'fixtures', 'storage-client.mjs');
const entryFile = path.join(here, 'fixtures', 'entry.mjs');

// sideEntries 装配：storage-client 在 VM 内直连全局 localStorage，供注入与观测面用例调用。
// 主入口与 sideEntries 不得为同一文件（VM 模块只可 link 一次）。
function boot({ now } = {}) {
  return buildMockEnvironment({
    srcRoot: entryFile,
    projectRoot: '/mock/project',
    now,
    sideEntries: [{ key: 'client', file: clientFile }],
    initialData: (filesystem) => {
      filesystem.mkdirSync('/mock/project/notes', { recursive: true });
      filesystem.writeFileSync('/mock/project/notes/readme.txt', 'hello litenvi');
    },
  });
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('localStorage 注入与只读观测：VM 内写入经观测面读回；视图不暴露写方法', async () => {
  const environment = await boot();
  try {
    assert.equal(environment.exports.client.load('k'), null, '初始无记忆');
    environment.exports.client.save('k', 'v');
    assert.equal(environment.exports.client.load('k'), 'v', 'VM 内写入应同源读回');
    assert.equal(environment.localStorage.getItem('k'), 'v', '观测面应读回业务写入的记忆');
    assert.equal(environment.localStorage.length, 1, '观测面长度应与写入数一致');
    assert.equal(environment.localStorage.setItem, undefined, '观测面不得暴露写方法（写通道仅被测业务自身）');
    assert.equal(Object.isFrozen(environment.localStorage), true, '观测面应冻结');
  } finally {
    await environment.dispose();
  }
  console.log('✓ localStorage 注入与只读观测：写入读回、视图无写方法');
});

t('removeItem 与跨环境隔离：删除后读不到；第二个环境不共享记忆', async () => {
  const first = await boot();
  try {
    first.exports.client.save('k', 'v');
    assert.equal(first.localStorage.getItem('k'), 'v');
    first.exports.client.remove('k');
    assert.equal(first.localStorage.getItem('k'), null, '删除后应读不到');

    const second = await boot();
    try {
      assert.equal(second.localStorage.getItem('k'), null, '记忆不跨环境共享（随环境销毁）');
      assert.equal(second.exports.client.load('k'), null, 'VM 内同样读不到他环境记忆');
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
  console.log('✓ removeItem 与跨环境隔离：删除生效、记忆不串环境');
});

t('sessionStorage 注入与双通道隔离：VM 内读写独立于 localStorage；观测面同口径只读', async () => {
  const environment = await boot();
  try {
    environment.exports.client.save('k', 'local-v');
    environment.exports.client.sessionSave('k', 'session-v');
    assert.equal(environment.exports.client.sessionLoad('k'), 'session-v', 'VM 内会话通道应独立读回');
    assert.equal(environment.exports.client.load('k'), 'local-v', '本地通道不受会话通道写入影响');
    assert.equal(environment.sessionStorage.getItem('k'), 'session-v', '会话观测面应读回业务写入');
    assert.equal(environment.sessionStorage.length, 1, '会话观测面长度应与写入数一致');
    assert.equal(environment.sessionStorage.setItem, undefined, '观测面不得暴露写方法（写通道仅被测业务自身）');
    assert.equal(Object.isFrozen(environment.sessionStorage), true, '观测面应冻结');
    assert.notEqual(environment.localStorage.getItem('k'), 'session-v', '两通道不得串写');
    assert.equal(environment.exports.client.windowIsSessionChannel(), true, 'window 应为 VM 全局自引用（浏览器同构）');
  } finally {
    await environment.dispose();
  }
  console.log('✓ sessionStorage 注入与双通道隔离：独立读写、观测面只读');
});

t('时钟冻结：VM 内 Date 固定为注入的 now；fs 只读视图读回装配期文件', async () => {
  const now = '2020-01-02T03:04:05.000Z';
  const environment = await boot({ now });
  try {
    assert.equal(environment.exports.client.nowIso(), now, 'VM 内 Date 应冻结为注入时刻');
    assert.equal(environment.fs.exists('/mock/project/notes/readme.txt'), true, '装配期文件应对 fs 视图可见');
    assert.equal(environment.fs.readTextFile('/mock/project/notes/readme.txt'), 'hello litenvi', 'fs 视图应读回文件内容');
  } finally {
    await environment.dispose();
  }
  console.log('✓ 时钟冻结与 fs 视图：Date 固定、装配期文件可读');
});

t('未声明调用记账与环境收口：deny 进 unexpected，dispose 自动拒绝通过', async () => {
  const environment = await boot();
  let threw = false;
  try {
    environment.exports.client.boom(); // process.exit 在环境内被 deny：同步抛错并记账
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'deny 探针应抛错并记账');
  await assert.rejects(
    () => environment.dispose(),
    /不得有未声明的环境调用/,
    '收口应因未声明调用自动红（用例无须显式断言 unexpected）',
  );
  console.log('✓ 未声明调用记账与收口：deny 记账、dispose 自动红');
});

const failures = cases.reduce((n, [name, fn]) => {
  try {
    fn();
    console.log(`✓ ${name}`);
    return n;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.stack || e.message}`);
    return n + 1;
  }
}, 0);
if (failures) {
  console.error(`\n${cases.length} 个用例，失败 ${failures}`);
  process.exit(1);
}
console.log(`\n全部通过：${cases.length} 用例`);
