// lite-cmd-git 门面用例（node:test 形态，可 `node --test` 或直跑）：git 命令集——导入即向
// lite-cmd-mgr 登记（/mock-cmd/usr/bin/git）；执行入口经 lite-child_process.spawnSync('git',
// argv, options) 分派到达：调用统一记在 liteChildProcess.calls()，回包经 onRun 钩子注入
//（mgr.command('git').onRun 安装；返回 { status, stdout, stderr } 浅合并覆盖默认）、钩子返回
// undefined 视为未命中——回落内置 mini-git 真实语义（未装钩子同口径）。运行账本与清理
// 统一归 lite-child_process。内置 mini-git：仓库模型落在 lite-fs 内存卷的
// <cwd>/.git/ 下（HEAD/refs/heads/objects/index.json，对象 = 类型行 + blob 原始内容或
// commit/tree JSON），提供 init/add/commit/status/log/rev-parse/rev-list/branch/switch/
// checkout/merge-base/ls-files/symbolic-ref/show/diff 等命令；写命令核对返回值与实际状态变化。
// mgr 仅用于配置测试钩子；命令执行统一
// 经 liteChildProcess.spawn/spawnSync，断言依据子进程结果、调用记录与文件系统状态。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteChildProcess from '../lite-child_process.mjs';
import '../lite-cmd-git.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';
import nativeFs from 'node:fs';
import os from 'node:os';

// 逐用例装配：mock 内存卷 + spawn 边界（git 执行唯一入口——新架构执行寻址须卷内 /mock-cmd
// 系统卷）；收尾卸载子进程运行态并摘除钩子。卷排除本仓库根（真实文件不落卷）
const REAL_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
function setup() {
  liteFs.mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteFs.mkdirSync('/mock/root', { recursive: true });
  liteFs.mkdirSync('/mock/elsewhere', { recursive: true });
  liteChildProcess.mock();
  mgr.command('git').onRun(null);
  return () => {
    mgr.command('git').onRun(null);
    liteChildProcess.unmock();
    liteFs.unmock();
  };
}

// Git 执行器：复用内存卷并固定 cwd，每次调用均经 liteChildProcess.spawnSync 执行；
// 卷随用例丢弃（setup 收尾统一 unmock），跨用例仓库自然消失
function volumeGit(cwd) {
  liteFs.mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync(cwd, { recursive: true });
  return (argv) => liteChildProcess.spawnSync('git', argv, { cwd, encoding: 'utf8' });
}
const write = (root, rel, text) => {
  liteFs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  liteFs.writeFileSync(path.join(root, ...rel.split('/')), text);
};

