import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProcessEnvironment } from '../environment.mjs';
import { Volume, createFsFromVolume } from 'memfs';
import { createSnapshotReader, applySnapshot } from '../memory-snapshot.mjs';
import { initialize, resolve } from '../native-guard.mjs';

const srcRoot = new URL('./fixtures/process-server.mjs', import.meta.url).pathname;
function boot(options = {}) {
  return buildProcessEnvironment({ srcRoot, projectRoot: '/app', initialData(fs) {
    fs.mkdirSync('/app', { recursive: true });
    fs.writeFileSync('/app/value', 'initial');
    fs.writeFileSync('/app/remove', 'remove');
  }, ...options });
}

test('process backend isolates ESM caches, memory files and fake clocks', async () => {
  const date = Date, timer = setTimeout;
  const first = await boot(), second = await boot();
  try {
    assert.notEqual(first.pid, second.pid, '每个世界必须使用不同进程');
    assert.equal(first.fs.writeFileSync, undefined, '父进程观测面不提供写通道');
    assert.equal(first.http.pendingCount(), 0, '初始无在途请求');
    const a = await first.http.request('GET', '/write');
    const b = await second.http.request('GET', '/');
    assert.equal(a.json.value, 'changed', '写请求应走真实 fs 替身');
    assert.equal(b.json.value, 'initial', '另一个世界不得串文件');
    assert.equal(a.json.count, 1, '首个世界应从独立依赖缓存开始');
    assert.equal(b.json.count, 1, '第二世界应重新加载整个依赖图');
    assert.equal(b.json.sameProcess, true, '进程模块与全局应指向同一替身');
    assert.equal(b.json.cwd, '/app', 'cwd 应来自隔离环境');
    assert.equal((await first.http.request('GET', '/process-write')).json.processValue, 'isolated', '进程替身应支持赋值后重读');
    assert.equal((await second.http.request('GET', '/')).json.processValue, undefined, '进程变量赋值不得跨世界');
    assert.equal(process.env.LITENVI_PROCESS_VALUE, undefined, '父进程环境不得受业务赋值影响');
    assert.equal(first.fs.exists('/app/remove'), false, '文件删除应同步');
    assert.equal(first.fs.readTextFile('/app/value'), 'changed', '父进程只读快照应同步写入');
    const before = second.clock.now;
    const pending = second.http.request('GET', '/timer');
    assert.equal(second.http.pendingCount(), 1, '请求发出后应计入在途数');
    // IPC 保序：refresh 在请求已挂上假时钟之后回传观测。
    await second.refresh();
    assert.equal(second.clock.countTimers(), 2, '业务 timer 与 HTTP 超时应都使用 FakeTimers');
    await second.clock.tickAsync(50);
    assert.equal((await pending).json.now, before + 50, '推进应完成异步 timer');
    assert.equal(second.fs.readTextFile('/app/tick'), String(before + 50), '推进后的业务写入应同步');
    assert.equal(first.clock.now, before, '假时钟不能跨世界推进');
    assert.equal(second.clock.countTimers(), 0, '完成后无残留 timer');
    const git = await first.http.request('GET', '/git');
    assert.equal(git.json.result.status, 0, 'Git 应复用既有内存替身');
    assert.deepEqual(first.git.log(), [], '查询 Git 不应产生提交');
    await first.http.injectFault({ path: '/', status: 503, once: true });
    assert.equal((await first.http.request('GET', '/')).status, 503, '故障应通过 IPC 注入');
    assert.equal((await first.http.request('GET', '/')).status, 200, '一次性故障后应恢复');
    await first.http.injectFault({ wait: Promise.resolve(), once: true });
    assert.equal((await first.http.request('GET', '/')).status, 200, 'promise wait 应经闸门放行且不破坏通信');
    await assert.rejects(first.http.injectFault({ path: '/', error: () => {} }), /could not be cloned/, '不可序列化的故障值应明确拒绝');
    assert.equal(Date, date, '父进程 Date 不受影响');
    assert.equal(setTimeout, timer, '父进程 timer 不受影响');
  } finally { await Promise.all([first.dispose(), second.dispose()]); }
  assert.equal(first.fs.exists('/app/value'), false, '释放后应销毁父进程快照');
  await assert.rejects(first.http.request('GET', '/'), /已关闭/, '销毁后的动作应拒绝');
  const once = first.dispose();
  assert.equal(first.dispose(), once, '重复销毁应复用同一 Promise');
  await once;
});

