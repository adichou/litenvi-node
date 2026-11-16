// lite-child_process 门面用例（node:test 形态，可 `node --test` 或直跑）：默认转发真实
// node:child_process 的 spawn/exec/execFile 及其同步版本；mock() 设置内存实现——不真实起进程，(command, args)
// 经 lite-cmd-mgr._resolve 执行寻址（PATH 解析 + /mock-cmd 系统卷文件）后分派给登记的命令集
//（node → .mjs 进程内执行 / git → mini-git / ls → lite-fs 桥接；执行寻址须 lite-fs
// 内存卷）；所有命令调用统一入账（calls() 断言、reset() 清空），未注册命令 spawn 异步触发
// ENOENT 错误事件、spawnSync 返回失败对象，临时定制走 defineUserCommand，
// kill 触发 exit/close；
// unmock() 回真实实现。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteChildProcess from '../lite-child_process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';
import { t_install as t_installGit } from '../lite-cmd-git.mjs';
import { t_install as t_installNodeCommands } from '../lite-cmd-node.mjs';
import { t_install as t_installOsCommands } from '../lite-cmd-os.mjs';
import { ProcessExitError } from '../lite-process-exit-error.mjs';

// 系统命令集显式安装（导入不登记）：本文件用例 spawn node/npm 与 echo/kill/ls 等 OS 命令
t_installNodeCommands();
t_installOsCommands();

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));
t_installGit();

/** 场景：所有命令形态的异步执行都先等待故障闸门，放行或拒绝后按配置退出。 */
test('异步故障统一调度：Git/npm/node/OS 与用户命令等待同一 wait 规则', async () => {
  // 输入：真实异步、仅同步及双实现命令，分别注入放行、拒绝和仅 wait 三种故障配置
  const commands = [
    ['git', ['status']], ['npm', ['-v']], ['node', ['-v']], ['echo', ['builtin']],
    ['wait-sync-only', []], ['wait-async-only', []], ['wait-both', []],
  ];
  for (const outcome of ['resolve', 'reject', 'wait-only']) {
    liteFs.t_mock({ exclude: [EXCLUDED] });
    liteChildProcess.t_mock();
    let complete;
    const removers = [];
    let builtinRuns = 0;
    try {
      mgr.t_defineUserCommand('wait-sync-only', { i_runSync: () => { builtinRuns += 1; return { status: 0 }; } });
      mgr.t_defineUserCommand('wait-async-only', { i_run() { builtinRuns += 1; } });
      mgr.t_defineUserCommand('wait-both', {
        i_run() { builtinRuns += 1; }, i_runSync: () => { builtinRuns += 1; return { status: 0 }; },
      });
      const gate = new Promise((resolve, reject) => { complete = outcome === 'reject' ? reject : resolve; });
      const exit = outcome === 'wait-only' ? undefined : 7;
      const observed = commands.map(([command, args]) => {
        removers.push(mgr.command(command).t_inject({ wait: gate, exit, stderr: 'gate-failure\n', once: true }));
        const child = liteChildProcess.spawn(command, args);
        const record = { command, stderr: '', closes: 0, exits: 0 };
        child.stderr.on('data', chunk => { record.stderr += chunk; });
        child.on('exit', () => { record.exits += 1; });
        child.on('close', () => { record.closes += 1; });
        return { child, record, closed: liteChildProcess.waitForClose(child) };
      });
      await new Promise(resolve => setImmediate(resolve));
      // 预期 1：闸门未完成前，所有命令均不输出故障、不退出
      assert.deepEqual(observed.map(({ record }) => [record.stderr, record.exits, record.closes]),
        commands.map(() => ['', 0, 0]), `${outcome} 闸门未完成前均应等待`);
      // 预期 2：故障命中后不执行用户命令内置实现
      assert.equal(builtinRuns, 0, '故障应替换内置执行');
      // 输入：放行或拒绝闸门，拒绝同样只表示结束等待
      complete();
      const results = await Promise.all(observed.map(({ closed }) => closed));
      // 预期 3：所有命令按注入的退出码终止
      assert.deepEqual(results, commands.map(() => ({ code: exit ?? 1, signal: null })), '所有命令形态都应使用注入结果');
      // 预期 4：故障输出和终态事件均只发生一次
      assert.deepEqual(observed.map(({ record }) => [record.stderr, record.exits, record.closes]),
        commands.map(() => ['gate-failure\n', 1, 1]), '故障回包不得丢失或重复');
    } finally {
      complete?.();
      for (const remove of removers) remove();
      liteChildProcess.t_unmock();
      liteFs.t_unmock();
    }
  }
});