/** 场景：同一组操作分别交给真实 Git 与内存 Git，对比返回字段与工作树效果。 */
test('真实 Git 对照：错误输出、分支切换、引用、写命令与退出码', () => {
  // 输入：隔离作者配置、签名与 hooks，在真实临时仓库重放同一组命令
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-git-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const globalArgs = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '/repo').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>');
    const run = (args, fields = ['status', 'stdout', 'stderr'], cwd = root) => {
      const result = liteChildProcess.spawnSync('git', [...globalArgs, ...args], { cwd, env, encoding: 'utf8' });
      responses.push({ command: args[0], ...Object.fromEntries(fields.map(field =>
        [field, typeof result[field] === 'string' ? normalize(result[field]) : result[field]])) });
      return result;
    };
    run(['init', '-q', '-b', 'main']);
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    run(['add', 'a.txt']);
    run(['commit', '-q', '-m', 'baseline']);
    run(['commit', '-q', '-m', 'empty']);
    run(['symbolic-ref', 'HEAD']);
    run(['tag', 'v1']);
    run(['for-each-ref', 'refs/tags', '--format=%(refname:short)%09%(objectname)%09%(*objectname)']);
    run(['branch', 'dev']);
    run(['switch', '-q', 'dev']);
    fileSystem.writeFileSync(path.join(root, 'd.txt'), 'd\n');
    run(['add', 'd.txt']);
    run(['commit', '-q', '-m', 'dev']);
    run(['switch', '-q', 'main']);
    responses.push({ fileExistsAfterSwitch: fileSystem.existsSync(path.join(root, 'd.txt')) });
    run(['merge-base', 'main', 'dev']);
    const sha = run(['rev-parse', 'HEAD']).stdout.trim();
    run(['checkout', '-q', sha]);
    run(['symbolic-ref', '--short', 'HEAD']);
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    run(['checkout', '-q', 'main']);
    run(['merge', '--no-ff', '-m', 'merge', sha]);
    run(['cherry-pick', '-x', sha]);
    run(['reset', '--hard']);
    run(['push', 'origin', 'main']);
    run(['worktree', 'add', `${root}/linked`, 'main']);
    run(['worktree', 'remove', '--force', `${root}/linked`]);
    // revert 的摘要包含提交时间与行统计，另以状态、文件和历史验证其副作用。
    run(['revert', 'HEAD'], ['status', 'stderr']);
    responses.push({ fileExistsAfterRevert: fileSystem.existsSync(path.join(root, 'a.txt')) });
    run(['rev-list', '--count', 'HEAD']);
    run(['stash']);
    // 输入：在另一个已存在分支建立工作树，提交后从主工作树查询共享引用
    run(['tag', 'v1']);
    run(['tag', '--list']);
    run(['remote', 'get-url', 'origin']);
    run(['remote', 'add', 'origin', '/mock-reference-remote']);
    run(['remote']);
    run(['remote', 'get-url', 'origin']);
    const linked = `${root}/linked`;
    run(['worktree', 'add', linked, 'dev']);
    responses.push({ linkedFileExists: fileSystem.existsSync(path.join(linked, 'd.txt')) });
    fileSystem.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');
    run(['add', 'linked.txt'], undefined, linked);
    run(['commit', '-q', '-m', 'linked'], undefined, linked);
    run(['rev-list', '--count', 'dev']);
    run(['worktree', 'add', `${root}/duplicate`, 'dev']);
    run(['worktree', 'remove', linked]);
    responses.push({ linkedExistsAfterRemove: fileSystem.existsSync(linked) });
    // 输入：检出将覆盖未跟踪文件时失败，原文件必须保留
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'local\n');
    run(['switch', '-q', 'dev'], ['status']);
    responses.push({ preservedLocalFile: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    fileSystem.rmSync(path.join(root, 'a.txt'));
    run(['reset', '--hard', 'dev']);
    // 输入：保存、恢复已跟踪修改，核实工作树内容与引用历史
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    run(['stash']);
    responses.push({ fileAfterStash: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    run(['stash', 'pop'], ['status', 'stderr']);
    responses.push({ fileAfterPop: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    run(['reset', '--hard']);
    // 输入：挑选另一分支的新提交，再反向提交，最后构造有两个父提交的合并
    run(['switch', '-q', '-c', 'feature']);
    fileSystem.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    run(['add', 'feature.txt']);
    run(['commit', '-q', '-m', 'feature']);
    const feature = run(['rev-parse', 'HEAD']).stdout.trim();
    run(['switch', '-q', 'main']);
    run(['cherry-pick', '-x', feature], ['status', 'stderr']);
    responses.push({ pickedFileExists: fileSystem.existsSync(path.join(root, 'feature.txt')) });
    run(['revert', 'HEAD'], ['status', 'stderr']);
    responses.push({ revertedFileExists: fileSystem.existsSync(path.join(root, 'feature.txt')) });
    run(['merge', '--no-ff', '-m', 'merged', 'feature'], ['status', 'stderr']);
    run(['log', '-n', '1', '--format=%P']);
    run(['rev-list', '--count', 'HEAD']);
    return responses;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = setup();
    try {
      const memoryRoot = '/mock/reference';
      liteFs.mkdirSync(memoryRoot, { recursive: true });
      const actual = scenario(memoryRoot, liteFs);
      // 预期 1：除各仓库独有的路径与哈希外，已核验回包与文件效果全部一致
      assert.deepEqual(actual, expected, '内存 Git 应与真实 Git 的对应响应和文件效果一致');
    } finally {
      done();
    }
  } finally {
    nativeFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：导入即登记——通过子进程入口执行 Git，裸名、系统路径与内存卷路径均命中同一仓库。 */
test('导入即登记：spawnSync 通过裸名与绝对路径执行 Git', () => {
  // 输入：建立内存会话，通过 git 裸名初始化仓库
  const done = setup();
  try {
    const cwd = '/mock/registered';
    liteFs.mkdirSync(cwd, { recursive: true });
    const init = liteChildProcess.spawnSync('git', ['init', '-b', 'main'], { cwd, encoding: 'utf8' });
    // 预期 1：导入后应能通过 git 裸名初始化仓库
    assert.equal(init.status, 0, '导入后应能通过 git 裸名初始化仓库');
    // 输入：通过系统绝对路径读取当前分支
    const system = liteChildProcess.spawnSync('/usr/bin/git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
    // 预期 2：系统绝对路径应成功执行 Git
    assert.equal(system.status, 0, '系统绝对路径应成功执行 Git');
    // 预期 3：系统绝对路径应命中已初始化的仓库
    assert.equal(system.stdout, 'main\n', '系统绝对路径应命中已初始化的仓库');
    // 输入：通过内存卷完整路径读取当前分支
    const memory = liteChildProcess.spawnSync('/mock-cmd/usr/bin/git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
    // 预期 4：内存卷完整路径应成功执行 Git
    assert.equal(memory.status, 0, '内存卷完整路径应成功执行 Git');
    // 预期 5：内存卷完整路径应命中同一仓库
    assert.equal(memory.stdout, 'main\n', '内存卷完整路径应命中同一仓库');
  } finally {
    done();
  }
});

/** 场景：默认回落内置——未装 onRun 钩子时走内置 mini-git：未 init 的目录非仓库，rev-parse 按 128 fatal 口径收场。 */
test('默认回落内置：未 init 的目录 → status 128 + fatal: not a git repository', () => {
  const done = setup();
  try {
    // 输入：卷内未 init 的项目根执行 rev-parse（不装钩子）
    const run = volumeGit('/mock/nowhere');
    // 输入：通过 spawnSync 执行 git rev-parse
    const r = run(['rev-parse', 'HEAD']);
    // 预期 1：非 git 仓库应回 status 128
    assert.equal(r.status, 128, '非 git 仓库应回 status 128');
    // 预期 2：stderr 应为 not a git repository 口径
    assert.match(r.stderr, /^fatal: not a git repository/, 'stderr 应为 not a git repository 口径');
    // 预期 3：stdout 应为空串
    assert.equal(r.stdout, '', 'stdout 应为空串');
  } finally {
    done();
  }
});

/** 场景：调用入账——argv 与 options 如实记录，含调用方自行拼入的只读锁前缀。 */
test('调用入账：argv/options 原样记录（含 --no-optional-locks 前缀）', () => {
  const done = setup();
  try {
    // 输入：带只读锁前缀、cwd 与 encoding 选项，通过 spawnSync 执行 Git
    liteChildProcess.spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: '/mock/project', encoding: 'utf8' });
    // 预期 1：调用应入账一条
    assert.equal(liteChildProcess.calls().length, 1, '调用应入账一条');
    const call = liteChildProcess.calls()[0];
    // 预期 2：argv 应原样记录
    assert.deepEqual(call.args, ['--no-optional-locks', 'status', '--porcelain'], 'argv 应原样记录');
    // 预期 3：options.cwd 应如实记录
    assert.equal(call.options.cwd, '/mock/project', 'options.cwd 应如实记录');
    // 预期 4：options.encoding 应如实记录
    assert.equal(call.options.encoding, 'utf8', 'options.encoding 应如实记录');
  } finally {
    done();
  }
});

/** 场景：onRun 全量覆盖——钩子返回完整回包对象时逐字段生效（装了钩子命中即不走内置）。 */
test('onRun 全量覆盖：status/stdout/stderr 逐字段生效', () => {
  const done = setup();
  try {
    // 输入：安装返回完整回包的钩子后 spawnSync git
    mgr.command('git').onRun(() => ({ status: 1, stdout: 'out\n', stderr: 'err\n' }));
    const r = liteChildProcess.spawnSync('git', ['push'], { encoding: 'utf8' });
    // 预期 1：status 应为钩子注入的 1
    assert.equal(r.status, 1, 'status 应为钩子注入的 1');
    // 预期 2：stdout 应为钩子注入内容
    assert.equal(r.stdout, 'out\n', 'stdout 应为钩子注入内容');
    // 预期 3：stderr 应为钩子注入内容
    assert.equal(r.stderr, 'err\n', 'stderr 应为钩子注入内容');
  } finally {
    done();
  }
});

/** 场景：onRun 部分覆盖——钩子只返回部分字段时，其余字段保持默认值（浅合并口径）。 */
test('onRun 部分覆盖：仅返回 stdout，status/stderr 保持默认', () => {
  const done = setup();
  try {
    // 输入：安装只返回 stdout 的钩子后 spawnSync git
    mgr.command('git').onRun((call) => ({ stdout: `${call.argv[0]} ok\n` }));
    const r = liteChildProcess.spawnSync('git', ['status'], { encoding: 'utf8' });
    // 预期 1：stdout 应为钩子注入内容
    assert.equal(r.stdout, 'status ok\n', 'stdout 应为钩子注入内容');
    // 预期 2：status 应保持默认 0
    assert.equal(r.status, 0, 'status 应保持默认 0');
    // 预期 3：stderr 应保持默认空串
    assert.equal(r.stderr, '', 'stderr 应保持默认空串');
  } finally {
    done();
  }
});

/** 场景：onRun 未命中回落内置——钩子按 argv 分支未命中返回 undefined 时回落内置 mini-git（世界脚本
 * 常见形态：undefined 即获得真实语义），命中分支仍回钩子注入值。 */
test('onRun 未命中：返回 undefined 回落内置实现，命中分支回钩子注入', () => {
  const done = setup();
  try {
    // 输入：卷内 init 一个仓库，安装按子命令分支的钩子（log 命中、其余 undefined）
    const run = volumeGit('/mock/fallback');
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    mgr.command('git').onRun((call) => (call.argv[0] === 'log' ? { stdout: 'logs\n' } : undefined));
    // 输入：通过 spawnSync 执行 git log
    const hit = run(['log']);
    // 输入：通过 spawnSync 执行 git rev-parse
    const miss = run(['rev-parse', '--is-inside-work-tree']);
    // 预期 1：命中分支应回钩子内容
    assert.equal(hit.stdout, 'logs\n', '命中分支应回钩子内容');
    // 预期 2：未命中分支应回落内置实现（status 0）
    assert.equal(miss.status, 0, '未命中分支应回落内置实现（status 0）');
    // 预期 3：未命中分支应获得内置真实语义输出
    assert.equal(miss.stdout, 'true\n', '未命中分支应获得内置真实语义输出');
  } finally {
    done();
  }
});

/** 场景：钩子与账本同源——spawnSync 触发钩子，其参数与子进程调用账本保持一致。 */
test('钩子与账本同源：onRun 的 call.argv/call.options 与 calls() 记录一致', () => {
  const done = setup();
  try {
    // 输入：安装捕获 call 的钩子后 spawnSync git
    let seen = null;
    mgr.command('git').onRun((call) => { seen = { argv: [...call.argv], cwd: call.options.cwd }; });
    liteChildProcess.spawnSync('git', ['branch', '--show-current'], { cwd: '/mock/root' });
    const rec = liteChildProcess.calls()[0];
    // 预期 1：钩子 call.argv 应与账本一致
    assert.deepEqual(seen.argv, rec.args, '钩子 call.argv 应与账本一致');
    // 预期 2：钩子 call.options 应与账本一致
    assert.equal(seen.cwd, rec.options.cwd, '钩子 call.options 应与账本一致');
  } finally {
    done();
  }
});

/** 场景：异步执行——spawn Git 实际执行命令，通过 stdout 与 close 返回结果。 */
test('异步执行：spawn Git 输出结果并正常退出', async () => {
  const done = setup();
  try {
    // 输入：建仓后通过 spawn 执行 git branch --show-current
    const cwd = '/mock/async-git';
    const run = volumeGit(cwd);
    run(['init', '-b', 'main']);
    const child = liteChildProcess.spawn('git', ['branch', '--show-current'], { cwd });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    // 预期 1：异步 Git 返回当前分支名
    assert.equal(stdout, 'main\n', '异步 Git 应输出当前分支');
    // 预期 2：命令执行完毕正常退出
    assert.deepEqual(closed, { code: 0, signal: null }, '异步 Git 应正常退出');
  } finally {
    done();
  }
});

/** 场景：内置 mini-git 端到端——init → 写文件 → status(??) → add → status(A ) → commit → log 恰一条 →
 * 改文件 → status(' M') → 二次 commit → rev-list --count=2 → branch --show-current，全链真实语义。 */
test('内置 mini-git 端到端：init→status→add→commit→log→再改→再提交→count=2', () => {
  const done = setup();
  try {
    // 输入：卷内全新项目根，按生产 git-flow 的命令形态走一轮提交链
    const root = '/mock/e2e';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    const init = run(['init', '-b', 'main']);
    // 预期 1：init -b main 应成功
    assert.equal(init.status, 0, 'init -b main 应成功');
    write(root, 'a.txt', 'hello\n');
    // 输入：通过 spawnSync 执行 git status
    // 预期 2：新文件应为 ?? 码
    assert.equal(run(['status', '--porcelain']).stdout, '?? a.txt\n', '新文件应为 ?? 码');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git status
    // 预期 3：暂存后应为 A 码
    assert.equal(run(['status', '--porcelain']).stdout, 'A  a.txt\n', '暂存后应为 A 码');
    // 输入：通过 spawnSync 执行 git commit
    const commit1 = run(['commit', '-q', '--only', '-m', 'feat: 第一条 REQ-20261029-001', '--', 'a.txt']);
    // 预期 4：commit --only 应成功
    assert.equal(commit1.status, 0, 'commit --only 应成功');
    // 预期 5：-q 提交应无 stdout
    assert.equal(commit1.stdout, '', '-q 提交应无 stdout');
    // 输入：通过 spawnSync 执行 git log
    const log = run(['log', '--format=%H%x09%s']);
    const lines = log.stdout.split('\n').filter(Boolean);
    // 预期 6：首次提交后 log 应恰一条
    assert.equal(lines.length, 1, '首次提交后 log 应恰一条');
    // 预期 7：log 行应为 <hash>\\t<主题>
    assert.match(lines[0], /^[0-9a-f]{40}\tfeat: 第一条 REQ-20261029-001$/, 'log 行应为 <hash>\\t<主题>');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 8：HEAD 应为该提交号
    assert.equal(run(['rev-parse', 'HEAD']).stdout.trim(), lines[0].split('\t')[0], 'HEAD 应为该提交号');
    write(root, 'a.txt', 'hello v2\n');
    // 输入：通过 spawnSync 执行 git status
    // 预期 9：修改后应为 M 码
    assert.equal(run(['status', '--porcelain']).stdout, ' M a.txt\n', '修改后应为 M 码');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    // 预期 10：第二次提交应成功
    assert.equal(run(['commit', '-q', '--only', '-m', 'feat: 第二条 REQ-20261029-001', '--', 'a.txt']).status, 0, '第二次提交应成功');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 11：两次提交后 count 应为 2
    assert.equal(run(['rev-list', '--count', 'HEAD']).stdout, '2\n', '两次提交后 count 应为 2');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 12：当前分支应为 main
    assert.equal(run(['branch', '--show-current']).stdout, 'main\n', '当前分支应为 main');
    // 输入：通过 spawnSync 执行 git status
    // 预期 13：全部提交后 porcelain 应为空
    assert.equal(run(['status', '--porcelain']).stdout, '', '全部提交后 porcelain 应为空');
  } finally {
    done();
  }
});

/** 场景：暂存区状态码——'A '→'AM'→提交后' M'→删除' D'→暂存删除'D '，pathspec 限定照做。 */
test('暂存区状态码：A/AM/ M/ D/D 与 pathspec 限定', () => {
  const done = setup();
  try {
    // 输入：卷内仓库单文件走完 暂存→再改→提交→修改→删除→暂存删除 状态迁移
    const root = '/mock/states';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'f.txt', 'one');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'f.txt']);
    // 输入：通过 spawnSync 执行 git status
    // 预期 1：暂存新文件应为 A 码
    assert.equal(run(['status', '--porcelain']).stdout, 'A  f.txt\n', '暂存新文件应为 A 码');
    write(root, 'f.txt', 'two');
    // 输入：通过 spawnSync 执行 git status
    // 预期 2：暂存后再改应为 AM 码
    assert.equal(run(['status', '--porcelain']).stdout, 'AM f.txt\n', '暂存后再改应为 AM 码');
    write(root, 'g.txt', 'g');
    // 输入：通过 spawnSync 执行 git status
    // 预期 3：未跟踪 g.txt 应并列 ?? 码
    assert.equal(run(['status', '--porcelain']).stdout, 'AM f.txt\n?? g.txt\n', '未跟踪 g.txt 应并列 ?? 码');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'f.txt']);
    // 输入：通过 spawnSync 执行 git commit
    // 预期 4：提交 f.txt 应成功
    assert.equal(run(['commit', '-q', '--only', '-m', 'feat: 提交 REQ-20261029-002', '--', 'f.txt']).status, 0, '提交 f.txt 应成功');
    write(root, 'f.txt', 'three');
    // 输入：通过 spawnSync 执行 git status
    // 预期 5：提交后修改应为 M 码
    assert.equal(run(['status', '--porcelain']).stdout, ' M f.txt\n?? g.txt\n', '提交后修改应为 M 码');
    liteFs.rmSync(path.join(root, 'f.txt'));
    // 输入：通过 spawnSync 执行 git status
    // 预期 6：工作树删除应为 D 码
    assert.equal(run(['status', '--porcelain']).stdout, ' D f.txt\n?? g.txt\n', '工作树删除应为 D 码');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'f.txt']);
    // 输入：通过 spawnSync 执行 git status
    // 预期 7：暂存删除应为 D 码且 pathspec 限定生效
    assert.equal(run(['status', '--porcelain', '--', 'f.txt']).stdout, 'D  f.txt\n', '暂存删除应为 D 码且 pathspec 限定生效');
    // 输入：通过 spawnSync 执行 git commit
    // 预期 8：提交删除应成功
    assert.equal(run(['commit', '-q', '--only', '-m', 'feat: 删除 REQ-20261029-002', '--', 'f.txt']).status, 0, '提交删除应成功');
    // 输入：通过 spawnSync 执行 git status
    // 预期 9：删除提交后仅剩未跟踪文件
    assert.equal(run(['status', '--porcelain']).stdout, '?? g.txt\n', '删除提交后仅剩未跟踪文件');
  } finally {
    done();
  }
});

