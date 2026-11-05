// lite-cmd-os 门面用例（node:test 形态，可 `node --test` 或直跑）：OS 命令集——open/ls/pwd/cwd/
// kill + 常用文件命令 mkdir/rm/cp/mv/cat/touch/test（文件类全部桥接 lite-fs：作用域随其 mock
// 状态——内存卷或真实盘）+ shell 内建 cd/exit（cd 沿用 chdir 校验、exit 沿用 ProcessExitError
// 语义——lite-process 的 chdir/exit/kill 转调本命令集）。导入即向 lite-cmd-mgr 登记。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeReferenceEnv } from './native-reference-env.mjs';
import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import { liteProcess, ProcessExitError } from '../lite-process.mjs';
import mgr from '../lite-cmd-mgr.mjs';

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));

// 逐用例装配：内存卷（排除本测试目录）+ spawn 边界 + 工作目录骨架
function setup() {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  return () => {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  };
}

/** 场景：在真实目录和内存卷重放文件命令，对比同步/异步输出、退出码与目录内容。 */
test('真实 OS 对照：文件命令、相对路径、错误输出与同步/异步退出码', async () => {
  // 输入：隔离真实临时目录，固定 C 语言环境与非终端输出；每轮使用全新工作目录
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-os-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = nativeReferenceEnv();
  const scenario = async (root, fileSystem, asynchronous) => {
    fileSystem.mkdirSync(root, { recursive: true });
    fileSystem.writeFileSync(path.join(root, 'source.txt'), 'alpha\n');
    fileSystem.writeFileSync(path.join(root, 'second.txt'), 'beta');
    fileSystem.writeFileSync(path.join(root, '.hidden'), 'secret');
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '<root>');
    const run = async (command, args = [], input) => {
      const options = { cwd: root, env, encoding: 'utf8' };
      let response;
      if (asynchronous) {
        const child = liteChildProcess.spawn(command, args, options);
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = liteChildProcess.waitForClose(child);
        child.stdin.end(input);
        const { code, signal } = await closed;
        response = { status: code, signal, stdout, stderr };
      } else {
        const result = liteChildProcess.spawnSync(command, args, { ...options, input });
        assert.equal(result.error, undefined, `${command} 应能启动`);
        response = { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
      }
      responses.push({ command, args, ...response, stdout: normalize(response.stdout), stderr: normalize(response.stderr) });
    };
    const tree = (directory = root, prefix = '') => fileSystem.readdirSync(directory).sort().flatMap(name => {
      const filename = path.join(directory, name), relative = prefix + name;
      return fileSystem.statSync(filename).isDirectory() ? [[relative, 'directory'], ...tree(filename, relative + '/')]
        : [[relative, fileSystem.readFileSync(filename, 'utf8')]];
    });
    await run('echo', ['memory', 'echo']);
    await run('echo', ['-n', 'no-newline']);
    await run('echo', ['before', '-n', 'after']);
    await run('pwd');
    await run('ls', ['.']);
    await run('ls', ['-a', '.']);
    await run('ls', ['-A', '.']);
    await run('ls', ['source.txt']);
    await run('ls', ['missing']);
    await run('mkdir', ['-p', 'tree/sub']);
    await run('mkdir', ['-p', 'tree/sub']);
    await run('mkdir', ['tree']);
    await run('mkdir', ['one', 'two']);
    await run('mkdir', ['tree', 'three']);
    await run('touch', ['empty.txt', 'source.txt']);
    await run('touch', ['missing/file', 'after-error.txt']);
    await run('cp', ['source.txt', 'copied.txt']);
    await run('cp', ['source.txt', 'one']);
    await run('cp', ['second.txt', 'tree/sub/value']);
    await run('cp', ['-R', 'tree', 'tree-copy']);
    await run('cp', ['-R', 'tree', 'two']);
    await run('cp', ['missing', 'unused']);
    await run('cp', ['tree', 'unused']);
    await run('cp', ['-R', 'tree', 'missing/dest']);
    await run('cp', ['source.txt', 'missing/dest']);
    await run('mv', ['copied.txt', 'renamed.txt']);
    await run('mv', ['renamed.txt', 'two']);
    await run('mv', ['missing', 'unused']);
    await run('cat', ['source.txt', 'second.txt']);
    await run('cat', ['source.txt', 'missing', 'second.txt']);
    await run('cat', ['tree']);
    await run('cat', ['-', 'second.txt', '-'], 'stdin\n');
    await run('test', ['-f', 'source.txt']);
    await run('test', ['-d', 'source.txt']);
    await run('test', ['-d', 'tree']);
    await run('test', ['-e', 'missing']);
    await run('test');
    await run('rm', ['tree']);
    await run('rm', ['missing', 'after-error.txt']);
    await run('rm', ['-f', 'missing']);
    await run('rm', ['-f']);
    responses.push({ stage: 'before-remove', tree: tree() });
    await run('rm', ['-rf', 'tree', 'tree-copy', 'one', 'two']);
    responses.push({ stage: 'after-remove', tree: tree() });
    return responses;
  };
  try {
    const expectedSync = await scenario(path.join(realRoot, 'sync'), nativeFs, false);
    const expectedAsync = await scenario(path.join(realRoot, 'async'), nativeFs, true);
    const done = setup();
    try {
      const actualSync = await scenario('/mock/reference/sync', liteFs, false);
      const actualAsync = await scenario('/mock/reference/async', liteFs, true);
      // 预期 1：同步命令的完整响应与文件副作用和原生命令一致
      assert.deepEqual(actualSync, expectedSync, '同步 OS 命令应与本机原生命令一致');
      // 预期 2：异步命令经 stdout/stderr/close 得到相同结果，文件副作用也一致
      assert.deepEqual(actualAsync, expectedAsync, '异步 OS 命令应与本机原生命令一致');
    } finally {
      done();
    }
  } finally {
    nativeFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：只向本用例启动的进程发信号，退出码借原生 shell 内建 exit 作对照。 */
test('真实 OS 对照：kill 探测、信号终止、失效 PID 与 exit 退出码', async () => {
  const env = nativeReferenceEnv();
  const scenario = async (memory, asynchronous) => {
    const responses = [];
    const target = liteChildProcess.spawn(memory ? 'node' : process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env });
    const targetClosed = liteChildProcess.waitForClose(target);
    await new Promise(resolve => target.once('spawn', resolve));
    const deadline = setTimeout(() => target.kill('SIGKILL'), 2000);
    const run = async (command, args) => {
      const executable = !memory && command === 'exit' ? '/bin/sh' : command;
      // exit 是 shell 内建，原生侧由 shell 解释，内存侧由命令条目执行。
      const argv = !memory && command === 'exit' ? ['-c', 'exit "$1"', 'reference', args[0]] : args;
      let result;
      if (asynchronous) {
        const child = liteChildProcess.spawn(executable, argv, { env });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = await liteChildProcess.waitForClose(child);
        result = { status: closed.code, signal: closed.signal, stdout, stderr };
      } else {
        const response = liteChildProcess.spawnSync(executable, argv, { env, encoding: 'utf8' });
        assert.equal(response.error, undefined, `${command} 应能启动`);
        result = { status: response.status, signal: response.signal, stdout: response.stdout, stderr: response.stderr };
      }
      responses.push({ command, args: args.map(arg => arg === String(target.pid) ? '<pid>' : arg), ...result,
        stderr: result.stderr.replaceAll(String(target.pid), '<pid>') });
      return result;
    };
    try {
      // 输入：信号 0 仅探测存活，再发送 TERM，最后对已退出的自有 PID 探测和终止
      const probe = await run('kill', ['-0', String(target.pid)]);
      assert.equal(probe.status, 0, '信号 0 应成功探测本用例的活动进程');
      await run('kill', ['-s', '0', String(target.pid)]);
      await run('kill', ['-s', 'TERM', String(target.pid)]);
      responses.push({ targetClosed: await targetClosed });
      await run('kill', ['-0', String(target.pid)]);
      await run('kill', [String(target.pid)]);
      for (const code of ['0', '3', '255', '256', '-1']) await run('exit', [code]);
      return responses;
    } finally {
      clearTimeout(deadline);
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      await targetClosed;
    }
  };
  const expectedSync = await scenario(false, false);
  const expectedAsync = await scenario(false, true);
  const done = setup();
  try {
    // 预期 1：同步 kill 回包、目标进程终态与 exit 的 8 位退出码对齐原生
    assert.deepEqual(await scenario(true, false), expectedSync, '同步 kill/exit 应与原生命令一致');
    // 预期 2：异步执行得到相同输出和终态
    assert.deepEqual(await scenario(true, true), expectedAsync, '异步 kill/exit 应与原生命令一致');
  } finally {
    done();
  }
});

/** 场景：导入即登记——OS 命令集全部命令在 mgr 注册表可寻址；绝对路径形态经前缀映射可执行。 */
test('导入即登记：OS 命令集全部在名单、cd/exit 内建在册、/usr/bin/open 前缀映射可执行', () => {
  // 输入：读 mgr 注册表自省名单；spawnSync 绝对路径形态的 open
  const paths = mgr.t_defined();
  const wanted = [
    '/mock-cmd/usr/bin/open', '/mock-cmd/usr/bin/kill',
    '/mock-cmd/bin/ls', '/mock-cmd/bin/pwd', '/mock-cmd/bin/cwd',
    '/mock-cmd/bin/mkdir', '/mock-cmd/bin/rm', '/mock-cmd/bin/cp', '/mock-cmd/bin/mv',
    '/mock-cmd/bin/cat', '/mock-cmd/bin/touch', '/mock-cmd/bin/test',
    '/mock-cmd/bin/cd', '/mock-cmd/bin/exit',
  ];
  // 预期 1：全部命令完整路径在登记名单
  assert.ok(wanted.every((p) => paths.includes(p)), '全部 OS 命令应在登记名单');
  // 预期 2：chdir 不在名单（目录切换的命令面是 cd 内建；chdir 是 process 门面语义）
  assert.equal(mgr.command('chdir'), null, 'chdir 不应登记为命令');
  const done = setup();
  try {
    const r = liteChildProcess.spawnSync('/usr/bin/open', ['/anywhere'], {});
    // 预期 3：绝对路径形态经前缀映射到 open 实现（行为验证：成功空回包）
    assert.equal(r.status, 0, '/usr/bin/open 应前缀映射到 open 实现并可执行');
  } finally {
    done();
  }
});

/** 场景：open 桌面动作——内存世界一律成功，无输出。 */
test('open：同步/异步面一律成功无输出', () => {
  const done = setup();
  try {
    // 输入：spawnSync /usr/bin/open 打开目录
    const r = liteChildProcess.spawnSync('/usr/bin/open', ['/mock/project'], {});
    // 预期 1：status 0
    assert.equal(r.status, 0, 'open 应成功');
    // 预期 2：无输出
    assert.equal(r.stdout + r.stderr, '', 'open 应无输出');
  } finally {
    done();
  }
});

/** 场景：ls 桥接 lite-fs——列内存卷目录，回命令行形态名单；缺失目录按失败收场。 */
test('ls：内存卷目录回命令行名单、缺失目录失败', () => {
  const done = setup();
  try {
    // 输入：卷内建目录写入两个文件后 spawnSync ls
    liteFs.writeFileSync('/mock/project/b.md', '2');
    liteFs.writeFileSync('/mock/project/a.txt', '1');
    const ls = liteChildProcess.spawnSync('ls', ['/mock/project'], { encoding: 'utf8' });
    // 预期 1：ls 成功
    assert.equal(ls.status, 0, 'ls 应成功');
    // 预期 2：stdout 为逐行名单
    assert.equal(ls.stdout, 'a.txt\nb.md\n', 'stdout 应为命令行形态名单');
    // 输入：ls 不存在的目录
    const missing = liteChildProcess.spawnSync('ls', ['/mock/project/none'], { encoding: 'utf8' });
    // 预期 3：按失败收场
    assert.equal(missing.status, 1, '缺失目录应失败');
    // 预期 4：stderr 与系统 ls 的缺失目录错误一致
    assert.equal(missing.stderr, 'ls: /mock/project/none: No such file or directory\n', 'stderr 应与系统 ls 的缺失目录错误一致');
  } finally {
    done();
  }
});

/** 场景：pwd/cwd 同源——回显 liteProcess.cwd()，假世界即虚拟当前目录、真实世界即 process.cwd()。 */
test('pwd/cwd：与 liteProcess.cwd() 同源（假世界/真实世界各自口径）', () => {
  const done = setup();
  try {
    // 输入：安装虚拟当前目录后 spawnSync pwd
    liteProcess.t_mock({ cwd: '/mock/project' });
    const pwd = liteChildProcess.spawnSync('pwd', [], { encoding: 'utf8' });
    // 预期 1：假世界回显虚拟当前目录
    assert.equal(pwd.stdout, '/mock/project\n', '假世界应回显虚拟 cwd');
    liteProcess.t_unmock();
    // 输入：真实世界 spawnSync cwd
    const real = liteChildProcess.spawnSync('cwd', [], { encoding: 'utf8' });
    // 预期 2：真实世界回显 process.cwd()
    assert.equal(real.stdout, `${process.cwd()}\n`, '真实世界应回显 process.cwd()');
  } finally {
    liteProcess.t_unmock();
    done();
  }
});

/** 场景：mkdir/rm 常用形态——-p 递归幂等、无 -p 重名失败、-rf 删目录树、无 -r 删目录失败。 */
test('mkdir/rm：-p 幂等、重名失败、-rf 删树、无 -r 删目录失败', () => {
  const done = setup();
  try {
    // 输入：mkdir -p 深路径（两次验证幂等）
    const p1 = liteChildProcess.spawnSync('mkdir', ['-p', '/mock/project/d/e'], {});
    const p2 = liteChildProcess.spawnSync('mkdir', ['-p', '/mock/project/d/e'], {});
    // 预期 1：递归创建成功
    assert.equal(p1.status, 0, 'mkdir -p 应成功');
    // 预期 2：重复创建幂等成功
    assert.equal(p2.status, 0, 'mkdir -p 重复应幂等成功');
    // 预期 3：目录确实创建（经 lite-fs 侧验证）
    assert.equal(liteFs.existsSync('/mock/project/d/e'), true, '目录应已创建');
    // 输入：无 -p 创建已存在目录
    const dup = liteChildProcess.spawnSync('mkdir', ['/mock/project/d'], {});
    // 预期 4：非递归重名失败
    assert.equal(dup.status, 1, '无 -p 重名应失败');
    // 输入：目录树内建文件，rm -rf 整树
    liteFs.writeFileSync('/mock/project/d/e/f.txt', 'x');
    const rmrf = liteChildProcess.spawnSync('rm', ['-rf', '/mock/project/d'], {});
    // 预期 5：递归强删成功
    assert.equal(rmrf.status, 0, 'rm -rf 应成功');
    assert.equal(liteFs.existsSync('/mock/project/d'), false, '目录树应已删除');
    // 输入：无 -r 删目录
    liteFs.mkdirSync('/mock/project/dir2', { recursive: true });
    const rmdir = liteChildProcess.spawnSync('rm', ['/mock/project/dir2'], {});
    // 预期 6：无 -r 删目录失败
    assert.equal(rmdir.status, 1, '无 -r 删目录应失败');
  } finally {
    done();
  }
});

/** 场景：cp/mv——单文件复制、递归复制子树、mv 改名且内容保留。 */
test('cp/mv：单文件/递归子树/改名保内容', () => {
  const done = setup();
  try {
    // 输入：写入源文件后 cp 单文件
    liteFs.writeFileSync('/mock/project/src.txt', 'hello');
    const cp = liteChildProcess.spawnSync('cp', ['/mock/project/src.txt', '/mock/project/dst.txt'], {});
    // 预期 1：单文件复制成功
    assert.equal(cp.status, 0, 'cp 应成功');
    // 预期 2：目标内容与源一致
    assert.equal(liteFs.readFileSync('/mock/project/dst.txt', 'utf8'), 'hello', '复制内容应一致');
    // 输入：cp -r 复制子树
    liteFs.mkdirSync('/mock/project/tree/sub', { recursive: true });
    liteFs.writeFileSync('/mock/project/tree/sub/a', '1');
    const cpr = liteChildProcess.spawnSync('cp', ['-r', '/mock/project/tree', '/mock/project/tree2'], {});
    // 预期 3：递归复制成功
    assert.equal(cpr.status, 0, 'cp -r 应成功');
    // 预期 4：子树内容复制到位
    assert.equal(liteFs.readFileSync('/mock/project/tree2/sub/a', 'utf8'), '1', '子树内容应复制');
    // 输入：mv 改名
    const mv = liteChildProcess.spawnSync('mv', ['/mock/project/dst.txt', '/mock/project/renamed.txt'], {});
    // 预期 5：改名成功且内容保留
    assert.equal(mv.status, 0, 'mv 应成功');
    assert.equal(liteFs.readFileSync('/mock/project/renamed.txt', 'utf8'), 'hello', '改名后内容应保留');
    assert.equal(liteFs.existsSync('/mock/project/dst.txt'), false, '原路径应消失');
  } finally {
    done();
  }
});

/** 场景：cat/touch——多文件拼接输出、touch 建空文件、已存在文件 touch 不清空。 */
test('cat/touch：多文件拼接、touch 建空文件与幂等不清空', () => {
  const done = setup();
  try {
    // 输入：写两个文件后 cat 拼接
    liteFs.writeFileSync('/mock/project/1.txt', 'aa\n');
    liteFs.writeFileSync('/mock/project/2.txt', 'bb');
    const cat = liteChildProcess.spawnSync('cat', ['/mock/project/1.txt', '/mock/project/2.txt'], { encoding: 'utf8' });
    // 预期 1：cat 成功
    assert.equal(cat.status, 0, 'cat 应成功');
    // 预期 2：stdout 按参数序拼接
    assert.equal(cat.stdout, 'aa\nbb', 'stdout 应按参数序拼接');
    // 输入：cat 不存在的文件
    const miss = liteChildProcess.spawnSync('cat', ['/mock/project/none'], { encoding: 'utf8' });
    // 预期 3：缺失文件失败
    assert.equal(miss.status, 1, 'cat 缺失文件应失败');
    // 输入：touch 新文件两次，再 touch 已有内容的文件
    liteChildProcess.spawnSync('touch', ['/mock/project/new.txt'], {});
    liteChildProcess.spawnSync('touch', ['/mock/project/new.txt'], {});
    liteChildProcess.spawnSync('touch', ['/mock/project/1.txt'], {});
    // 预期 4：touch 建立空文件
    assert.equal(liteFs.readFileSync('/mock/project/new.txt', 'utf8'), '', 'touch 应建空文件');
    // 预期 5：touch 已有内容文件不清空
    assert.equal(liteFs.readFileSync('/mock/project/1.txt', 'utf8'), 'aa\n', 'touch 不应清空既有内容');
  } finally {
    done();
  }
});

/** 场景：test 命令——-f/-d/-e 退出码判定（0 成立 / 1 不成立），无输出。 */
test('test：-f/-d/-e 退出码判定', () => {
  const done = setup();
  try {
    // 输入：建文件与目录后逐条件 spawnSync test
    liteFs.writeFileSync('/mock/project/f.txt', 'x');
    liteFs.mkdirSync('/mock/project/dir', { recursive: true });
    const isFile = liteChildProcess.spawnSync('test', ['-f', '/mock/project/f.txt'], {});
    const isDirOnFile = liteChildProcess.spawnSync('test', ['-d', '/mock/project/f.txt'], {});
    const exists = liteChildProcess.spawnSync('test', ['-e', '/mock/project/dir'], {});
    const notExists = liteChildProcess.spawnSync('test', ['-e', '/mock/project/none'], {});
    // 预期 1：-f 对文件成立（0）
    assert.equal(isFile.status, 0, '-f 文件应成立');
    // 预期 2：-d 对文件不成立（1）
    assert.equal(isDirOnFile.status, 1, '-d 对文件应不成立');
    // 预期 3：-e 对目录成立
    assert.equal(exists.status, 0, '-e 目录应成立');
    // 预期 4：-e 对缺失路径不成立
    assert.equal(notExists.status, 1, '-e 缺失应不成立');
    // 预期 5：判定无输出
    assert.equal(isFile.stdout + isFile.stderr, '', 'test 应无输出');
  } finally {
    done();
  }
});

/** 场景：文件命令异步面——spawn 形式同样生效（stdout/退出码经子进程事件到达）。 */
test('文件命令异步面：spawn cat 经子进程事件回内容与退出码', async () => {
  const done = setup();
  try {
    // 输入：写文件后以 spawn（异步面）执行 cat
    liteFs.writeFileSync('/mock/project/x.txt', 'async-out');
    const child = liteChildProcess.spawn('cat', ['/mock/project/x.txt']);
    const closed = liteChildProcess.waitForClose(child);
    const text = await new Promise((resolve) => child.stdout.once('data', (c) => resolve(String(c))));
    const { code } = await closed;
    // 预期 1：stdout 内容经事件到达
    assert.equal(text, 'async-out', 'stdout 应经事件到达');
    // 预期 2：退出码 0
    assert.equal(code, 0, '退出码应为 0');
  } finally {
    done();
  }
});

/** 场景：kill 命令信号形态——-<数字号位> 与 -s <SIGNAME> 寻址内存子进程。 */
test('kill 信号形态：-9/-s SIGHUP 按 pid 发信号', async () => {
  const done = setup();
  try {
    // 输入：spawn 目标子进程，分别以 -9 与 -s SIGHUP 杀两个目标
    const a = liteChildProcess.spawn('node', []);
    const closedA = liteChildProcess.waitForClose(a);
    liteChildProcess.spawn('kill', ['-9', String(a.pid)]);
    const ra = await closedA;
    const b = liteChildProcess.spawn('node', []);
    const closedB = liteChildProcess.waitForClose(b);
    liteChildProcess.spawn('kill', ['-s', 'SIGHUP', String(b.pid)]);
    const rb = await closedB;
    // 预期 1：-9 映射 SIGKILL
    assert.equal(ra.signal, 'SIGKILL', '-9 应映射 SIGKILL');
    // 预期 2：-s SIGHUP 传信号名
    assert.equal(rb.signal, 'SIGHUP', '-s 应按信号名传递');
    // 预期 3：两种形态退出码均为 null（信号终止）
    assert.equal(ra.code, null, '信号终止退出码应为 null');
  } finally {
    done();
  }
});

/** 场景：cd 命令（shell 内建）——沿用 chdir 校验：目录切换回写进程环境面、缺失目录失败、
 * 假世界外（liteProcess 未 mock）按失败收场（真实子进程改不了父进程 cwd）。 */
test('cd 命令：切换回写 liteProcess.cwd、相对路径按当前 cwd 解析、缺失失败、假世界外失败', () => {
  const done = setup();
  try {
    // 输入：假世界（虚拟 cwd=/mock/project）下 spawnSync cd 切子目录
    liteProcess.t_mock({ cwd: '/mock/project' });
    liteFs.mkdirSync('/mock/project/sub', { recursive: true });
    const cd = liteChildProcess.spawnSync('cd', ['sub'], {});
    // 预期 1：切换成功
    assert.equal(cd.status, 0, 'cd 应成功');
    // 预期 2：进程环境面 cwd 已回写（liteProcess.chdir 同一实现）
    assert.equal(liteProcess.cwd(), '/mock/project/sub', 'cd 应回写 liteProcess.cwd');
    // 输入：cd 到不存在的目录
    const miss = liteChildProcess.spawnSync('cd', ['nope'], {});
    // 预期 3：缺失目录失败（沿用 chdir 校验）
    assert.equal(miss.status, 1, 'cd 缺失目录应失败');
    // 预期 4：cwd 不被失败切换改动
    assert.equal(liteProcess.cwd(), '/mock/project/sub', '失败切换不应改 cwd');
    // 输入：无参数 cd
    const none = liteChildProcess.spawnSync('cd', [], {});
    // 预期 5：无参数按 usage 失败
    assert.equal(none.status, 1, '无参数 cd 应失败');
    liteProcess.t_unmock();
    // 输入：假世界外（liteProcess 未 mock）spawnSync cd
    const outside = liteChildProcess.spawnSync('cd', ['/mock/project'], {});
    // 预期 6：假世界外按失败收场（真实子进程改不了父进程 cwd）
    assert.equal(outside.status, 1, '假世界外 cd 应失败');
  } finally {
    liteProcess.t_unmock();
    done();
  }
});

/** 场景：exit 命令（shell 内建）——同步面记录退出意图并上抛 ProcessExitError；异步面按子进程
 * 以该码退出收场（spawn 派遣层转换，不外抛）。 */
test('exit 命令：spawnSync 转子进程退出码、spawn 按码收场、退出意图入账', async () => {
  const done = setup();
  try {
    liteProcess.t_mock({ cwd: '/mock/project' });
    // 输入：spawnSync exit 3
    const sync = liteChildProcess.spawnSync('exit', ['3'], {});
    // 预期 1：同步面按该退出码收场（ProcessExitError 被派遣层转换为结果对象）
    assert.equal(sync.status, 3, 'spawnSync exit 应按退出码 3 收场');
    // 输入：异步 spawn exit 5
    const child = liteChildProcess.spawn('exit', ['5']);
    const closed = await liteChildProcess.waitForClose(child);
    // 预期 2：异步面子进程以该码退出
    assert.deepEqual(closed, { code: 5, signal: null }, 'spawn exit 应以码 5 退出');
    // 预期 3：退出意图均入账（liteProcess.t_exitCodes 可观测）
    assert.deepEqual(liteProcess.t_exitCodes(), [3, 5], '退出意图应入账');
    // 输入：无参数 exit（缺省码 0）
    const zero = liteChildProcess.spawnSync('exit', [], {});
    // 预期 4：缺省退出码 0
    assert.equal(zero.status, 0, '无参数 exit 应按码 0 收场');
  } finally {
    liteProcess.t_unmock();
    done();
  }
});


/** 场景：kill 支持直接用信号名作为选项，实际信号与退出状态一致。 */
test('kill 信号名选项：-TERM 投递 SIGTERM 并移除活动 PID', async () => {
  const done = setup();
  try {
    // 输入：启动活动命令，再通过公共 spawnSync 调用 kill -TERM
    const child = liteChildProcess.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
    const closed = liteChildProcess.waitForClose(child);
    const sent = liteChildProcess.spawnSync('kill', ['-TERM', String(child.pid)], { encoding: 'utf8' });
    // 预期：信号送达，终态为 SIGTERM，后续 PID 探测失败
    assert.equal(sent.status, 0, '信号名选项应成功投递');
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' }, '退出信号应为 SIGTERM');
    assert.equal(liteChildProcess.spawnSync('kill', ['-0', String(child.pid)]).status, 1, '退出后的 PID 不应继续存在');
  } finally { done(); }
});