/** 场景：同步命令转异步时 once 只消费一次，等待期间终止后不再投递迟到回包。 */
test('同步回落：once 消费、钩子保留、kill 与卸载后丢弃迟到故障', async () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  let release;
  let releaseKilled;
  let releaseDisposed;
  try {
    // 输入：只实现 runSync 的命令安装钩子，连续排入两个一次性故障
    let builtinRuns = 0, hookRuns = 0;
    const entry = mgr.t_defineUserCommand('sync-fallback', {
      i_runSync: () => { builtinRuns += 1; return { status: 0, stdout: 'builtin\n' }; },
    });
    entry.t_onRun((_call, runBuiltin) => { hookRuns += 1; return { ...runBuiltin(), stdout: 'hooked\n' }; });
    const gate = new Promise(resolve => { release = resolve; });
    entry.t_inject({ wait: gate, exit: 5, once: true });
    entry.t_inject({ exit: 6, once: true });
    const first = liteChildProcess.waitForClose(liteChildProcess.spawn('sync-fallback'));
    const second = await liteChildProcess.waitForClose(liteChildProcess.spawn('sync-fallback'));
    // 预期 1：第二次调用只消费第二个故障
    assert.deepEqual(second, { code: 6, signal: null }, '故障不得重复消费');
    // 预期 2：两次故障均跳过钩子和内置实现
    assert.deepEqual([builtinRuns, hookRuns], [0, 0], '故障优先于钩子和内置执行');
    const third = liteChildProcess.spawn('sync-fallback');
    let stdout = '';
    third.stdout.on('data', chunk => { stdout += chunk; });
    await liteChildProcess.waitForClose(third);
    // 预期 3：故障消费完毕后仍经过钩子且内置实现仅执行一次
    assert.deepEqual([stdout, builtinRuns, hookRuns], ['hooked\n', 1, 1], '同步回落应保留钩子语义');
    release();
    // 预期 4：首个等待调用独立保留已领取的故障
    assert.deepEqual(await first, { code: 5, signal: null }, '等待调用应保留自己的故障结果');
    // 输入：新等待调用被 kill，随后闸门才放行
    entry.t_inject({ wait: new Promise(resolve => { releaseKilled = resolve; }), exit: 8, stderr: 'late\n', once: true });
    const killed = liteChildProcess.spawn('sync-fallback');
    let closes = 0, stderr = '';
    killed.on('close', () => { closes += 1; });
    killed.stderr.on('data', chunk => { stderr += chunk; });
    const killedClose = liteChildProcess.waitForClose(killed);
    await new Promise(resolve => setImmediate(resolve));
    killed.kill();
    await killedClose;
    releaseKilled();
    await new Promise(resolve => setImmediate(resolve));
    // 预期 5：迟到故障不覆盖信号终态，不重复 close 或输出
    assert.deepEqual([killed.signalCode, closes, stderr], ['SIGTERM', 1, ''], '被终止后不得投递迟到回包');
    // 输入：等待调用所属 mock 世界被卸载，再放行闸门
    entry.t_inject({ wait: new Promise(resolve => { releaseDisposed = resolve; }), exit: 9, once: true });
    const disposed = liteChildProcess.spawn('sync-fallback');
    let exits = 0;
    disposed.on('exit', () => { exits += 1; });
    await new Promise(resolve => setImmediate(resolve));
    liteChildProcess.t_unmock();
    releaseDisposed();
    await new Promise(resolve => setImmediate(resolve));
    // 预期 6：卸载后不再执行任何迟到终态回调
    assert.equal(exits, 0, '卸载后应丢弃故障回调');
  } finally {
    release?.(); releaseKilled?.(); releaseDisposed?.();
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：自然退出会清理 PID，重复 kill 不再发送退出事件。 */
test('spawn 生命周期：spawn/data/exit/close、退出字段与重复 kill', async () => {
  // 输入：内存 spawn 执行 echo，记录全部生命周期事件
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    const child = liteChildProcess.spawn('echo', ['lifecycle']);
    const events = [];
    child.on('spawn', () => events.push('spawn'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => events.push(chunk));
    child.on('exit', () => events.push('exit'));
    child.on('close', () => events.push('close'));
    const closed = await liteChildProcess.waitForClose(child);
    // 预期 1：启动先于输出，退出先于关闭
    assert.deepEqual(events, ['spawn', 'lifecycle\n', 'exit', 'close'], '生命周期事件顺序应与真实 Node 一致');
    // 预期 2：自然退出码与信号字段正确
    assert.deepEqual([closed, child.exitCode, child.signalCode, child.killed], [{ code: 0, signal: null }, 0, null, false], '自然退出状态应正确');
    // 输入：退出后再次按 PID 发信号并调用 child.kill
    // 预期 3：PID 已除名
    assert.equal(liteChildProcess.spawnSync('kill', ['-0', String(child.pid)]).status, 1, '自然退出后 PID 应除名');
    // 预期 4：重复 kill 返回 false，不产生额外退出事件
    assert.equal(child.kill(), false, '退出后 kill 应返回 false');
    // 预期 5：退出和关闭事件不会额外增加
    assert.equal(events.length, 4, '退出事件不得重复');
    // 预期 6：close 发生时 stdout 与 stderr 均已读取结束
    assert.deepEqual([child.stdout.readableEnded, child.stderr.readableEnded], [true, true], 'close 必须晚于输出管道结束');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：忽略流及退出后的迟到命令回调，不重复关闭也不产生流写入错误。 */
test('spawn stdio ignore 与迟到回调：不暴露管道、不重复退出', async () => {
  // 输入：命令不暴露 stdin/stdout/stderr，内部仍可输出并正常退出
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  try {
    const ignored = liteChildProcess.spawn('echo', ['ignored'], { stdio: 'ignore' });
    // 预期 1：忽略的公开管道均为 null
    assert.deepEqual(ignored.stdio, [null, null, null], 'stdio ignore 应不暴露管道');
    // 预期 2：忽略输出不影响命令退出
    assert.deepEqual(await liteChildProcess.waitForClose(ignored), { code: 0, signal: null }, '忽略输出仍应成功退出');
    let complete;
    mgr.t_defineUserCommand('late-reference', {
      i_run(_args, _ctx, child) {
        complete = () => {
          child.stdout.write('late');
          child.stderr.write('late');
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        };
      },
    });
    // 输入：命令启动后先发送终止信号，再触发迟到的完成回调
    const child = liteChildProcess.spawn('late-reference');
    await new Promise(resolve => child.once('spawn', () => queueMicrotask(resolve)));
    let closes = 0;
    child.on('close', () => { closes += 1; });
    const closed = liteChildProcess.waitForClose(child);
    child.kill();
    await closed;
    complete();
    // 预期 3：迟到回调不会覆盖已确认的终止信号
    assert.equal(child.signalCode, 'SIGTERM', '迟到回调不得覆盖终止信号');
    // 预期 4：close 事件只发生一次
    assert.equal(closes, 1, '终态事件不得重复');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：内存实现记录调用——mock 后 spawn 不起真实进程，调用入账。 */
test('内存实现：调用入账、替身子进程带 pid/unref、不起真实进程', async () => {
  // 输入：mock 后以守护进程形状参数 spawn
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true }); // 卷在 → /mock-cmd 系统卷惰性安装，node（mgr 自动加载）可解析
  liteChildProcess.t_mock();
  try {
    const child = liteChildProcess.spawn('node', ['/app/server.mjs'], { cwd: '/app', env: { APP_PORT: '18888' }, detached: true });
    child.unref(); // detached 守护进程消费面
    // 预期 1：替身子进程带数字 pid
    assert.equal(typeof child.pid, 'number', '替身子进程应带 pid');
    // 预期 2：spawn 调用入账一条
    assert.equal(liteChildProcess.t_calls().length, 1, 'spawn 调用应入账');
    const call = liteChildProcess.t_calls()[0];
    // 预期 3：command 如实记录
    assert.equal(call.command, 'node', 'command 应如实记录');
    // 预期 4：args 如实记录
    assert.deepEqual(call.args, ['/app/server.mjs'], 'args 应如实记录');
    // 预期 5：options.env 如实记录
    assert.equal(call.options.env.APP_PORT, '18888', 'options.env 应如实记录');
    // 预期 6：options.cwd 如实记录
    assert.equal(call.options.cwd, '/app', 'options.cwd 应如实记录');
    // 预期 7：options.detached 如实记录
    assert.equal(call.options.detached, true, 'options.detached 应如实记录');
    // 输入：同一 mock 会话内 spawnSync 一次
    liteChildProcess.spawnSync('node', ['-v'], {});
    // 预期 8：spawnSync 调用同样入账（账本覆盖两个执行面）
    assert.equal(liteChildProcess.t_calls().length, 2, 'spawnSync 调用应同样入账');
  } finally {
    liteChildProcess.t_unmock();
  }
});
/** 场景：用户级临时命令——defineUserCommand 注册定制命令（特殊场景的 data 消息响应），异步面按事件序到达。 */
test('defineUserCommand：定制命令 data 消息响应按事件序到达', async () => {
  // 输入：defineUserCommand 注册定制命令（stdout data 消息 + 退出），异步 spawn 消费事件流
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    mgr.t_defineUserCommand('board', {
      i_run(argv, ctx, child) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('board up\n'));
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
      },
    });
    const result = await new Promise((resolve) => {
      let output = '';
      const child = liteChildProcess.spawn('board', []);
      child.stdout.on('data', c => { output += c; });
      child.on('close', code => resolve({ code, output }));
    });
    // 预期 1：退出码来自定制命令实现
    assert.equal(result.code, 0, '退出码应来自定制命令实现');
    // 预期 2：stdout data 消息按事件序到达消费方
    assert.equal(result.output, 'board up\n', 'stdout 输出应来自定制命令');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：kill 命令——spawn('kill', [pid]) 经命令分派向内存子进程发信号（默认 SIGTERM）。 */
test('kill 命令：spawn kill 按 pid 发 SIGTERM、退出码 null、再杀无此进程', async () => {
  // 输入：mock 内存卷与 spawn 边界后 spawn 替身子进程，再以 spawn('kill', [pid]) 执行 kill 命令
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    // 使用有效的长驻脚本，避免缺失入口先报错退出而与 kill 形成无关竞态。
    const child = liteChildProcess.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
    const closed = liteChildProcess.waitForClose(child); // 先挂监听（时序保证），再触发 kill
    liteChildProcess.spawn('kill', [String(child.pid)]);
    const result = await closed;
    // 预期 1：信号终止的退出码为 null（真实语义）
    assert.equal(result.code, null, '信号终止的退出码应为 null（真实语义）');
    // 预期 2：默认信号为 SIGTERM
    assert.equal(result.signal, 'SIGTERM', '默认信号应为 SIGTERM');
    // 输入：kill 已退出的同一 pid（同步面）
    const again = liteChildProcess.spawnSync('kill', [String(child.pid)], { encoding: 'utf8' });
    // 预期 3：无此进程按失败收场（真实 kill 口径）
    assert.equal(again.status, 1, '已退出的 pid 再杀应失败');
    // 预期 4：失败提示对齐真实 kill 文案
    assert.match(again.stderr, /No such process/, '失败提示应为 No such process');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：spawnSync 命令集分派——echo 内置回包经钩子包裹、node -v 同源回包、未注册命令失败。 */
test('spawnSync 分派：echo 回包经 onRun 前后加标记、node -v 探测、未注册命令 ENOENT', async () => {
  // 输入：mock 内存卷与 spawn 边界后对 echo 安装 onRun 钩子、请求 node -v、请求未注册命令
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    mgr.command('echo').t_onRun((call, runBuiltin) => {
      const result = runBuiltin();
      return { ...result, stdout: `[onRun:before]${result.stdout}[onRun:after]` };
    });
    const echo = liteChildProcess.spawnSync('echo', ['memory', 'echo'], { cwd: '/mock/project', encoding: 'utf8' });
    // 预期 1：echo 内置实现成功回包
    assert.equal(echo.status, 0, 'echo 内置实现应成功回包');
    // 预期 2：内置输出保留，前后标记证明确实经过 onRun 钩子
    assert.equal(echo.stdout, '[onRun:before]memory echo\n[onRun:after]', 'echo 内置输出应被 onRun 前后标记包裹');
    // 预期 3：调用在门面账本中如实记录
    assert.deepEqual(liteChildProcess.t_calls()[0].args, ['memory', 'echo'], 'echo 调用应在门面账本入账');
    // 输入：同一内存会话执行 node -v
    const nodeV = liteChildProcess.spawnSync('node', ['-v'], { encoding: 'utf8' });
    // 预期 4：node -v 由命令集成功回包
    assert.equal(nodeV.status, 0, 'node -v 应由命令集成功回包');
    // 预期 5：node 版本与本机 process.version 同源
    assert.equal(nodeV.stdout.trim(), process.version, 'node 版本应与本机同源');
    // 输入：执行未注册命令 whatever
    const unknown = liteChildProcess.spawnSync('whatever', ['--flag']);
    // 预期 6：未注册命令按真实 Node ENOENT 收场（status null，错误在 error 字段）
    assert.equal(unknown.status, null, '未注册命令应按 ENOENT 收场（status null）');
    // 预期 7：未注册命令的错误码为 ENOENT
    assert.equal(unknown.error.code, 'ENOENT', 'error.code 应为 ENOENT');
    // 预期 8：错误消息对齐真实 Node 形状
    assert.equal(unknown.error.message, 'spawnSync whatever ENOENT', 'error.message 应为真实 Node 形状');
  } finally {
    mgr.command('echo').t_onRun(null);
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：命令集桥接 lite-fs——ls 命令读当前作用域目录，回命令行形态 stdout。 */
test('ls 桥接 lite-fs：内存卷目录回命令行形态名单、缺失目录按 ls 失败', async () => {
  // 输入：mock lite-child_process 与 lite-fs 建卷写入两个文件后 spawnSync('ls')
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    liteFs.mkdirSync('/mock/project/a/b', { recursive: true });
    liteFs.writeFileSync('/mock/project/a/b/x.txt', '1');
    liteFs.writeFileSync('/mock/project/a/b/y.md', '2');
    const ls = liteChildProcess.spawnSync('ls', ['/mock/project/a/b'], { encoding: 'utf8' });
    // 预期 1：ls 成功
    assert.equal(ls.status, 0, 'ls 应成功');
    // 预期 2：stdout 为命令行形态的目录名单（每行一个名字）
    assert.equal(ls.stdout, 'x.txt\ny.md\n', 'stdout 应为命令行形态的目录名单');
    // 输入：ls 卷内不存在的目录
    const missing = liteChildProcess.spawnSync('ls', ['/mock/project/none'], { encoding: 'utf8' });
    // 预期 3：按 ls 失败收场
    assert.equal(missing.status, 1, '卷内不存在的目录应按 ls 失败收场');
    // 预期 4：错误输出与系统 ls 的缺失目录文案一致
    assert.equal(missing.stderr, 'ls: /mock/project/none: No such file or directory\n', 'stderr 应与系统 ls 的缺失目录错误一致');
    liteFs.t_unmock();
  } finally {
    liteChildProcess.t_unmock();
  }
});

/** 场景：前置约束——未 mock 时 calls() 拒绝，内部信号原语不作为公共入口。 */
test('前置约束：未 mock 即 calls() 拒绝，信号原语不作为公共入口', async () => {
  // 输入：未 mock 状态下查询调用账本
  // 预期 1：拒绝并提示先 mock
  assert.throws(() => liteChildProcess.t_calls(), /先 t_mock/, '未设置内存实现时查询调用应拒绝');
  // 输入：未 mock 状态下按 pid 投递信号
  // 预期 2：拒绝并提示先 mock
  assert.equal(liteChildProcess.signal, undefined, '信号投递原语不应作为公共方法暴露');
});

/** 场景：mock 幂等与 unmock 丢弃——重复 mock 复用既有账本，unmock 后丢弃。 */
test('mock 幂等：重复 mock 保留账本，unmock 后丢弃回真实语义', async () => {
  // 输入：mock（含 lite-fs 卷，node 可解析）后 spawn 一次，重复 mock（幂等），再 spawn 一次
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  liteChildProcess.spawn('node', ['a'], {});
  liteChildProcess.t_mock(); // 幂等：复用当前内存实现，不丢账本
  liteChildProcess.spawn('node', ['b'], {});
  // 预期 1：重复 mock 不丢弃既有账本
  assert.equal(liteChildProcess.t_calls().length, 2, '重复 mock 不应丢弃调用账本');
  // 输入：unmock 后再 mock（新会话）
  liteChildProcess.t_unmock();
  liteChildProcess.t_mock();
  // 预期 2：新会话账本从零开始
  assert.equal(liteChildProcess.t_calls().length, 0, 'unmock 后重 mock 账本应清零');
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
});

/** 场景：所有命令共用调用账本，清账保留命令配置和在运行的子进程。 */
test('reset：统一清空 git/node/os/用户命令与失败调用，保留钩子、故障和子进程', async () => {
  // 输入：未 mock 状态下清空调用账本
  // 预期 1：拒绝清账并提示先 mock
  assert.throws(() => liteChildProcess.t_reset(), /先 t_mock/, '未 mock 时清账应拒绝');
  // 输入：建立内存会话，为 echo 安装钩子、为 node 注入一次性故障
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  const echo = mgr.command('echo');
  const removeFault = mgr.command('node').t_inject({ exit: 7, once: true });
  try {
    // 输入：注册用户命令与 Git 钩子，启动子进程并依次执行 Git、echo 和未注册命令
    mgr.t_defineUserCommand('ledger-worker', {});
    mgr.command('git').t_onRun(() => ({ stdout: 'git-script\n' }));
    echo.t_onRun((call, runBuiltin) => {
      const result = runBuiltin();
      return { ...result, stdout: `[hook]${result.stdout}` };
    });
    const original = liteChildProcess.spawn('ledger-worker');
    liteChildProcess.spawnSync('git', ['status']);
    liteChildProcess.spawnSync('echo', ['before']);
    // 预期 2：未注册命令异步报 ENOENT，失败调用同样入账
    await assert.rejects(liteChildProcess.waitForClose(liteChildProcess.spawn('ledger-missing')), { code: 'ENOENT' }, '未注册命令应异步报错并记账');
    // 预期 3：不同命令及失败调用按发生顺序记入同一账本
    assert.deepEqual(liteChildProcess.t_calls().map(call => call.command),
      ['ledger-worker', 'git', 'echo', 'ledger-missing'], '账本应按调用顺序包含所有命令');

    // 输入：清空当前会话的调用账本
    liteChildProcess.t_reset();
    // 预期 4：首次清账后记录为空
    assert.deepEqual(liteChildProcess.t_calls(), [], '首次 reset 应清空统一账本');
    // 输入：在空账本上重复清账
    // 预期 5：重复清账不抛错
    assert.doesNotThrow(() => liteChildProcess.t_reset(), '空账本重复 reset 不应抛错');
    // 预期 6：重复清账后记录仍为空
    assert.deepEqual(liteChildProcess.t_calls(), [], '重复 reset 后账本应保持为空');
    // 输入：清账后再启动一个同名用户命令子进程
    const next = liteChildProcess.spawn('ledger-worker');
    // 预期 7：新子进程不复用仍在运行的旧子进程 PID
    assert.notEqual(next.pid, original.pid, '清账后新子进程不得复用仍在运行的 PID');
    // 输入：先监听旧子进程 close，再按原 PID 投递默认信号
    const originalClosed = liteChildProcess.waitForClose(original);
    // 预期 8：清账前启动的子进程仍可寻址并接收信号
    assert.equal(liteChildProcess.spawnSync('kill', [String(original.pid)]).status, 0, '清账后原子进程仍应可寻址');
    // 预期 9：旧子进程以默认 SIGTERM 信号终止
    assert.deepEqual(await originalClosed, { code: null, signal: 'SIGTERM' }, '默认信号应保留');
    // 输入：先监听新子进程 close，再通过 child.kill 投递 SIGINT
    const nextClosed = liteChildProcess.waitForClose(next);
    // 预期 10：新子进程的 kill 调用成功
    assert.equal(next.kill('SIGINT'), true, '新子进程应支持 kill');
    // 预期 11：新子进程以指定的 SIGINT 信号终止
    assert.deepEqual(await nextClosed, { code: null, signal: 'SIGINT' }, '信号应送达新子进程');
    // 输入：向已退出的新子进程再次投递信号
    // 预期 12：PID 已除名，信号未送达
    assert.equal(liteChildProcess.spawnSync('kill', ['-0', String(next.pid)]).status, 1, '退出后的 PID 应除名');
    // 输入：清账后再次执行 echo
    // 预期 13：既有钩子仍包裹 echo 的内置输出
    assert.equal(liteChildProcess.spawnSync('echo', ['after'], { encoding: 'utf8' }).stdout, '[hook]after\n', '清账应保留钩子和内置实现');
    // 输入：清账后再次执行 Git
    // 预期 14：Git 钩子仍生效
    assert.equal(liteChildProcess.spawnSync('git', ['status'], { encoding: 'utf8' }).stdout, 'git-script\n', '清账应保留 Git 钩子');
    // 输入：连续两次执行 node -v，消费先前注入的一次性故障
    // 预期 15：首次执行仍命中清账前配置的故障
    assert.equal(liteChildProcess.spawnSync('node', ['-v']).status, 7, '清账应保留尚未消费的故障');
    // 预期 16：第二次执行回落内置实现并成功
    assert.equal(liteChildProcess.spawnSync('node', ['-v']).status, 0, '一次性故障消费后应回内置实现');
    // 预期 17：账本只包含清账后发生的新调用，按调用顺序排列
    assert.deepEqual(liteChildProcess.t_calls().map(call => call.command),
      ['ledger-worker', 'kill', 'kill', 'echo', 'git', 'node', 'node'], '清账后应只包含新调用');
  } finally {
    removeFault();
    echo.t_onRun(null);
    mgr.command('git').t_onRun(null);
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：调用账本快照隔离，输入和返回快照中的参数修改不污染记录。 */
test('calls：参数与选项快照隔离，缺少同步实现的命令也入账', () => {
  // 输入：建立内存会话，注册没有同步实现的用户命令并携带参数和选项执行
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    mgr.t_defineUserCommand('ledger-empty', {});
    const args = ['original'];
    const options = { cwd: '/original' };
    const result = liteChildProcess.spawnSync('ledger-empty', args, options);
    // 输入：修改原始参数、原始选项及返回快照的参数、选项和数组
    args[0] = 'input-mutated';
    options.cwd = '/input-mutated';
    const snapshot = liteChildProcess.t_calls();
    snapshot[0].args[0] = 'snapshot-mutated';
    snapshot[0].options.cwd = '/snapshot-mutated';
    snapshot.pop();
    // 预期 1：缺少同步实现的命令返回 ENOENT
    assert.equal(result.error.code, 'ENOENT', '缺少同步实现应返回失败');
    // 预期 2：失败调用仍入账，外部修改不影响已记录的原始参数与选项
    assert.deepEqual(liteChildProcess.t_calls(), [
      { command: 'ledger-empty', args: ['original'], options: { cwd: '/original' } },
    ], '外部修改不应污染统一账本');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：命令实现异常不丢调用记录，退出意图转换为子进程终态，普通异常转换为失败退出。 */
test('异常分派：同步和异步的退出意图与普通异常均入统一账本', async () => {
  // 输入：建立内存会话，注册分别抛出普通异常与退出意图的用户命令
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    const failure = new Error('ledger-command-failure');
    mgr.t_defineUserCommand('ledger-failure', {
      i_run() { throw failure; },
      i_runSync() { throw failure; },
    });
    mgr.t_defineUserCommand('ledger-exit', {
      i_run() { throw new ProcessExitError(5); },
      i_runSync() { throw new ProcessExitError(6); },
    });
    // 输入：通过 spawn 与 spawnSync 执行抛出普通异常的命令
    const failed = liteChildProcess.spawn('ledger-failure');
    let stderr = '';
    failed.stderr.on('data', chunk => { stderr += chunk; });
    // 预期 1：子进程中的普通异常以状态码 1 退出，不抛到父进程
    assert.deepEqual(await liteChildProcess.waitForClose(failed), { code: 1, signal: null }, '异步普通异常应失败退出');
    // 预期 2：异步错误输出保留异常信息
    assert.match(stderr, /ledger-command-failure/, 'stderr 应保留异常信息');
    const syncFailed = liteChildProcess.spawnSync('ledger-failure', [], { encoding: 'utf8' });
    // 预期 3：同步执行同样失败退出
    assert.equal(syncFailed.status, 1, '同步普通异常应失败退出');
    // 预期 4：同步错误输出保留异常信息
    assert.match(syncFailed.stderr, /ledger-command-failure/, '同步 stderr 应保留异常信息');
    // 输入：通过 spawn 执行退出意图为 5 的命令，等待子进程终态
    const child = liteChildProcess.spawn('ledger-exit');
    // 预期 5：异步退出意图转换为退出码 5 与空信号
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 5, signal: null }, '异步退出意图应转换为退出事件');
    // 输入：通过 spawnSync 执行退出意图为 6 的命令
    const syncExit = liteChildProcess.spawnSync('ledger-exit', [], { encoding: 'utf8' });
    // 预期 6：同步退出意图转换为状态码 6 与空输出
    assert.deepEqual([syncExit.status, syncExit.stdout, syncExit.stderr], [6, '', ''], '同步退出意图应转换为结果对象');
    // 预期 7：普通异常和退出意图对应的调用均按序入账
    assert.deepEqual(liteChildProcess.t_calls().map(call => call.command),
      ['ledger-failure', 'ledger-failure', 'ledger-exit', 'ledger-exit'], '异常和退出调用均应按序入账');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：等待真实子进程启动失败时拒绝，内存子进程 kill 缺省信号为 SIGTERM。 */
test('waitForClose 错误拒绝与 child.kill 缺省信号', async () => {
  // 输入：真实 spawn 不存在的可执行文件，等待子进程终态
  const child = liteChildProcess.spawn('/litenvi-ledger-missing-command');
  // 预期 1：启动失败使等待 Promise 以 ENOENT 拒绝
  await assert.rejects(liteChildProcess.waitForClose(child), { code: 'ENOENT' }, '启动失败应拒绝等待');
  // 输入：建立内存会话，注册无执行实现的用户命令并启动替身子进程
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    mgr.t_defineUserCommand('ledger-idle', {});
    const idle = liteChildProcess.spawn('ledger-idle');
    // 输入：先监听 close，再不带参数调用 child.kill
    const closed = liteChildProcess.waitForClose(idle);
    // 预期 2：默认 kill 成功送达信号
    assert.equal(idle.kill(), true, '默认 kill 应送达');
    // 预期 3：子进程以默认 SIGTERM 信号终止，退出码为空
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' }, '默认 kill 应投递 SIGTERM');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

const EXEC_MEMORY_ROOT = '/mock/exec-reference';
function f_setupExecReference() {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync(EXEC_MEMORY_ROOT + '/sub', { recursive: true });
  liteFs.writeFileSync(EXEC_MEMORY_ROOT + '/input.txt', 'input\n');
  liteChildProcess.t_mock();
  return () => { liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：Node 脚本内的原生 exec 导出和 promisify 仍落内存运行态，父命令等待异步子命令。 */
test('嵌套 exec：Node 入口复用内存命令，Promise.child 与回包保持原生形状', async () => {
  const done = f_setupExecReference();
  try {
    // 输入：脚本通过原生模块入口调用四个接口及 promisify
    const child = liteChildProcess.spawn('node', ['-e', `
      const { exec, execFile, execSync, execFileSync } = require('node:child_process');
      const { promisify } = require('node:util');
      console.log(execSync('echo sync', { encoding: 'utf8' }).trim());
      console.log(execFileSync('echo', ['file-sync'], { encoding: 'utf8' }).trim());
      const promise = promisify(execFile)('echo', ['promise']);
      console.log('child', typeof promise.child.pid);
      promise.then(result => console.log(result.stdout.trim(), typeof result.stderr));
      exec('echo async', (error, stdout) => console.log(stdout.trim(), error === null));
    `]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // 预期 1：四个接口均可嵌套执行，父命令正常退出且未实现的真实进程入口没有被调用
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 0, signal: null }, '嵌套 exec 完成后父命令应正常退出');
    assert.deepEqual(output.trim().split('\n').sort(), ['sync', 'file-sync', 'child number', 'promise string', 'async true'].sort(), '嵌套输出与 Promise 形状应正确');
    // 预期 2：执行均记入同一个内存账本
    assert.ok(liteChildProcess.t_calls().filter(call => call.command === 'echo').length >= 4, '嵌套命令应统一入账');
  } finally { done(); }
});

/** 场景：卸载世界同时取消 exec 的超时及内部命令，不再回调或发出迟到的退出事件。 */
test('exec 资源清理：unmock 取消超时与在途命令，不再触发回调', async () => {
  for (const method of ['exec', 'execFile']) {
    const done = f_setupExecReference();
    let callbacks = 0, exits = 0;
    try {
      // 输入：启动长驻虚拟 Node，卸载发生在超时之前
      const args = method === 'exec' ? ['node -e "setInterval(() => {}, 1000)"'] : ['node', ['-e', 'setInterval(() => {}, 1000)']];
      const child = liteChildProcess[method](...args, { cwd: EXEC_MEMORY_ROOT, timeout: 20 }, () => { callbacks++; });
      child.on('exit', () => { exits++; });
      await new Promise(resolve => setImmediate(resolve));
      liteChildProcess.t_unmock();
      await new Promise(resolve => setTimeout(resolve, 35));
      // 预期 1：卸载后没有超时、终态或回调活动
      assert.deepEqual({ callbacks, exits }, { callbacks: 0, exits: 0 }, `${method} 卸载后不得投递迟到事件`);
    } finally { done(); }
  }
});


/** 场景：内存 shell 的转义与文件重定向可执行，非法语法经子进程错误回包。 */
test('shell 边界：转义、追加新文件、错误重定向与语法错误', async () => {
  const done = f_setupExecReference();
  const run = command => new Promise(resolve => liteChildProcess.exec(command, { cwd: EXEC_MEMORY_ROOT },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  try {
    // 输入：转义空格/换行、从无到有的追加文件以及 stderr 的文件重定向
    assert.deepEqual(await run('echo escaped\\ value'), { code: 0, stdout: 'escaped value\n', stderr: '' }, '转义空格应保持单一参数');
    assert.equal((await run('echo first\\\nsecond')).stdout, 'firstsecond\n', '反斜杠换行应拼接命令文本');
    assert.equal((await run('echo appended >> fresh.txt; cat fresh.txt')).stdout, 'appended\n', '追加操作应创建新文件');
    assert.equal((await run('ls absent 2> error.txt; cat error.txt')).stdout.includes('No such file or directory'), true, 'stderr 应写入指定文件');
    assert.equal((await run('ls absent 2>&1')).stderr, '', '合并 stderr 后原错误管道应为空');
    // 预期：非法语法不执行后续命令，同步与异步均返回明确失败
    for (const command of ['echo >', '| echo bad', '&& echo bad', 'echo bad &&', 'echo "unclosed', 'echo bad &', 'echo x 1>&3', 'echo $(pwd)']) {
      const result = await run(command);
      assert.equal(result.code, 2, `${command} 应返回语法错误码`);
      assert.match(result.stderr, /\/bin\/sh:/, `${command} 应提供 shell 错误说明`);
      const sync = liteChildProcess.spawnSync('/bin/sh', ['-c', command], { cwd: EXEC_MEMORY_ROOT, encoding: 'utf8' });
      assert.equal(sync.status, 2, `${command} 同步执行也应明确失败`);
    }
    assert.equal(liteChildProcess.spawnSync('/bin/sh', []).status, 2, '不支持交互 shell 时应明确失败');
  } finally { done(); }
});

/** 场景：暂停发生在启动事件时，命令完成结果与终态在恢复后只送达一次。 */
test('暂停后的完成：同步回落与异步命令均在 SIGCONT 后输出和关闭', async () => {
  const done = f_setupExecReference();
  try {
    // 输入：用户命令使用公共实现协议，终态由公开 ChildProcess 事件观察
    mgr.t_defineUserCommand('paused-completion', {
      i_run(_args, _ctx, child) { queueMicrotask(() => { child.stdout.write('done\n'); child.emit('exit', 0, null); child.emit('close', 0, null); }); },
    });
    mgr.t_defineUserCommand('paused-sync-completion', { i_runSync: () => { return { status: 0, stdout: 'done\n' }; } });
    for (const command of ['paused-sync-completion', 'paused-completion']) {
      const child = liteChildProcess.spawn(command);
      const events = [];
      child.once('spawn', () => child.kill('SIGSTOP'));
      child.stdout.on('data', data => events.push(data.toString()));
      child.on('exit', () => events.push('exit'));
      child.on('close', () => events.push('close'));
      const closed = liteChildProcess.waitForClose(child);
      await new Promise(resolve => setImmediate(resolve));
      // 预期：暂停期间不交付任何输出或终态，恢复后事件有序且不重复
      assert.deepEqual(events, [], `${command} 暂停期间不应交付事件`);
      assert.equal(child.kill('SIGCONT'), true, '恢复信号应送达');
      assert.deepEqual(await closed, { code: 0, signal: null }, '恢复后应自然完成');
      assert.deepEqual(events, ['done\n', 'exit', 'close'], `${command} 恢复后事件应只交付一次`);
    }
  } finally { done(); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-child_process.mjs 导入的
 * 门面与库内部相对导入必须是同一实例，否则 mock 边界会静默分裂（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async () => {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('litenvi-node/lite-child_process.mjs');
  assert.equal(selfRef.default, liteChildProcess, '同一模块经不同 specifier 应共享同一实例');
});