/** 场景：无变更提交——index 与 HEAD 一致时 commit 按 status 1 + nothing to commit 口径收场。 */
test('无变更提交：status 1 + nothing to commit', () => {
  const done = setup();
  try {
    // 输入：提交一次后立刻再次 commit（全 index 口径与路径限定口径各一次）
    const root = '/mock/empty-commit';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'x.txt', 'x');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'x.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 基线 REQ-20261029-003', '--', 'x.txt']);
    // 输入：通过 spawnSync 执行 git commit
    const again = run(['commit', '-q', '-m', 'feat: 空提交 REQ-20261029-003']);
    // 输入：通过 spawnSync 执行 git commit
    const againPaths = run(['commit', '-q', '--only', '-m', 'feat: 空提交 REQ-20261029-003', '--', 'x.txt']);
    // 预期 1：无变更提交应 status 1
    assert.equal(again.status, 1, '无变更提交应 status 1');
    // 预期 2：stdout 应包含无变更提交提示
    assert.match(again.stdout, /nothing to commit, working tree clean/, 'stdout 应包含无变更提交提示');
    // 预期 3：无变更提交不向 stderr 输出
    assert.equal(again.stderr, '', '无变更提交的 stderr 应为空');
    // 预期 4：路径限定无变更提交应 status 1
    assert.equal(againPaths.status, 1, '路径限定无变更提交应 status 1');
  } finally {
    done();
  }
});

