// lite-process 门面用例（node:test 形态，可 `node --test` 或直跑）：process 替身门面——
// mock({ cwd?, argv?, env?, pid? }) 进假世界 / unmock 回原生透传；固定字段 execPath 取 node
// 命令实现路径；chdir/exit/kill 转调命令实现（cd/exit/kill——lite-cmd-os，经 lite-cmd-mgr
// 动态查询：cd 沿用目录校验、exit 沿用 ProcessExitError 语义、kill 最终到 lite-child_process
// 的 signal 投递原语）；命令上下文安装 argv（原生 argv 同步替换 + unmock 恢复）。
// 命令注册与模拟执行已迁 lite-cmd-mgr（本门面无 register/runProcess 面）。用例注释格式：
// 方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import { liteProcess, ProcessExitError } from '../lite-process.mjs';
import '../lite-cmd-os.mjs'; // cd/exit/kill 命令实现（chdir/exit/kill 转调依赖）

const NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));

// 逐用例装配：内存卷 + spawn 边界 + 进程环境面（kill 透传与 cd 落点依赖）
function setup(worldOptions = {}) {
  liteFs.mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project/sub', { recursive: true });
  liteChildProcess.mock();
  liteProcess.mock({ cwd: '/mock/project', ...worldOptions });
  return () => {
    liteProcess.unmock();
    liteChildProcess.unmock();
    liteFs.unmock();
  };
}