test('fault removal resolves to a disabler across the process boundary', async () => {
  const environment = await boot();
  try {
    const remove = await environment.http.injectFault({ path: '/', status: 503 });
    assert.equal(typeof remove, 'function', '注入应 resolve 出移除函数（与 VM 口径对齐）');
    assert.equal((await environment.http.request('GET', '/')).status, 503, '注入后故障应生效');
    await remove();
    assert.equal((await environment.http.request('GET', '/')).status, 200, '撤销后应恢复真实路由');
    await remove(); // 幂等撤销不得报错
  }
  finally { await environment.dispose(); }
});

test('startup failures and caught boundary violations cannot silently pass', async () => {
  await assert.rejects(buildProcessEnvironment(), /srcRoot/, '缺少入口应拒绝');
  await assert.rejects(boot({ timeoutMs: 0 }), /超时必须/, '通信预算必须为正');
  await assert.rejects(boot({ sideEntries: [] }), /尚未支持/, '不支持的装配选项必须拒绝');
  await assert.rejects(boot({ initialData() { throw new Error('seed'); } }), /seed/, '播种失败不得启动业务进程');
  await assert.rejects(boot({ srcRoot: new URL('./fixtures/process-failed.mjs', import.meta.url).pathname }), /startup failure/, '初始化异常应回传原始原因');
  await assert.rejects(boot({ srcRoot: new URL('./fixtures/process-denied.mjs', import.meta.url).pathname }), /未声明的环境模块/, '未注入模块应在原生加载边界阻断');
  for (const route of ['/deny', '/module-deny']) {
    const environment = await boot();
    try { await environment.http.request('GET', route); }
    finally { await assert.rejects(environment.dispose(), /不得有未声明/, '业务捕获的边界异常仍必须让收口报红'); }
    await assert.rejects(environment.dispose(), /不得有未声明/, '重复释放应保留首次清理失败');
  }
  // 原生虚拟 Node 子进程开放后 /spawn 不再是边界违规：合法 spawn（含入口缺失折算退出码 1）
  // 不得记入未声明调用，收口保持干净；spawn 语义细节由 process-child.test.mjs 覆盖。
  {
    const environment = await boot();
    await environment.http.request('GET', '/spawn');
    await environment.dispose();
  }
});

test('snapshot deltas preserve binary files, deletions and file-directory conversions', () => {
  const source = Volume.fromJSON({ '/a': Buffer.from([0, 255]), '/empty': null });
  const target = new Volume(), read = createSnapshotReader(source);
  applySnapshot(target, read());
  assert.deepEqual(target.readFileSync('/a'), Buffer.from([0, 255]), '快照必须保持二进制');
  assert.deepEqual(read(), { files: {}, deleted: [] }, '相同内容不应重复传输');
  source.writeFileSync('/a', Buffer.from([1, 255]));
  source.rmdirSync('/empty');
  source.writeFileSync('/empty', 'file');
  applySnapshot(target, read());
  assert.equal(target.readFileSync('/empty', 'utf8'), 'file', '空目录应能转换为文件');
  assert.deepEqual(target.readFileSync('/a'), Buffer.from([1, 255]), '同 inode 内容变化也应同步');
  source.unlinkSync('/a');
  source.mkdirSync('/a');
  applySnapshot(target, read());
  assert.ok(target.statSync('/a').isDirectory(), '文件应能转换为空目录');
  source.unlinkSync('/empty');
  applySnapshot(target, read());
  assert.equal(target.existsSync('/empty'), false, '删除应同步');
});

test('native loader guard checks declared builtins and source directory without transforming code', async () => {
  const messages = [];
  initialize({ root: 'file:///app/', allowed: ['node:fs'], port: { postMessage: message => messages.push(message) } });
  const next = async specifier => ({ url: specifier.startsWith('.') ? 'file:///app/child.mjs' : specifier });
  assert.deepEqual(await resolve('fs', { parentURL: 'file:///app/entry.mjs' }, next), { url: 'fs' }, '无前缀的内建模块也应归一白名单');
  assert.deepEqual(await resolve('./child.mjs', { parentURL: 'file:///app/entry.mjs' }, next), { url: 'file:///app/child.mjs' }, '源码目录内应正常解析');
  assert.deepEqual(await resolve('node:os', {}, next), { url: 'node:os' }, '非业务模块不受业务目录限制');
  assert.deepEqual(await resolve('node:os', { parentURL: 'file:///harness.mjs' }, next), { url: 'node:os' }, '测试基础设施可加载原生模块');
  await assert.rejects(resolve('node:os', { parentURL: 'file:///app/entry.mjs' }, next), /未声明/, '未知内建模块应阻断');
  await assert.rejects(resolve('file:///outside.mjs', { parentURL: 'file:///app/entry.mjs' }, next), /未声明/, '业务相对目录外模块应阻断');
  assert.equal(messages.length, 2, '两次违规都应记账');
});