/** 场景：log 组合——branchLog 六字段格式、-n/--skip 分页、裸提交号起点、a..b 范围、%B%x00 全量消息、--not 排除。 */
test('log 组合：六字段格式/-n/--skip/提交号起点/a..b 范围/%B%x00', () => {
  const done = setup();
  try {
    // 输入：两次提交 + 在首个提交上建 feature 分支，覆盖生产面全部 log 形态
    const root = '/mock/logs';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', '1');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 甲 REQ-20261029-004', '--', 'a.txt']);
    write(root, 'a.txt', '2');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 乙 REQ-20261029-004', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git log
    const shas = run(['log', '--format=%H']).stdout.split('\n').filter(Boolean);
    const [shaNew, shaOld] = shas;
    // 输入：通过 spawnSync 执行 git log
    const rows = run(['log', 'main', '-n', '50', '--skip', '0', '--format=%H%x09%h%x09%an%x09%aI%x09%P%x09%s'])
      .stdout.split('\n').filter(Boolean).map(l => l.split('\t'));
    // 预期 1：log 应恰两条
    assert.equal(rows.length, 2, 'log 应恰两条');
    // 预期 2：首行应为最新提交
    assert.equal(rows[0][0], shaNew, '首行应为最新提交');
    // 预期 3：短号应为前 7 位
    assert.equal(rows[0][1], shaNew.slice(0, 7), '短号应为前 7 位');
    // 预期 4：作者名非空
    assert.ok(rows[0][2].length > 0, '作者名非空');
    // 预期 5：aI 应为严格 ISO 偏移形态
    assert.match(rows[0][3], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, 'aI 应为严格 ISO 偏移形态');
    // 预期 6：最新提交的父应为首提交
    assert.equal(rows[0][4], shaOld, '最新提交的父应为首提交');
    // 预期 7：主题应为提交消息首行
    assert.equal(rows[0][5], 'feat: 乙 REQ-20261029-004', '主题应为提交消息首行');
    // 预期 8：根提交 parents 应为空
    assert.equal(rows[1][4], '', '根提交 parents 应为空');
    // 输入：通过 spawnSync 执行 git log
    // 预期 9：-n 1 应只出最新一条
    assert.equal(run(['log', '-n', '1', '--format=%s']).stdout, 'feat: 乙 REQ-20261029-004\n', '-n 1 应只出最新一条');
    // 输入：通过 spawnSync 执行 git log
    // 预期 10：--skip 1 应出旧提交
    assert.equal(run(['log', '--skip', '1', '--format=%s']).stdout, 'feat: 甲 REQ-20261029-004\n', '--skip 1 应出旧提交');
    // 输入：通过 spawnSync 执行 git log
    // 预期 11：提交号起点应解析
    assert.equal(run(['log', shaOld, '--format=%s']).stdout, 'feat: 甲 REQ-20261029-004\n', '提交号起点应解析');
    // 输入：通过 spawnSync 执行 git branch
    run(['branch', 'feature', shaOld]);
    // 输入：通过 spawnSync 执行 git log
    // 预期 12：范围应为 b 可达减 a 可达
    assert.equal(run(['log', `feature..main`, '--format=%s']).stdout, 'feat: 乙 REQ-20261029-004\n', '范围应为 b 可达减 a 可达');
    // 输入：通过 spawnSync 执行 git log
    const raw = run(['log', '--format=%B%x00']).stdout.split('\0');
    // 预期 13：%B 应含甲消息
    assert.ok(raw.some(p => p.includes('feat: 甲 REQ-20261029-004')), '%B 应含甲消息');
    // 预期 14：%B 应含乙消息
    assert.ok(raw.some(p => p.includes('feat: 乙 REQ-20261029-004')), '%B 应含乙消息');
    // 输入：通过 spawnSync 执行 git log
    // 预期 15：--not 应排除 feature 可达
    assert.equal(run(['log', 'main', '--not', 'feature', '--format=%s']).stdout, 'feat: 乙 REQ-20261029-004\n', '--not 应排除 feature 可达');
    // 输入：通过 spawnSync 执行 git log
    const named = run(['log', 'main', '-n', '1', '--format=%H%x09%cI%x09%s', '--name-only', '--no-renames']).stdout.split('\n').filter(Boolean);
    // 预期 16：--name-only 应附变更文件
    assert.deepEqual(named, [`${shaNew}\t${rows[0][3]}\tfeat: 乙 REQ-20261029-004`, 'a.txt'], '--name-only 应附变更文件');
  } finally {
    done();
  }
});

/** 场景：rev-parse 组合——is-inside-work-tree、子目录上溯 show-toplevel、HEAD/refs/heads 取号、
 * --verify --quiet 静默失败、--verify 无 --quiet 的 128、上游探测失败。 */
test('rev-parse 组合：inside-work-tree/show-toplevel/HEAD/verify/上游', () => {
  const done = setup();
  try {
    // 输入：卷内仓库提交一次，从根与子目录分别执行 rev-parse 各形态
    const root = '/mock/rp';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'sub/x.txt', 'x');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'sub/x.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 基线 REQ-20261029-005', '--', 'sub/x.txt']);
    // 输入：通过 spawnSync 执行 git rev-parse
    const head = run(['rev-parse', 'HEAD']);
    // 预期 1：HEAD 应为 40 位提交号
    assert.match(head.stdout, /^[0-9a-f]{40}\n$/, 'HEAD 应为 40 位提交号');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 2：refs/heads/main 应同 HEAD
    assert.equal(run(['rev-parse', 'refs/heads/main']).stdout, head.stdout, 'refs/heads/main 应同 HEAD');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 3：仓库根应回 true
    assert.equal(run(['rev-parse', '--is-inside-work-tree']).stdout, 'true\n', '仓库根应回 true');
    // 输入：子目录（卷内 sub）执行上溯发现
    const inSub = liteChildProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], { cwd: `${root}/sub`, encoding: 'utf8' });
    // 预期 4：子目录应上溯命中仓库
    assert.equal(inSub.status, 0, '子目录应上溯命中仓库');
    // 预期 5：应回 true 与仓库根路径
    assert.equal(inSub.stdout, `true\n${root}\n`, '应回 true 与仓库根路径');
    // 输入：通过 spawnSync 执行 git rev-parse
    const quietMiss = run(['rev-parse', '--verify', '--quiet', 'refs/heads/nope']);
    // 预期 6：--verify --quiet 未命中应 status 1
    assert.equal(quietMiss.status, 1, '--verify --quiet 未命中应 status 1');
    // 预期 7：--verify --quiet 未命中应静默
    assert.equal(quietMiss.stderr, '', '--verify --quiet 未命中应静默');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 8：--verify 未命中应 status 128
    assert.equal(run(['rev-parse', '--verify', 'refs/heads/nope']).status, 128, '--verify 未命中应 status 128');
    // 输入：通过 spawnSync 执行 git rev-parse
    const upstream = run(['rev-parse', '--abbrev-ref', 'main@{upstream}']);
    // 预期 9：上游探测应失败
    assert.equal(upstream.status, 128, '上游探测应失败');
    // 预期 10：上游失败应为 no upstream 口径
    assert.match(upstream.stderr, /no upstream configured/, '上游失败应为 no upstream 口径');
  } finally {
    done();
  }
});

/** 场景：rev-list 组合——--count 按分支、--max-parents=0 根提交、--topo-order --reverse 父先于子。 */
test('rev-list 组合：count/max-parents=0/topo-order --reverse', () => {
  const done = setup();
  try {
    // 输入：两次提交并在首个提交上建 feature 分支
    const root = '/mock/revs';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', '1');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 根 REQ-20261029-006', '--', 'a.txt']);
    write(root, 'b.txt', 'b');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'b.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 次 REQ-20261029-006', '--', 'b.txt']);
    // 输入：通过 spawnSync 执行 git log
    const [shaNew, shaOld] = run(['log', '--format=%H']).stdout.split('\n').filter(Boolean);
    // 输入：通过 spawnSync 执行 git branch
    run(['branch', 'feature', shaOld]);
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 1：main 计数应为 2
    assert.equal(run(['rev-list', '--count', 'main']).stdout, '2\n', 'main 计数应为 2');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 2：feature 计数应为 1
    assert.equal(run(['rev-list', '--count', 'feature']).stdout, '1\n', 'feature 计数应为 1');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 3：根提交应恰为首提交
    assert.equal(run(['rev-list', '--max-parents=0', 'HEAD']).stdout, `${shaOld}\n`, '根提交应恰为首提交');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 4：拓扑反序应父先于子
    assert.equal(run(['rev-list', '--topo-order', '--reverse', 'HEAD']).stdout, `${shaOld}\n${shaNew}\n`, '拓扑反序应父先于子');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 5：^排除应滤掉 feature 可达
    assert.equal(run(['rev-list', '--topo-order', '--reverse', '^feature', shaNew]).stdout, `${shaNew}\n`, '^排除应滤掉 feature 可达');
  } finally {
    done();
  }
});