/** 场景：真实 process 与虚拟 process 重放目录、环境及信号操作，退出由原生 Node 结果作参照。 */
test('真实 Process 对照：cwd/chdir、argv/env、字段、信号与退出码', async () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-process-reference-'));
  const root = realFs.realpathSync(temporary), originalCwd = process.cwd(), originalArgv = process.argv;
  const originalEnv = process.env.LITE_PROCESS_REFERENCE;
  const scenario = (proc, directory) => {
    const results = [];
    const normalize = value => typeof value === 'string' ? value.replaceAll(directory, '<root>') : value;
    results.push({ cwd: normalize(proc.cwd()), args: proc.argv.slice(1), platform: proc.platform, version: proc.version,
      pidIsInteger: Number.isInteger(proc.pid), executableAbsolute: path.isAbsolute(proc.execPath) });
    proc.env.LITE_PROCESS_REFERENCE = 'changed';
    results.push({ environment: proc.env.LITE_PROCESS_REFERENCE });
    delete proc.env.LITE_PROCESS_REFERENCE;
    results.push({ environmentDeleted: !('LITE_PROCESS_REFERENCE' in proc.env) });
    for (const target of ['sub', '..', 'missing', 'file']) {
      try { results.push({ target, result: proc.chdir(target), cwd: normalize(proc.cwd()) }); }
      catch (error) { results.push({ target, code: error.code, errno: error.errno, syscall: error.syscall, path: normalize(error.path), dest: error.dest, message: normalize(error.message), cwd: normalize(proc.cwd()) }); }
    }
    results.push({ alive: proc.kill(proc.pid, 0) });
    return results;
  };
  try {
    // 输入：真实 cwd 与 argv 的临时变更均在 finally 恢复；信号 0 只探测当前进程
    realFs.mkdirSync(root + '/sub'); realFs.writeFileSync(root + '/file', 'x');
    process.chdir(root); process.argv = [process.execPath, 'reference.mjs', '--flag'];
    const expected = scenario(process, root);
    process.chdir(originalCwd); process.argv = originalArgv;
    const exitResults = ['0', '7', '256', '-1'].map(code => liteChildProcess.spawnSync(process.execPath, ['-e', `process.exit(${code})`]));
    const nativeExits = exitResults.map(result => result.status);
    const signalError = proc => {
      try { proc.kill(exitResults.at(-1).pid, 0); }
      catch (error) { return { code: error.code, errno: error.errno, syscall: error.syscall, message: error.message }; }
    };
    const expectedSignalError = signalError(process);
    const done = setup({ cwd: '/mock/process-reference', argv: [NODE_COMMAND_PATH, 'reference.mjs', '--flag'] });
    try {
      liteFs.mkdirSync('/mock/process-reference/sub', { recursive: true });
      liteFs.writeFileSync('/mock/process-reference/file', 'x');
      // 虚拟信号表以自有命令 PID 登记，替换 proc.pid 后探测同一个活动命令
      const target = liteChildProcess.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
      liteProcess.unmock();
      liteProcess.mock({ cwd: '/mock/process-reference', argv: [NODE_COMMAND_PATH, 'reference.mjs', '--flag'], pid: target.pid });
      await new Promise(resolve => target.once('spawn', resolve));
      try {
        // 预期 1：目录变化、环境读写、字段与信号探测结果一致；pid/execPath 只核对对应语义
        assert.deepEqual(scenario(liteProcess, '/mock/process-reference'), expected, '虚拟 Process 应与原生 Process 的已测行为一致');
        const exits = ['0', '7', '256', '-1'].map(code => {
          try { liteProcess.exit(Number(code)); } catch (error) { assert.ok(error instanceof ProcessExitError); return error.exitCode; }
        });
        // 预期 2：记录退出意图的异常携带与原生 Node 退出相同的 8 位退出码
        assert.deepEqual(exits, nativeExits, '虚拟退出码应与原生退出码一致');
        // 预期 3：只探测本用例已退出的 PID，无此进程的错误字段与原生一致
        assert.equal(expectedSignalError.code, 'ESRCH', '已退出的自有进程应不存在');
        assert.deepEqual(signalError(liteProcess), expectedSignalError, '无此进程的信号错误应与原生一致');
      } finally { const closed = liteChildProcess.waitForClose(target); target.kill(); await closed; }
    } finally { done(); }
  } finally {
    process.chdir(originalCwd); process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.LITE_PROCESS_REFERENCE; else process.env.LITE_PROCESS_REFERENCE = originalEnv;
    realFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：mock 字段——cwd/argv/env/pid 构造时给定，各自生效；env 为可写对象支持运行中改。 */
test('mock 字段：cwd/argv/env/pid 构造时给定并生效、env 运行中可改', () => {
  const done = setup({ argv: ['node', 'entry.mjs', '--flag'], env: { ATB_PROBE: 'lit' }, pid: 4321 });
  try {
    // 输入：读假世界各字段
    // 预期 1：cwd 为构造给定的初始当前目录
    assert.equal(liteProcess.cwd(), '/mock/project', 'cwd 应为给定值');
    // 预期 2：argv 为构造给定的子进程口径
    assert.deepEqual(liteProcess.argv, ['node', 'entry.mjs', '--flag'], 'argv 应为给定值');
    // 预期 3：env 为构造给定的对象
    assert.equal(liteProcess.env.ATB_PROBE, 'lit', 'env 应为给定对象');
    // 预期 4：pid 为构造给定值
    assert.equal(liteProcess.pid, 4321, 'pid 应为给定值');
    // 输入：运行中改 env 字段
    liteProcess.env.ATB_RUNTIME = 'changed';
    // 预期 5：运行中改生效（可写对象）
    assert.equal(liteProcess.env.ATB_RUNTIME, 'changed', 'env 运行中改应生效');
  } finally {
    delete process.env.ATB_RUNTIME;
    done();
  }
});

/** 场景：缺省字段——未给 argv/env/pid 时的合理缺省（argv 拷贝原生、env 与真实单轨同源、pid 同宿主）。 */
test('mock 缺省字段：argv 拷贝原生、env 与真实单轨、pid 同宿主、platform/version 只读同源', () => {
  const done = setup();
  try {
    // 输入：仅给 cwd 进入假世界，读缺省字段
    // 预期 1：argv 缺省为原生 argv 拷贝
    assert.deepEqual(liteProcess.argv, process.argv, 'argv 缺省应为原生拷贝');
    // 预期 2：env 缺省与真实 process.env 同源（单轨：spawn options.env 合并对入口加载可见）
    assert.equal(liteProcess.env, process.env, 'env 缺省应与真实 env 单轨同源');
    // 预期 3：pid 缺省与宿主进程同值
    assert.equal(liteProcess.pid, process.pid, 'pid 缺省应与宿主同值');
    // 预期 4：platform/version 只读同源（进程内执行的合理缺省）
    assert.equal(liteProcess.platform, process.platform, 'platform 应与本机同源');
    assert.equal(liteProcess.version, process.version, 'version 应与本机同源');
  } finally {
    done();
  }
});

/** 场景：mock 幂等与非法入参——重复 mock 返回既有世界；cwd 缺席或相对路径拒绝。 */
test('mock 幂等：重复调用返回既有世界；cwd 缺席/相对路径拒绝', () => {
  const done = setup();
  try {
    // 输入：重复 mock（幂等口径）
    const again = liteProcess.mock({ cwd: '/another' });
    // 预期 1：返回既有世界（cwd 不被改写）
    assert.equal(liteProcess.cwd(), '/mock/project', '重复 mock 不应改写世界');
    assert.ok(again, 'mock 应返回世界对象');
  } finally {
    done();
  }
  // 输入：卸下世界后以非法入参 mock
  // 预期 2：cwd 缺席拒绝
  assert.throws(() => liteProcess.mock({}), /cwd/, 'cwd 缺席应拒绝');
  // 预期 3：相对路径拒绝
  assert.throws(() => liteProcess.mock({ cwd: 'relative/dir' }), /绝对路径/, '相对路径应拒绝');
});

/** 场景：execPath 固定值——假世界取 node 命令实现路径（lite-cmd-node 常量），真实世界透传。 */
test('execPath：假世界为 node 命令实现路径、真实世界透传 process.execPath', () => {
  const done = setup();
  try {
    // 输入：假世界读 execPath
    // 预期 1：为 node 命令实现路径常量
    assert.equal(liteProcess.execPath, NODE_COMMAND_PATH, '假世界 execPath 应为 node 命令路径');
    // 预期 2：常量值为 /mock-cmd/usr/local/bin/node
    assert.equal(NODE_COMMAND_PATH, '/mock-cmd/usr/local/bin/node', 'node 命令路径应为命名空间内完整路径');
  } finally {
    done();
  }
  // 输入：unmock 后（真实世界）读 execPath
  // 预期 3：透传 process.execPath
  assert.equal(liteProcess.execPath, process.execPath, '真实世界应透传 process.execPath');
});

/** 场景：unmock 恢复原生——cwd/argv/pid/env/execPath 全部回到真实 process 对应值。 */
test('unmock 恢复原生：各字段回真实透传', () => {
  const done = setup({ argv: ['node', 'x'], pid: 99 });
  try {
    liteProcess.unmock();
    // 输入：卸下假世界后读各字段
    // 预期 1：cwd 回 process.cwd()
    assert.equal(liteProcess.cwd(), process.cwd(), 'cwd 应回真实值');
    // 预期 2：argv 回 process.argv
    assert.equal(liteProcess.argv, process.argv, 'argv 应回真实值');
    // 预期 3：pid 回 process.pid
    assert.equal(liteProcess.pid, process.pid, 'pid 应回真实值');
    // 预期 4：env 回 process.env
    assert.equal(liteProcess.env, process.env, 'env 应回真实值');
    // 预期 5：exitCodes 账本清空（世界已卸）
    assert.deepEqual(liteProcess.exitCodes(), [], '卸下世界后账本应为空');
  } finally {
    done();
  }
});

/** 场景：chdir 转调 cd 命令——相对路径按当前 cwd 解析、切换生效；缺失目录按 ENOENT 抛错。 */
test('chdir→cd：相对/绝对路径切换生效、缺失目录 ENOENT、非目录 ENOTDIR', () => {
  const done = setup();
  try {
    // 输入：相对路径 chdir（按当前虚拟 cwd 解析）
    liteProcess.chdir('sub');
    // 预期 1：cwd 切换到解析目标
    assert.equal(liteProcess.cwd(), '/mock/project/sub', '相对路径应按当前 cwd 解析并切换');
    // 输入：绝对路径 chdir
    liteProcess.chdir('/mock/project');
    // 预期 2：绝对路径切换生效
    assert.equal(liteProcess.cwd(), '/mock/project', '绝对路径应切换生效');
    // 输入：chdir 到不存在的目录
    // 预期 3：按 ENOENT 抛错（沿用 chdir 校验口径）
    assert.throws(() => liteProcess.chdir('nope'), (e) => e.code === 'ENOENT', '缺失目录应抛 ENOENT');
    // 输入：chdir 到文件路径
    liteFs.writeFileSync('/mock/project/f.txt', 'x');
    // 预期 4：非目录同样 ENOENT
    assert.throws(() => liteProcess.chdir('f.txt'), (e) => e.code === 'ENOTDIR', '非目录应抛 ENOTDIR');
    // 预期 5：失败的 chdir 不改当前目录
    assert.equal(liteProcess.cwd(), '/mock/project', '失败切换不应改当前目录');
  } finally {
    done();
  }
});

/** 场景：exit 转调 exit 命令——ProcessExitError 语义：退出码记录在案、向上抛出。 */
test('exit→ProcessExitError：退出码入账上抛、账本按序累计', () => {
  const done = setup();
  try {
    // 输入：假世界 exit(3)
    // 预期 1：上抛 ProcessExitError 且带退出码
    assert.throws(() => liteProcess.exit(3), (e) => e instanceof ProcessExitError && e.exitCode === 3, '应抛 ProcessExitError(3)');
    // 输入：再 exit()（缺省码 0）
    assert.throws(() => liteProcess.exit(), (e) => e.exitCode === 0, '缺省退出码应为 0');
    // 预期 2：账本按调用序累计
    assert.deepEqual(liteProcess.exitCodes(), [3, 0], '退出码账本应按序累计');
  } finally {
    done();
  }
});

/** 场景：kill 转调 kill 命令——信号投递到内存子进程（signal 原语）；无此进程按 ESRCH 抛错。 */
test('kill 透传：信号送达内存子进程、缺省 SIGTERM、无此进程 ESRCH', async () => {
  const done = setup();
  try {
    // 输入：spawn 替身子进程后经 liteProcess.kill 发 SIGINT
    const child = liteChildProcess.spawn('cat', []);
    const closed = liteChildProcess.waitForClose(child); // 先挂监听再触发
    const delivered = liteProcess.kill(child.pid, 'SIGINT');
    const result = await closed;
    // 预期 1：投递成功返回 true
    assert.equal(delivered, true, 'kill 应返回 true');
    // 预期 2：子进程按信号终止（退出码 null + 指定信号名）
    assert.deepEqual(result, { code: null, signal: 'SIGINT' }, '子进程应按 SIGINT 终止');
    // 输入：对已退出的 pid 再 kill
    // 预期 3：按 ESRCH 抛错（真实 process.kill 口径）
    assert.throws(() => liteProcess.kill(child.pid), (e) => e.code === 'ESRCH', '无此进程应抛 ESRCH');
    // 输入：数字信号形态 kill(pid, 9)
    const other = liteChildProcess.spawn('cat', []);
    const closedOther = liteChildProcess.waitForClose(other);
    liteProcess.kill(other.pid, 9);
    // 预期 4：数字号位映射 SIGKILL
    assert.equal((await closedOther).signal, 'SIGKILL', '数字信号应映射信号名');
  } finally {
    done();
  }
});

/** 场景：命令上下文安装 argv——门面视图与原生 process.argv 同步替换、unmock 恢复原值。 */
test('命令上下文：argv 安装同步到门面与宿主，unmock 恢复', () => {
  const nativeArgv = process.argv;
  const done = setup();
  try {
    // 输入：假世界安装子进程口径 argv
    mgr.defineUserCommand('argv-installer', {
      runSync(_args, ctx) { ctx.installArgv([NODE_COMMAND_PATH, '/mock/project/entry.mjs', '--after']); return { status: 0 }; },
    });
    assert.equal(liteChildProcess.spawnSync('argv-installer').status, 0, '命令上下文应能安装 argv');
    // 预期 1：门面视图为安装值
    assert.deepEqual(liteProcess.argv, [NODE_COMMAND_PATH, '/mock/project/entry.mjs', '--after'], '门面 argv 应为安装值');
    // 预期 2：原生 process.argv 同步替换（入口的主模块守卫读原生 argv）
    assert.deepEqual(process.argv, [NODE_COMMAND_PATH, '/mock/project/entry.mjs', '--after'], '原生 argv 应同步替换');
  } finally {
    done();
  }
  // 输入：unmock 后
  // 预期 3：原生 argv 恢复安装前原值
  assert.equal(process.argv, nativeArgv, 'unmock 应恢复原生 argv');
  // 输入：真实世界检查私有安装能力不作为公共接口导出
  assert.equal(liteProcess.installArgv, undefined, 'argv 安装方法只在文件内部使用');
  // 预期 4：真实世界安装为 no-op（真实进程 argv 不可伪造）
  assert.equal(process.argv, nativeArgv, '宿主 argv 应保持恢复后的原值');
});

/** 场景：命令寻址口径——chdir/exit 转调走配置寻址（命令在即语义在），不依赖卷内系统卷文件。 */
test('命令寻址口径：cd/exit 经 mgr 配置寻址（命令在即语义在，无须卷内文件）', () => {
  const done = setup();
  try {
    // 输入：先整卷删除 /mock-cmd 系统卷（模拟执行寻址必失败的世界），再直接 chdir
    liteFs.rmSync('/mock-cmd', { recursive: true, force: true });
    // 预期 1：转调走配置寻址（注册表命中即可）——系统卷不在也可切换
    liteProcess.chdir('/mock/project/sub');
    assert.equal(liteProcess.cwd(), '/mock/project/sub', 'chdir 不依赖系统卷已装');
    // 预期 2：exit 转调同口径（退出码入账并上抛）
    assert.throws(() => liteProcess.exit(2), ProcessExitError, 'exit 转调应同样可用');
    assert.deepEqual(liteProcess.exitCodes(), [2], '退出码应入账');
  } finally {
    done();
  }
});