test('disposal cancels an outstanding business timer request without waiting for virtual time', async () => {
  const environment = await boot();
  const pending = environment.http.request('GET', '/timer');
  const rejected = assert.rejects(pending, /请求取消/, '销毁必须取消在途请求');
  await environment.refresh();
  await environment.dispose();
  await rejected;
  assert.equal(environment.http.pendingCount(), 0, '清理后父进程无在途请求');
});

test('process backend exposes writable git channel for parent assembly hooks', async () => {
  const environment = await boot();
  try {
    await environment.git.run(['init', '-b', 'main']);
    await environment.git.run(['commit', '--only', '-m', 'chore: seed', '--', '/app/value']);
    assert.equal(environment.git.log().length, 1, '父进程经 IPC 执行的 git 命令应作用于子进程仓库');
    assert.ok(environment.git.log()[0].subject.includes('seed'), '提交主题应可观测');
  } finally { await environment.dispose(); }
});

test('process backend supports gated faults held until parent promise settles', async () => {
  const environment = await boot();
  try {
    const gate = Promise.withResolvers();
    environment.http.injectFault({ method: 'GET', path: '/', wait: gate.promise, once: true });
    const pending = environment.http.request('GET', '/');
    await environment.refresh();
    assert.equal(environment.http.pendingCount(), 1, '闸门未释放前匹配请求应挂起');
    gate.resolve();
    const response = await pending;
    assert.equal(response.status, 200, '释放后请求应穿透到真实服务端响应');
  } finally { await environment.dispose(); }
});


test('applySnapshot removes emptied parent directories of deleted files', async () => {
  const source = new Volume(), filesystem = createFsFromVolume(source);
  filesystem.mkdirSync('/proj/data/requirements/REQ-1', { recursive: true });
  filesystem.writeFileSync('/proj/data/requirements/REQ-1/README.md', 'x');
  const read = createSnapshotReader(source);
  applySnapshot(new Volume(), read());
  filesystem.rmSync('/proj/data/requirements/REQ-1', { recursive: true, force: true });
  const target = new Volume();
  applySnapshot(target, read());
  assert.equal(target.existsSync('/proj/data/requirements/REQ-1'), false, '删除后的空目录壳不应残留在父进程快照');
  assert.equal(target.existsSync('/proj/data/requirements/REQ-1/README.md'), false, '删除的文件不应残留');
});

test('snapshot sync removes implicit directories emptied by business deletes', async () => {
  const source = new Volume(), filesystem = createFsFromVolume(source);
  const seed = new Volume();
  seed.mkdirSync('/proj/agent-team-board/data/requirements/REQ-1', { recursive: true });
  seed.writeFileSync('/proj/agent-team-board/data/requirements/REQ-1/README.md', 'x');
  seed.mkdirSync('/proj/agent-team-board/runtime/status', { recursive: true });
  seed.writeFileSync('/proj/agent-team-board/runtime/status/REQ-1.json', '{}');
  seed.writeFileSync('/proj/agent-team-board/runtime/config.json', '{}');
  source.fromJSON(seed.toJSON());
  const read = createSnapshotReader(source);
  const target = new Volume();
  applySnapshot(target, read());
  assert.equal(target.existsSync('/proj/agent-team-board/data/requirements/REQ-1'), true, '种子阶段目录应建立');
  filesystem.rmSync('/proj/agent-team-board/data/requirements/REQ-1', { recursive: true, force: true });
  filesystem.unlinkSync('/proj/agent-team-board/runtime/status/REQ-1.json');
  applySnapshot(target, read());
  assert.equal(target.existsSync('/proj/agent-team-board/data/requirements/REQ-1'), false, '业务删除目录后父进程快照不应残留空壳（隐式目录）');
  assert.equal(target.existsSync('/proj/agent-team-board/runtime/status/REQ-1.json'), false, '删除的状态文件不应残留');
});

test('process backend injects non-gated faults via plain IPC path', async () => {
  const environment = await boot();
  try {
    await environment.http.injectFault({ method: 'GET', path: '/', status: 503, body: { error: 'plain' }, once: true });
    assert.equal((await environment.http.request('GET', '/')).status, 503, '普通状态故障应即时生效');
    assert.equal((await environment.http.request('GET', '/')).status, 200, '一次性故障后应恢复');
  } finally { await environment.dispose(); }
});

test('process backend swallows release failures after disposal (gate resolves late)', async () => {
  const environment = await boot();
  const gate = Promise.withResolvers();
  await environment.http.injectFault({ method: 'GET', path: '/', wait: gate.promise, once: true });
  await environment.dispose();
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(environment.http.pendingCount(), 0, '释放后不应残留父进程在途计数');
});