/** 场景：branch/switch/checkout——分支清单、-r 恒空、switch -c 创建切换、切换同时更新 HEAD、暂存区与工作树、
 * checkout 提交号 detached、symbolic-ref 当前分支名。 */
test('branch/switch/checkout：清单/创建/切换更新工作树/detached', () => {
  const done = setup();
  try {
    // 输入：main 根提交后 switch -c dev 再提交，覆盖分支面全部生产形态
    const root = '/mock/branches';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'r.txt', 'r');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'r.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 根 REQ-20261029-007', '--', 'r.txt']);
    // 输入：通过 spawnSync 执行 git switch
    // 预期 1：switch -c dev 应成功
    assert.equal(run(['switch', '-q', '-c', 'dev']).status, 0, 'switch -c dev 应成功');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 2：当前分支应为 dev
    assert.equal(run(['branch', '--show-current']).stdout, 'dev\n', '当前分支应为 dev');
    write(root, 'd.txt', 'd');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'd.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: dev REQ-20261029-007', '--', 'd.txt']);
    // 输入：通过 spawnSync 执行 git branch
    // 预期 3：本地分支清单应为 dev、main
    assert.equal(run(['branch', '--format=%(refname:short)']).stdout, 'dev\nmain\n', '本地分支清单应为 dev、main');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 4：-r 清单应为空
    assert.equal(run(['branch', '-r', '--format=%(refname:short)']).stdout, '', '-r 清单应为空');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 5：main 计数应为 1
    assert.equal(run(['rev-list', '--count', 'main']).stdout, '1\n', 'main 计数应为 1');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 6：dev 计数应为 2
    assert.equal(run(['rev-list', '--count', 'dev']).stdout, '2\n', 'dev 计数应为 2');
    // 输入：通过 spawnSync 执行 git switch
    // 预期 7：切回 main 应成功
    assert.equal(run(['switch', '-q', 'main']).status, 0, '切回 main 应成功');
    // 输入：通过 spawnSync 执行 git symbolic-ref
    // 预期 8：symbolic-ref 应回 main
    assert.equal(run(['symbolic-ref', '--short', 'HEAD']).stdout, 'main\n', 'symbolic-ref 应回 main');
    // 预期 9：切回 main 后应移除仅属于 dev 的已提交文件
    assert.equal(liteFs.existsSync(path.join(root, 'd.txt')), false, '切回 main 后应移除 dev 独有的已提交文件');
    // 输入：通过 spawnSync 执行 git checkout
    // 预期 10：checkout 分支应成功
    assert.equal(run(['checkout', 'dev']).status, 0, 'checkout 分支应成功');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 11：checkout 后当前分支应为 dev
    assert.equal(run(['branch', '--show-current']).stdout, 'dev\n', 'checkout 后当前分支应为 dev');
    // 输入：通过 spawnSync 执行 git rev-parse
    const mainTip = run(['rev-parse', 'refs/heads/main']).stdout.trim();
    // 输入：通过 spawnSync 执行 git branch
    // 预期 12：指定起点建分支应成功
    assert.equal(run(['branch', 'feature', mainTip]).status, 0, '指定起点建分支应成功');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 13：feature 分支应存在
    assert.equal(run(['rev-parse', '--verify', '--quiet', 'refs/heads/feature']).status, 0, 'feature 分支应存在');
    // 输入：通过 spawnSync 执行 git checkout
    // 预期 14：checkout 提交号应成功
    assert.equal(run(['checkout', mainTip]).status, 0, 'checkout 提交号应成功');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 15：detached 时 show-current 应为空
    assert.equal(run(['branch', '--show-current']).stdout, '', 'detached 时 show-current 应为空');
    // 输入：通过 spawnSync 执行 git symbolic-ref
    // 预期 16：detached 时非静默 symbolic-ref 应返回 128
    assert.equal(run(['symbolic-ref', '--short', 'HEAD']).status, 128, 'detached 时非静默 symbolic-ref 应返回 128');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 17：detached HEAD 应指向该提交
    assert.equal(run(['rev-parse', 'HEAD']).stdout.trim(), mainTip, 'detached HEAD 应指向该提交');
  } finally {
    done();
  }
});

/** 场景：空仓库分支口径——init 后未提交即 switch -c（未出生分支改名等价路径，ensureDevWorkflow 前置）。 */
test('空仓库分支：init 幂等 + 未出生分支 switch -c + 首提交落新分支', () => {
  const done = setup();
  try {
    // 输入：init -b main 后重复 init，未提交即 switch -c dev，再落首个提交
    const root = '/mock/unborn';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    // 输入：通过 spawnSync 执行 git init
    // 预期 1：重复 init 应幂等成功
    assert.equal(run(['init']).status, 0, '重复 init 应幂等成功');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 2：重复 init 不应改当前分支
    assert.equal(run(['branch', '--show-current']).stdout, 'main\n', '重复 init 不应改当前分支');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 3：未出生分支 rev-list 应失败
    assert.equal(run(['rev-list', '--count', 'HEAD']).status, 128, '未出生分支 rev-list 应失败');
    // 输入：通过 spawnSync 执行 git switch
    // 预期 4：空仓库 switch -c 应成功
    assert.equal(run(['switch', '-q', '-c', 'dev']).status, 0, '空仓库 switch -c 应成功');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 5：当前分支应为 dev
    assert.equal(run(['branch', '--show-current']).stdout, 'dev\n', '当前分支应为 dev');
    write(root, 'first.txt', '1');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'first.txt']);
    // 输入：通过 spawnSync 执行 git commit
    // 预期 6：首个提交应成功
    assert.equal(run(['commit', '-q', '--only', '-m', 'feat: 首提交 REQ-20261029-008', '--', 'first.txt']).status, 0, '首个提交应成功');
    // 输入：通过 spawnSync 执行 git rev-list
    // 预期 7：首提交后 count 应为 1
    assert.equal(run(['rev-list', '--count', 'HEAD']).stdout, '1\n', '首提交后 count 应为 1');
    // 输入：通过 spawnSync 执行 git branch
    // 预期 8：首提交应落在 dev
    assert.equal(run(['branch', '--show-current']).stdout, 'dev\n', '首提交应落在 dev');
    // 输入：通过 spawnSync 执行 git rev-parse
    // 预期 9：main 分支应未出生
    assert.equal(run(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).status, 1, 'main 分支应未出生');
  } finally {
    done();
  }
});

/** 场景：merge-base --is-ancestor——沿 parents 可达性判定（0 可达 / 1 不可达 / 非法引用 128）。 */
test('merge-base --is-ancestor：可达性判定', () => {
  const done = setup();
  try {
    // 输入：两次提交，根提交与 HEAD 互相做祖先判定
    const root = '/mock/ancestry';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', '1');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 根 REQ-20261029-009', '--', 'a.txt']);
    write(root, 'a.txt', '2');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 次 REQ-20261029-009', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git log
    const [shaNew, shaOld] = run(['log', '--format=%H']).stdout.split('\n').filter(Boolean);
    // 输入：通过 spawnSync 执行 git merge-base
    // 预期 1：根提交应为 HEAD 祖先
    assert.equal(run(['merge-base', '--is-ancestor', shaOld, 'HEAD']).status, 0, '根提交应为 HEAD 祖先');
    // 输入：通过 spawnSync 执行 git merge-base
    // 预期 2：新提交不应是根提交祖先
    assert.equal(run(['merge-base', '--is-ancestor', shaNew, shaOld]).status, 1, '新提交不应是根提交祖先');
    // 输入：通过 spawnSync 执行 git merge-base
    // 预期 3：非法引用应 128
    assert.equal(run(['merge-base', '--is-ancestor', 'nope', 'HEAD']).status, 128, '非法引用应 128');
    // 输入：通过 spawnSync 执行 git merge-base
    // 预期 4：普通 merge-base 应返回共同祖先
    assert.equal(run(['merge-base', shaOld, 'HEAD']).stdout, `${shaOld}\n`, '普通 merge-base 应返回共同祖先');
  } finally {
    done();
  }
});

