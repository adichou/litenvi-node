import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import * as gitModule from '../lite-cmd-git.mjs';

const realRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const config = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid', '-c', 'commit.gpgSign=false'];

function setup() {
  gitModule.t_install();
  liteFs.t_mock({ exclude: [realRoot] });
  liteFs.mkdirSync('/mock/repo', { recursive: true });
  liteChildProcess.t_mock();
  mgr.command('git').t_onRun(null);
  return () => { mgr.command('git').t_onRun(null); liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：真实 Git 与内存 Git 在已有索引锁时读取和写入的行为一致。 */
test('真实 Git 对照：索引锁阻止写入但不阻止状态读取', () => {
  const temp = nativeFs.realpathSync(nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-index-lock-')));
  function scenario(root, filesystem, execute) {
    const run = args => execute([...config, ...args]);
    assert.equal(run(['init', '-q', '-b', 'main']).status, 0);
    filesystem.writeFileSync(`${root}/a.txt`, 'before\n');
    assert.equal(run(['add', '--', 'a.txt']).status, 0);
    assert.equal(run(['commit', '-q', '-m', 'baseline']).status, 0);
    filesystem.writeFileSync(`${root}/a.txt`, 'after\n');
    filesystem.writeFileSync(`${root}/.git/index.lock`, '其他写入持锁');
    const regular = run(['status', '--porcelain']);
    const optional = run(['--no-optional-locks', 'status', '--porcelain']);
    const add = run(['add', '--', 'a.txt']);
    const commit = run(['commit', '-m', 'blocked']);
    const unchanged = filesystem.readFileSync(`${root}/.git/index.lock`, 'utf8');
    filesystem.unlinkSync(`${root}/.git/index.lock`);
    const after = run(['status', '--porcelain']);
    return { regular: [regular.status, regular.stdout], optional: [optional.status, optional.stdout],
      add: [add.status, /index\.lock.*File exists/.test(add.stderr)],
      commit: [commit.status, /index\.lock.*File exists/.test(commit.stderr)], unchanged,
      after: [after.status, after.stdout] };
  }
  try {
    const expected = scenario(temp, nativeFs, args => nativeSpawnSync('git', args, { cwd: temp, env, encoding: 'utf8' }));
    const done = setup();
    try {
      const actual = scenario('/mock/repo', liteFs, args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', env, encoding: 'utf8' }));
      assert.deepEqual(actual, expected, '持锁时读写结果、索引和锁文件应与真实 Git 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temp, { recursive: true, force: true }); }
});

/** 场景：扫描检查点同步重入写入，验证可选锁关闭前后产生不同的竞争结果。 */
test('扫描检查点能确定重叠写入并区分可选锁', () => {
  const done = setup();
  let remove;
  try {
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init', '-b', 'main']).status, 0);
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
  const done = setup();
  let remove;
  try {
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init']).status, 0);
    liteFs.writeFileSync(`${root}/.git/index.lock`, '外部锁');
    remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: event => { assert.equal(event.lockAcquired, false); throw new Error('检查点异常'); } });
    assert.notEqual(run(['status']).status, 0, '回调异常应明确失败');
    assert.equal(liteFs.readFileSync(`${root}/.git/index.lock`, 'utf8'), '外部锁', '不得删除或覆盖外部锁');
    remove();
    liteFs.unlinkSync(`${root}/.git/index.lock`);
    remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: event => { assert.equal(event.lockAcquired, true); throw new Error('检查点异常'); } });
    assert.notEqual(run(['status']).status, 0, '回调异常应明确失败');
    assert.equal(liteFs.existsSync(`${root}/.git/index.lock`), false, '异常时应释放自有锁');
  } finally { remove?.(); done(); }
});

/** 场景：写入出错与关闭可选锁均不绕过写锁要求，异步命令沿用相同语义。 */
test('索引写锁在失败时释放且不受可选锁开关影响', async () => {
  const done = setup();
  try {
    const root = '/mock/repo';
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init']).status, 0);
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
  const done = setup();
  try {
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', encoding: 'utf8' });
    assert.equal(run(['init']).status, 0);
    assert.equal(gitModule.onStatusScan, undefined, 'Git 模块不得公开扫描方法');
    assert.equal(typeof gitModule.pkg_onStatusScan, 'function', 'Git 扫描注册方法应为包内接口');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: null }), /onHit/, '非函数观察器应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: '', onHit() {} }), /checkpoint/, '空检查点应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'unknown', onHit() {} }), /不支持检查点/, '未知检查点应拒绝');
    assert.throws(() => mgr.command('git').t_inject({ onHit() {} }), /checkpoint/, '观察器必须指定检查点');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit() {}, exit: 2 }), /不能与/, '检查点不能与故障混用');
    assert.throws(() => mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit() {}, once: 'yes' }), /once/, 'once 应为布尔值');
    let count = 0;
    const remove = mgr.command('git').t_inject({ checkpoint: 'status-scan', onHit: () => { count++; } });
    assert.equal(run(['status']).status, 0);
    remove();
    remove();
    assert.equal(run(['status']).status, 0);
    assert.equal(count, 1, '撤销后扫描不再调用观察器');
  } finally { done(); }
});

/** 场景：一次性扫描检查点仅在扫描到达时消费，重入扫描不会重复触发。 */
test('一次性检查点命中时消费并与写故障共存', () => {
  const done = setup();
  let removeScan, removeFault;
  try {
    const run = args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', encoding: 'utf8' });
    assert.equal(run(['init']).status, 0);
    liteFs.writeFileSync('/mock/repo/a.txt', 'content');
    let hits = 0;
    removeScan = mgr.command('git').t_inject({ checkpoint: 'status-scan', once: true, onHit() {
      hits++;
      assert.equal(run(['status', '--porcelain']).status, 0, '观察器中可同步重入状态扫描');
    } });
    removeFault = mgr.command('git').t_inject({ subcommand: 'add', exit: 7 });
    assert.equal(run(['add', 'a.txt']).status, 7, '写故障应独立生效');
    assert.equal(hits, 0, '其他子命令不能消费扫描检查点');
    assert.equal(run(['status', '--porcelain']).status, 0);
    assert.equal(run(['status', '--porcelain']).status, 0);
    assert.equal(hits, 1, '一次性检查点应在首次命中时移除');
  } finally { removeScan?.(); removeFault?.(); done(); }
});
