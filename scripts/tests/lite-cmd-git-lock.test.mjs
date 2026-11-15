import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import { t_install } from '../lite-cmd-git.mjs';

const realRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
function f_setup() {
  t_install();
  liteFs.t_mock({ exclude: [realRoot] });
  liteFs.mkdirSync('/mock/repo', { recursive: true });
  liteChildProcess.t_mock();
  mgr.command('git').t_onRun(null);
  return () => { mgr.command('git').t_onRun(null); liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：扫描检查点同步重入写入，验证可选锁关闭前后产生不同的竞争结果。 */
test('扫描检查点能确定重叠写入并区分可选锁', () => {
  const done = f_setup();
  let remove;
  try {
    // 输入：内存卷初始化仓库并写入文件，status-scan 检查点观察重叠写入。
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init', '-b', 'main']).status, 0, 'git init 应成功');
    liteFs.writeFileSync(`${root}/a.txt`, 'content');
    const events = [];
    remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: event => {
      const writer = run(['add', '--', 'a.txt']);
      events.push({ ...event, writerStatus: writer.status, writerError: writer.stderr });
    } });
    const ordinary = run(['status', '--porcelain']);
    const optional = run(['--no-optional-locks', 'status', '--porcelain']);
    assert.equal(ordinary.status, 0, '正常扫描应完成');
    assert.equal(optional.status, 0, '关闭可选锁的扫描应完成');
    assert.equal(events.length, 2, '每次扫描恰好进入一次检查点');
    assert.equal(events[0].lockAcquired, true, '正例扫描应持锁');
    assert.equal(events[0].writerStatus, 128, '扫描持锁时重叠写入应失败');
    assert.match(events[0].writerError, /index\.lock.*File exists/, '写入失败应说明索引锁冲突');
    assert.equal(events[1].lockAcquired, false, '关闭可选锁的扫描不持锁');
    assert.equal(events[1].writerStatus, 0, '无可选锁时重叠写入应成功');
    assert.equal(liteFs.existsSync(`${root}/.git/index.lock`), false, '扫描结束应释放自有锁');
    assert.match(run(['status', '--porcelain']).stdout, /A  a\.txt/, '成功写入应更新暂存区');
  } finally { remove?.(); done(); }
});

/** 场景：外部持锁和扫描回调失败均不会删除不属于扫描的锁。 */
test('检查点失败时释放自有锁并保留外部锁', () => {
  const done = f_setup();
  let remove;
  try {
    // 输入：预置外部 index.lock 与自有锁两种形态，检查点回调抛异常。
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init']).status, 0, 'git init 应成功');
    liteFs.writeFileSync(`${root}/.git/index.lock`, '外部锁');
    remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: event => { assert.equal(event.lockAcquired, false, '外部锁形态下不应获锁'); throw new Error('检查点异常'); } });
    assert.notEqual(run(['status']).status, 0, '回调异常应明确失败');
    assert.equal(liteFs.readFileSync(`${root}/.git/index.lock`, 'utf8'), '外部锁', '不得删除或覆盖外部锁');
    remove();
    liteFs.unlinkSync(`${root}/.git/index.lock`);
    remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: event => { assert.equal(event.lockAcquired, true, '自有锁形态下应已获锁'); throw new Error('检查点异常'); } });
    assert.notEqual(run(['status']).status, 0, '回调异常应明确失败');
    assert.equal(liteFs.existsSync(`${root}/.git/index.lock`), false, '异常时应释放自有锁');
  } finally { remove?.(); done(); }
});

/** 场景：写入出错与关闭可选锁均不绕过写锁要求，异步命令沿用相同语义。 */
test('索引写锁在失败时释放且不受可选锁开关影响', async () => {
  const done = f_setup();
  try {
    // 输入：写入路径注入异常与可选锁开关两种形态，交替执行写命令。
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init']).status, 0, 'git init 应成功');
    liteFs.writeFileSync(`${root}/a.txt`, 'content');
    assert.notEqual(run(['add', '--', 'missing.txt']).status, 0, '无匹配路径应失败');
    assert.equal(liteFs.existsSync(`${root}/.git/index.lock`), false, '写入失败后应释放锁');
    liteFs.writeFileSync(`${root}/.git/index.lock`, '外部锁');
    const blocked = run(['--no-optional-locks', 'add', '--', 'a.txt']);
    assert.equal(blocked.status, 128, '关闭可选锁不能绕过写锁');
    assert.match(blocked.stderr, /index\.lock.*File exists/, '写锁冲突应明确报告');
    const child = liteChildProcess.spawn('git', ['add', '--', 'a.txt'], { cwd: root });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 128, signal: null }, '异步写入应同样被外部锁阻止');
    assert.match(stderr, /index\.lock.*File exists/, '异步命令应报告索引锁冲突');
    assert.equal(liteFs.readFileSync(`${root}/.git/index.lock`, 'utf8'), '外部锁', '不得删除其他写入的锁');
    liteFs.unlinkSync(`${root}/.git/index.lock`);
    assert.equal(run(['add', '--', 'a.txt']).status, 0, '外部锁移除后应可写入');
  } finally { done(); }
});

/** 场景：扫描观察器可撤销，参数错误不会留下监听器。 */
test('扫描检查点支持撤销并拒绝非法观察器', () => {
  const done = f_setup();
  try {
    // 输入：非法观察器参数与合法观察者的注册、撤销、重复撤销。
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', encoding: 'utf8' });
    assert.equal(run(['init']).status, 0, 'git init 应成功');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: null }), /onHit/, '非函数观察器应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: '', onHit() {} }), /checkpoint/, '空检查点应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'unknown', onHit() {} }), /不支持检查点/, '未知检查点应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ onHit() {} }), /checkpoint/, '观察器必须指定检查点');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit() {}, exit: 2 }), /不能与/, '检查点不能与故障混用');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit() {}, once: 'yes' }), /once/, 'once 应为布尔值');
    let count = 0;
    const remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: () => { count++; } });
    assert.equal(run(['status']).status, 0, '扫描应成功');
    remove();
    remove();
    assert.equal(run(['status']).status, 0, '扫描应成功');
    assert.equal(count, 1, '撤销后扫描不再调用观察器');
  } finally { done(); }
});

/** 场景：一次性扫描检查点仅在扫描到达时消费，重入扫描不会重复触发。 */
test('一次性检查点命中时消费并与写故障共存', () => {
  const done = f_setup();
  let removeScan, removeFault;
  try {
    // 输入：一次性扫描检查点与 add 写故障同时注册，交替执行各子命令。
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', encoding: 'utf8' });
    assert.equal(run(['init']).status, 0, 'git init 应成功');
    liteFs.writeFileSync('/mock/repo/a.txt', 'content');
    let hits = 0;
    removeScan = mgr.command('git').t_inject({ checkpoint: 'status-scan', once: true, onHit() {
      hits++;
      assert.equal(run(['status', '--porcelain']).status, 0, '观察器中可同步重入状态扫描');
    } });
    removeFault = mgr.command('git').t_inject({ subcommand: 'add', exit: 7 });
    assert.equal(run(['add', 'a.txt']).status, 7, '写故障应独立生效');
    assert.equal(hits, 0, '其他子命令不能消费扫描检查点');
    assert.equal(run(['status', '--porcelain']).status, 0, '扫描应成功');
    assert.equal(run(['status', '--porcelain']).status, 0, '扫描应成功');
    assert.equal(hits, 1, '一次性检查点应在首次命中时移除');
  } finally { removeScan?.(); removeFault?.(); done(); }
});