/** 场景：ls-files——全量清单、路径限定、--error-unmatch 命中（0）与未命中（1）。 */
test('ls-files：清单/路径限定/--error-unmatch', () => {
  const done = setup();
  try {
    // 输入：两个文件入库后各 ls-files 形态
    const root = '/mock/lsf';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'a');
    write(root, 'sub/b.txt', 'b');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', '.']);
    // 输入：通过 spawnSync 执行 git ls-files
    // 预期 1：全量清单应为入库路径
    assert.equal(run(['ls-files']).stdout, 'a.txt\nsub/b.txt\n', '全量清单应为入库路径');
    // 输入：通过 spawnSync 执行 git ls-files
    // 预期 2：路径限定应只出命中项
    assert.equal(run(['ls-files', '--', 'sub']).stdout, 'sub/b.txt\n', '路径限定应只出命中项');
    // 输入：通过 spawnSync 执行 git ls-files
    const hit = run(['ls-files', '--error-unmatch', '--', 'a.txt']);
    // 预期 3：--error-unmatch 命中应 status 0
    assert.equal(hit.status, 0, '--error-unmatch 命中应 status 0');
    // 预期 4：命中应回显路径
    assert.equal(hit.stdout, 'a.txt\n', '命中应回显路径');
    // 输入：通过 spawnSync 执行 git ls-files
    const miss = run(['ls-files', '--error-unmatch', '--', 'missing.txt']);
    // 预期 5：--error-unmatch 未命中应 status 1
    assert.equal(miss.status, 1, '--error-unmatch 未命中应 status 1');
    // 预期 6：未命中应为 pathspec 错误口径
    assert.match(miss.stderr, /pathspec 'missing\.txt' did not match/, '未命中应为 pathspec 错误口径');
  } finally {
    done();
  }
});

/** 场景：show——-s --format=%B 取提交全消息、rev:path 取树内文件内容、缺失路径 128。 */
test('show：%B 消息/rev:path 内容/缺失路径', () => {
  const done = setup();
  try {
    // 输入：一次提交后按 rev 与 rev:path 两口径读取
    const root = '/mock/show';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'hello\n');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 展示 REQ-20261029-010', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git show
    // 预期 1：%B 应回提交消息
    assert.equal(run(['show', '-s', '--format=%B', 'HEAD']).stdout, 'feat: 展示 REQ-20261029-010\n\n', '%B 应回提交消息');
    // 输入：通过 spawnSync 执行 git show
    // 预期 2：rev:path 应回文件内容
    assert.equal(run(['show', 'HEAD:a.txt']).stdout, 'hello\n', 'rev:path 应回文件内容');
    // 输入：通过 spawnSync 执行 git show
    // 预期 3：缺失路径应 128
    assert.equal(run(['show', 'HEAD:nope.txt']).status, 128, '缺失路径应 128');
    // 输入：通过 spawnSync 执行 git rev-parse
    const short = run(['rev-parse', 'HEAD']).stdout.trim().slice(0, 7);
    // 输入：通过 spawnSync 执行 git show
    // 预期 4：短号前缀应可解析
    assert.equal(run(['show', '-s', '--format=%s', short]).stdout, 'feat: 展示 REQ-20261029-010\n', '短号前缀应可解析');
  } finally {
    done();
  }
});

/** 场景：diff 家族——HEAD -- path 有差异/无差异、--cached --quiet 退出码、diff-tree 变更路径、ls-tree 全量。 */
test('diff 家族：HEAD 差异/--cached 退出码/diff-tree/ls-tree', () => {
  const done = setup();
  try {
    // 输入：提交基线后修改、暂存、再提交，覆盖 diff 读取面
    const root = '/mock/diffs';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'one\n');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 基线 REQ-20261029-011', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git diff
    const clean = run(['diff', 'HEAD', '--', 'a.txt']);
    // 预期 1：diff 无差异应 status 0
    assert.equal(clean.status, 0, 'diff 无差异应 status 0');
    // 预期 2：diff 无差异应空输出
    assert.equal(clean.stdout, '', 'diff 无差异应空输出');
    write(root, 'a.txt', 'two\n');
    // 输入：通过 spawnSync 执行 git diff
    const dirty = run(['diff', 'HEAD', '--', 'a.txt']);
    // 预期 3：diff 应 status 0
    assert.equal(dirty.status, 0, 'diff 应 status 0');
    // 预期 4：应含 diff --git 头
    assert.ok(dirty.stdout.includes('diff --git a/a.txt b/a.txt'), '应含 diff --git 头');
    // 预期 5：应含旧行
    assert.ok(dirty.stdout.includes('-one'), '应含旧行');
    // 预期 6：应含新行
    assert.ok(dirty.stdout.includes('+two'), '应含新行');
    // 输入：通过 spawnSync 执行 git diff
    // 预期 7：未暂存应退出 0
    assert.equal(run(['diff', '--cached', '--quiet']).status, 0, '未暂存应退出 0');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git diff
    // 预期 8：已暂存差异应退出 1
    assert.equal(run(['diff', '--cached', '--quiet']).status, 1, '已暂存差异应退出 1');
    write(root, 'b.txt', 'b\n');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'b.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 追加 REQ-20261029-011', '--', 'b.txt']);
    // 输入：通过 spawnSync 执行 git diff-tree
    // 预期 9：diff-tree 应只出变更路径
    assert.equal(run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout, 'b.txt\n', 'diff-tree 应只出变更路径');
    // 输入：通过 spawnSync 执行 git ls-tree
    // 预期 10：ls-tree 应出全量路径
    assert.equal(run(['ls-tree', '--name-only', '-r', 'HEAD']).stdout, 'a.txt\nb.txt\n', 'ls-tree 应出全量路径');
    // 输入：通过 spawnSync 执行 git diff
    // 预期 11：未合并清单应恒空
    assert.equal(run(['diff', '--name-only', '--diff-filter=U']).stdout, '', '未合并清单应恒空');
  } finally {
    done();
  }
});

/** 场景：忽略模型——根 .gitignore 的路径/目录模式使 status 不出被忽略路径，check-ignore 按退出码判定。 */
test('忽略模型：.gitignore 路径与目录模式/check-ignore', () => {
  const done = setup();
  try {
    // 输入：根 .gitignore 写入文件与目录两条模式，工作树放对应文件
    const root = '/mock/ignore';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, '.gitignore', 'skip.txt\ntmpdir/\n');
    write(root, 'skip.txt', 's');
    write(root, 'tmpdir/x.txt', 'x');
    write(root, 'keep.txt', 'k');
    // 输入：通过 spawnSync 执行 git status
    // 预期 1：被忽略路径不应出现在 porcelain
    assert.equal(run(['status', '--porcelain', '-uall']).stdout, '?? .gitignore\n?? keep.txt\n', '被忽略路径不应出现在 porcelain');
    // 输入：通过 spawnSync 执行 git check-ignore
    // 预期 2：文件模式命中应退出 0
    assert.equal(run(['check-ignore', '-q', '--', 'skip.txt']).status, 0, '文件模式命中应退出 0');
    // 输入：通过 spawnSync 执行 git check-ignore
    // 预期 3：目录模式命中应退出 0
    assert.equal(run(['check-ignore', '-q', '--', 'tmpdir/x.txt']).status, 0, '目录模式命中应退出 0');
    // 输入：通过 spawnSync 执行 git check-ignore
    // 预期 4：未命中应退出 1
    assert.equal(run(['check-ignore', '-q', '--', 'keep.txt']).status, 1, '未命中应退出 1');
  } finally {
    done();
  }
});

/** 场景：写命令按真实 Git 处理仓库状态，失败不伪装成功，成功具有实际文件与引用效果。 */
test('写命令：push/worktree/cherry-pick 失败、merge/reset/revert/stash 输出及标签引用', () => {
  const done = setup();
  try {
    // 输入：创建一个有根提交且未配置远端的仓库
    const root = '/mock/write-commands';
    const run = volumeGit(root);
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'a\n');
    run(['add', '-A', '--', 'a.txt']);
    run(['commit', '-q', '--only', '-m', 'baseline', '--', 'a.txt']);
    const sha = run(['rev-parse', 'HEAD']).stdout.trim();
    // 输入：无远端时 fetch --all，再向不存在的 origin 推送
    const fetch = run(['fetch', '--all', '--prune']);
    // 预期 1：无远端 fetch --all 正常返回空输出
    assert.deepEqual([fetch.status, fetch.stdout, fetch.stderr], [0, '', ''], '无远端 fetch --all 应成功且无输出');
    const push = run(['push', 'origin', 'main']);
    // 预期 2：不存在的 origin 推送失败
    assert.equal(push.status, 128, '无 origin 的推送应返回 128');
    // 预期 3：错误指出 origin 不是可访问的仓库
    assert.match(push.stderr, /fatal: 'origin' does not appear to be a git repository/, '推送应说明远端不存在');
    // 输入：尝试将当前已检出的 main 添加到另一工作树，然后移除未创建的工作树
    const add = run(['worktree', 'add', '/mock/write-wt', 'main']);
    // 预期 4：同一分支已被当前工作树占用
    assert.equal(add.status, 128, '重复检出同一分支应失败');
    // 预期 5：错误文案包含工作树占用原因
    assert.match(add.stderr, /already used by worktree/, '应报告分支占用');
    // 预期 6：删除未创建的工作树失败
    assert.equal(run(['worktree', 'remove', '--force', '/mock/write-wt']).status, 128, '移除不存在的工作树应失败');
    // 输入：合并当前 HEAD，再次挑选同一个提交
    // 预期 7：无需合并时仍有正常提示
    assert.equal(run(['merge', '--no-ff', '-m', 'merge', sha]).stdout, 'Already up to date.\n', '已合并应输出正常提示');
    const pick = run(['cherry-pick', '-x', sha]);
    // 预期 8：重复挑选产生空提交，按失败收场
    assert.equal(pick.status, 1, '重复 cherry-pick 应返回 1');
    // 预期 9：错误指出挑选结果为空
    assert.match(pick.stderr, /previous cherry-pick is now empty/, '空挑选应提供失败原因');
    // 输入：创建标签，再执行 hard reset 清理挑选状态
    // 预期 10：轻量标签创建成功
    assert.equal(run(['tag', 'v1']).status, 0, '标签创建应成功');
    // 预期 11：标签列表包含新引用及其提交号
    assert.equal(run(['for-each-ref', 'refs/tags', '--format=%(refname:short)%09%(objectname)%09%(*objectname)']).stdout,
      `v1\t${sha}\t\n`, '标签查询应列出实际创建的引用');
    // 预期 12：hard reset 输出当前提交号与主题
    assert.equal(run(['reset', '--hard']).stdout, `HEAD is now at ${sha.slice(0, 7)} baseline\n`, 'reset 应回显当前提交');
    // 输入：revert 根提交，再在干净仓库中 stash
    const revert = run(['revert', 'HEAD']);
    // 预期 13：revert 创建新提交
    assert.equal(revert.status, 0, 'revert 应成功');
    // 预期 14：输出包含反向提交主题
    assert.match(revert.stdout, /Revert "baseline"/, 'revert 应输出提交摘要');
    // 预期 15：反向提交真正删除根提交创建的文件
    assert.equal(liteFs.existsSync(path.join(root, 'a.txt')), false, 'revert 应更新工作树');
    // 预期 16：历史新增一个反向提交
    assert.equal(run(['rev-list', '--count', 'HEAD']).stdout, '2\n', 'revert 应增加提交');
    // 预期 17：干净仓库 stash 输出没有本地变更
    assert.equal(run(['stash']).stdout, 'No local changes to save\n', '干净仓库 stash 应输出正常提示');
    // 预期 18：未配置远端时 remote 清单为空
    assert.equal(run(['remote']).stdout, '', '无远端时清单应为空');
  } finally {
    done();
  }
});

/** 场景：未知子命令与全局选项——未知命令 status 1；--no-optional-locks 只读锁前缀被剥除；
 * -C <dir> 全局重定向生效。 */
test('未知子命令/--no-optional-locks 前缀/-C 重定向', () => {
  const done = setup();
  try {
    // 输入：仓库内分别执行未知命令、带锁前缀 status、-C 重定向 branch
    const root = '/mock/global';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'a');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git frobnicate
    const unknown = run(['frobnicate']);
    // 预期 1：未知子命令应 status 1
    assert.equal(unknown.status, 1, '未知子命令应 status 1');
    // 预期 2：应为 not a git command 口径
    assert.match(unknown.stderr, /is not a git command/, '应为 not a git command 口径');
    // 输入：通过 spawnSync 执行带 --no-optional-locks 全局选项的 Git 命令
    // 预期 3：锁前缀应被剥除
    assert.equal(run(['--no-optional-locks', 'status', '--porcelain']).stdout, 'A  a.txt\n', '锁前缀应被剥除');
    const redirected = liteChildProcess.spawnSync('git', ['-C', root, 'branch', '--show-current'], { cwd: '/mock/elsewhere', encoding: 'utf8' });
    // 预期 4：-C 重定向应命中仓库
    assert.equal(redirected.status, 0, '-C 重定向应命中仓库');
    // 预期 5：-C 重定向应回当前分支
    assert.equal(redirected.stdout, 'main\n', '-C 重定向应回当前分支');
  } finally {
    done();
  }
});

/** 场景：存储模型落盘形态——HEAD 文本、refs/heads/<分支> 提交号、objects 40 位对象文件（类型行 +
 * 载荷）、index.json 暂存映射，与模块头注释声明的目录布局一致。 */
test('存储模型：.git 目录布局与对象文件形态', () => {
  const done = setup();
  try {
    // 输入：一次提交后经 lite-fs 直读 .git 目录各文件
    const root = '/mock/layout';
    const run = volumeGit(root);
    // 输入：通过 spawnSync 执行 git init
    run(['init', '-b', 'main']);
    write(root, 'a.txt', 'content\n');
    // 输入：通过 spawnSync 执行 git add
    run(['add', '-A', '--', 'a.txt']);
    // 输入：通过 spawnSync 执行 git commit
    run(['commit', '-q', '--only', '-m', 'feat: 布局 REQ-20261029-013', '--', 'a.txt']);
    // 预期 1：HEAD 应为 ref 文本
    assert.equal(liteFs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n', 'HEAD 应为 ref 文本');
    const sha = liteFs.readFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'utf8').trim();
    // 预期 2：分支文件应为 40 位提交号
    assert.match(sha, /^[0-9a-f]{40}$/, '分支文件应为 40 位提交号');
    const objects = liteFs.readdirSync(path.join(root, '.git', 'objects')).filter(n => n !== '.' && n !== '..');
    // 预期 3：对象应含 blob/tree/commit 至少三个
    assert.ok(objects.length >= 3, '对象应含 blob/tree/commit 至少三个');
    const kinds = new Set(objects.map((name) => {
      // 预期 4：对象文件名应为 40 位 hash
      assert.match(name, /^[0-9a-f]{40}$/, '对象文件名应为 40 位 hash');
      return liteFs.readFileSync(path.join(root, '.git', 'objects', name), 'utf8').split('\n')[0];
    }));
    // 预期 5：对象类型行应覆盖 blob/commit/tree
    assert.deepEqual([...kinds].sort(), ['blob', 'commit', 'tree'], '对象类型行应覆盖 blob/commit/tree');
    const index = JSON.parse(liteFs.readFileSync(path.join(root, '.git', 'index.json'), 'utf8'));
    // 预期 6：index 应映射到 blob hash
    assert.match(index['a.txt'], /^[0-9a-f]{40}$/, 'index 应映射到 blob hash');
    const blobFile = liteFs.readFileSync(path.join(root, '.git', 'objects', index['a.txt']), 'utf8');
    // 预期 7：blob 载荷应为原始内容
    assert.equal(blobFile, 'blob\ncontent\n', 'blob 载荷应为原始内容');
  } finally {
    done();
  }
});

/** 场景：真实 Git 与内存 Git 重放祖先引用、路径恢复、混合重置、分离 HEAD 与快进合并。 */
test('真实 Git 对照：祖先引用、路径恢复、分离 HEAD 与快进合并', () => {
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-extra-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const config = ['-c', 'user.name=Coverage', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const output = [];
    const git = args => liteChildProcess.spawnSync('git', [...config, ...args], { cwd: root, env, encoding: 'utf8' });
    const run = args => { const result = git(args); output.push([args.join(' ').replaceAll(root, '<root>').replace(/\b[0-9a-f]{40}\b/g, '<sha>'), result.status]); return result; };
    const put = text => fileSystem.writeFileSync(root + '/tracked', text);
    // 输入：两个提交，第二次按显式路径提交；祖先表达式只对比关系，不依赖生成的提交号
    run(['init', '-q', '-b', 'main']); put('first\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'first']);
    const first = git(['rev-parse', 'HEAD']).stdout.trim();
    put('second\n'); run(['commit', '-q', '-m', 'second', 'tracked']);
    const second = git(['rev-parse', 'HEAD']).stdout.trim();
    output.push(['ancestors', git(['rev-parse', 'HEAD~1']).stdout.trim() === first,
      git(['rev-parse', 'HEAD^']).stdout.trim() === first, git(['rev-parse', 'HEAD^0']).stdout.trim() === second]);
    // 输入：按提交恢复路径，未匹配路径和未知引用必须报告失败
    run(['checkout', 'HEAD~1', '--', 'tracked']); output.push(['restored', fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    run(['checkout', 'HEAD', '--', 'absent']); run(['checkout', 'no-reference', '--', 'tracked']);
    run(['reset', 'HEAD']); output.push(['index', git(['diff', '--cached', '--name-only']).stdout]);
    run(['checkout', 'HEAD', '--', 'tracked']);
    output.push(['listed', run(['ls-files', '--cached', 'tracked']).stdout]);
    fileSystem.writeFileSync(root + '/.gitignore', 'ignored/\n');
    run(['check-ignore', 'ignored/child']); run(['check-ignore', '-q', 'tracked']);
    run(['add']); run(['rev-parse', 'no-reference']); run(['switch', '-c', 'invalid', 'no-reference']);
    // 输入：分离 HEAD 后提交、重置和重放提交；观察 HEAD 引用和文件内容
    run(['checkout', '--detach', first]); put('detached\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'detached']);
    output.push(['detached', git(['symbolic-ref', '-q', 'HEAD']).status]);
    run(['reset', '--soft', first]); run(['reset', '--hard', first]); run(['cherry-pick', second]);
    output.push(['replayed', fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    // 输入：在分支上推进一次提交，返回 main 做快进合并
    run(['switch', 'main']); run(['switch', '-c', 'feature']); put('feature\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'feature']);
    run(['switch', 'main']); const merged = run(['merge', 'feature']);
    output.push(['fast-forward', /Fast-forward/.test(merged.stdout), fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    // 输入：第二个独立工作树需在已有登记中查找分支占用，并继续创建
    run(['branch', 'linked-one']); run(['branch', 'linked-two']);
    run(['worktree', 'add', root + '/linked-one', 'linked-one']);
    run(['worktree', 'add', root + '/linked-two', 'linked-two']);
    output.push(['linked-content', fileSystem.readFileSync(root + '/linked-two/tracked', 'utf8')]);
    return output;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = setup();
    try {
      liteFs.mkdirSync('/mock/git-extra', { recursive: true });
      // 预期：命令退出码、祖先关系、索引与文件效果与真实 Git 一致
      assert.deepEqual(scenario('/mock/git-extra', liteFs), expected, '扩展 Git 场景应与原生命令一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：读取待暂存文件失败时，同步和异步 Git 都报告失败且不提交部分暂存结果。 */
test('Git 文件故障：add 遇到 EACCES/EIO 失败，索引保留，撤销后恢复', async () => {
  const done = setup();
  let remove;
  try {
    for (const code of ['EACCES', 'EIO']) {
      const root = '/mock/git-fault-' + code.toLowerCase();
      const run = volumeGit(root);
      run(['init', '-q', '-b', 'main']);
      write(root, 'preserved', 'previously-staged');
      write(root, 'readable', 'readable-content');
      write(root, 'tracked', 'content');
      assert.equal(run(['add', 'preserved']).status, 0, '预先暂存应成功');
      // 输入：公开故障注入仅阻断 tracked；同次 add 先处理可读文件，再遇到读取失败
      remove = liteFs.inject({ op: 'readFileSync', path: root + '/tracked', code });
      const asyncAdd = async () => {
        const child = liteChildProcess.spawn('git', ['add', 'readable', 'tracked'], { cwd: root });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = await liteChildProcess.waitForClose(child);
        return { status: closed.code, signal: closed.signal, stdout, stderr };
      };
      for (const execute of [() => run(['add', 'readable', 'tracked']), asyncAdd]) {
        const failed = await execute();
        // 预期 1：通过命令回包报告读取失败，不能返回成功或提前输出成功内容
        assert.equal(failed.status, 128, `${code} 应使 add 失败`);
        assert.equal(failed.stdout, '', '失败时不应有成功输出');
        assert.ok(failed.stderr.includes(code), '错误回包应保留底层错误码');
        // 预期 2：保留旧暂存项，不将同次操作的部分可读文件写入索引
        assert.equal(run(['ls-files']).stdout, 'preserved\n', '失败后索引应保持原状');
      }
      remove(); remove = undefined;
      // 预期 3：移除故障后两个文件均可正常暂存
      assert.equal(run(['add', 'readable', 'tracked']).status, 0, '移除故障后应能正常暂存');
      assert.equal(run(['ls-files']).stdout, 'preserved\nreadable\ntracked\n', '恢复后应包含所有暂存项');
    }
  } finally { remove?.(); done(); }
});

/** 场景：文件删除仍作为工作树差异处理，不能误报文件读取故障。 */
test('工作树删除：diff 展示删除，add 正常暂存删除', () => {
  const done = setup();
  try {
    const root = '/mock/git-deleted-read';
    const run = volumeGit(root);
    run(['init', '-q', '-b', 'main']);
    write(root, 'tracked', 'content\n');
    run(['add', 'tracked']);
    assert.equal(run(['commit', '-q', '-m', 'baseline']).status, 0, '基线提交应成功');
    // 输入：经公共文件接口删除已提交的工作树文件，再调用 Git 命令
    liteFs.unlinkSync(root + '/tracked');
    const diff = run(['diff', 'HEAD', '--', 'tracked']);
    // 预期：缺失文件表现为删除，读取逻辑不会将 ENOENT 当成不可恢复故障
    assert.equal(diff.status, 0, '工作树文件删除仍应能查看差异');
    assert.match(diff.stdout, /\+\+\+ \/dev\/null/, '差异应标明文件已删除');
    assert.match(diff.stdout, /-content/, '差异应包含删除的文件内容');
    assert.equal(run(['add', 'tracked']).status, 0, '应能正常暂存删除');
    assert.equal(run(['ls-files']).stdout, '', '已删除文件应从索引移除');
  } finally { done(); }
});

/** 场景：磁盘写满通过公共故障接口注入，Git 返回失败而非抛出未处理异常。 */
test('Git 写入失败：ENOSPC 通过命令结果报告，撤销后可恢复', () => {
  const done = setup();
  let remove;
  try {
    const run = volumeGit('/mock/git-full');
    run(['init', '-q', '-b', 'main']);
    write('/mock/git-full', 'tracked', 'content');
    // 输入：模拟本次暂存期间整个文件系统无法写入，不指定 Git 内部布局路径
    remove = liteFs.inject({ op: 'writeFileSync', code: 'ENOSPC' });
    const result = run(['add', 'tracked']);
    // 预期：命令失败携带错误码，恢复写入能力后可继续操作
    assert.equal(result.status, 128, '写满应使暂存命令失败');
    assert.match(result.stderr, /ENOSPC/, '回包应包含底层写入失败原因');
    remove(); remove = undefined;
    assert.equal(run(['add', 'tracked']).status, 0, '恢复写入后应可暂存');
  } finally { remove?.(); done(); }
});


/* 剩余未覆盖行的黑盒用例设计（按本轮源文件行号）：
 * 133、154：截断真实/内存仓库的标准 .git/HEAD，再经 spawnSync('git', ['status'/'commit'])
 * 对比无效仓库的错误码、stderr 和文件副作用；不直接调用 HEAD 解析函数。
 * 231：经 spawnSync('git', ['check-ignore', '']) 提交空路径参数，与真实 Git 的无效 pathspec
 * 结果对照。原生 Git 返回 128；当前逻辑可能只返回未匹配，需作为行为差异处理。
 * 上述防御输入尚未作为通过用例，不能据此宣称这些行已经覆盖或行为已经一致。
 */
