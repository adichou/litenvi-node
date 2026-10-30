// lite-cmd-node 门面用例：通过 lite-child_process 执行 Node/npm 命令。
// Node 异步脚本执行真实源码，输出、参数、环境与退出行为对照原生命令；同步面仅支持版本探测。
// 运行方式：node --test tests/lite-cmd-node.test.mjs，无需 VM 实验参数。
// 用例注释格式：方法级写测试场景；语句中「输入」标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeReferenceEnv } from './native-reference-env.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import liteChildProcess from '../lite-child_process.mjs';
import { liteProcess } from '../lite-process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import { NODE_COMMAND_PATH } from '../lite-cmd-node.mjs';

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));
// 逐用例装配：内存卷（命令执行寻址依赖）+ spawn 边界
function setup() {
  liteFs.mock({ exclude: [EXCLUDED] });
  liteChildProcess.mock();
  return () => {
    liteChildProcess.unmock();
    liteFs.unmock();
  };
}

// 夹具工厂：真实目录提供入口源码，共享 liteFs 门面承接内存文件副作用。
import realFs from 'node:fs';
import os from 'node:os';
import liteFs from '../lite-fs.mjs';
import liteServer from '../lite-server.mjs';
const liteFsUrl = new URL('../lite-fs.mjs', import.meta.url).href;
let fixtureSeq = 0;
function writeFixture(code) {
  const name = path.join(os.tmpdir(), `lite-cmd-node-fixture-${process.pid}-${++fixtureSeq}.mjs`);
  realFs.writeFileSync(name, `import liteFs from '${liteFsUrl}';\n${code}\n`);
  return name;
}

/** 场景：原生对照隔离调试器预加载和强制颜色，业务环境变量与脚本自身 stderr 保持可见。 */
test('原生对照环境：调试器与颜色设置不污染输出，业务 stderr 保留', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-reference-env-'));
  const preload = path.join(temporary, 'debug-preload.cjs');
  const marker = path.join(temporary, 'preloaded');
  // 输入：模拟 IDE 的 NODE_OPTIONS 预加载和强制颜色，预加载若执行就会创建标记文件
  realFs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); console.error('injected-debugger');`);
  const inherited = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    VSCODE_INSPECTOR_OPTIONS: '{"autoAttachMode":"always"}', FORCE_COLOR: '1', CLICOLOR_FORCE: '1', LITE_REFERENCE_PROBE: 'kept' };
  delete inherited.NO_COLOR;
  delete inherited.NODE_DISABLE_COLORS;
  try {
    const response = liteChildProcess.spawnSync(process.execPath, ['-e', `console.log(42, process.env.LITE_REFERENCE_PROBE); console.error('Debugger attached.');`],
      { env: nativeReferenceEnv({}, inherited), encoding: 'utf8', timeout: 3000 });
    // 预期 1：子进程正常结束，保留业务环境变量，数字输出不带 ANSI 色码
    assert.equal(response.error, undefined, '原生对照子进程应能启动');
    assert.equal(response.status, 0, '原生对照子进程应正常退出');
    assert.equal(response.stdout, '42 kept\n', '业务变量应保留且输出不应强制着色');
    // 预期 2：通过启动环境阻止调试预加载，脚本自身的同名诊断文本仍被完整断言
    assert.equal(realFs.existsSync(marker), false, '对照子进程不应加载 IDE 的调试预载模块');
    assert.equal(response.stderr, 'Debugger attached.\n', '不得通过过滤 stderr 文本掩盖业务输出');
    // 预期 3：同样的固定环境也适用于系统 ls，目录项不受 macOS 强制着色变量影响
    const listing = liteChildProcess.spawnSync('ls', ['-a', temporary], { env: nativeReferenceEnv({}, inherited), encoding: 'utf8' });
    assert.equal(listing.status, 0, '系统 ls 对照应正常执行');
    assert.equal(listing.stderr, '', '系统 ls 对照不应额外输出诊断');
    assert.equal(listing.stdout, '.\n..\ndebug-preload.cjs\n', '目录项不应包含强制颜色的 ANSI 色码');
    // 预期 4：输入环境和宿主环境保持独立，不为测试修改调用方配置
    assert.equal(inherited.FORCE_COLOR, '1', '不得修改传入的环境对象');
    assert.equal(inherited.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`, '不得修改传入的预加载配置');
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：同一组 Node 命令分别由真实 Node 与内存实现执行，核对输出、参数、环境与退出。 */
test('真实 Node 对照：版本、脚本输出、argv/env、模块加载与退出码', async () => {
  // 输入：真实临时目录内准备入口、相对依赖、顶层 await 与错误脚本
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-node-reference-'));
  const root = realFs.realpathSync(temporary);
  realFs.writeFileSync(path.join(root, 'dependency.mjs'), `globalThis.nodeProbeCount = (globalThis.nodeProbeCount || 0) + 1; export const count = globalThis.nodeProbeCount;`);
  realFs.writeFileSync(path.join(root, 'entry.mjs'), `
    import process from 'node:process';
    import { log, error } from 'node:console';
    import { count } from './dependency.mjs';
    log(JSON.stringify({ argv: process.argv.slice(1), env: process.env.LITE_NODE_REFERENCE, cwd: process.cwd(), count }));
    error('entry-stderr');
  `);
  realFs.writeFileSync(path.join(root, 'await.mjs'), `await new Promise(resolve => setTimeout(resolve, 5)); console.log('await-done');`);
  realFs.writeFileSync(path.join(root, 'exit-code.mjs'), `import process from 'node:process'; process.exitCode = 7;`);
  realFs.writeFileSync(path.join(root, 'failure.mjs'), `throw new Error('node-reference-failure');`);
  const scenario = async memory => {
    const responses = [];
    const options = { cwd: root, env: nativeReferenceEnv({ LITE_NODE_REFERENCE: 'child-value' }), encoding: 'utf8' };
    const normalize = text => String(text).replaceAll(root, '<root>').replaceAll(process.execPath, '<node>');
    const run = async (command, args, errorOnly = false) => {
      const child = liteChildProcess.spawn(command, args, options);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = liteChildProcess.waitForClose(child);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        const result = await closed;
        // 预期 1：所测有限命令应自行退出，不能靠测试超时终止
        assert.notEqual(result.signal, 'SIGKILL', `${command} ${args[0]} 应正常完成`);
        responses.push({ code: result.code, signal: result.signal, stdout: normalize(stdout),
          stderr: normalize(errorOnly ? stderr.match(/(?:SyntaxError|TypeError|Error):[^\n]*/)?.[0] || stderr : stderr) });
      } finally {
        clearTimeout(deadline);
      }
    };
    const node = memory ? 'node' : process.execPath;
    for (const args of [['-v'], ['--version']]) {
      const result = liteChildProcess.spawnSync(node, args, options);
      responses.push({ code: result.status, stdout: result.stdout, stderr: result.stderr });
      await run(node, args);
    }
    const npm = liteChildProcess.spawnSync('npm', ['-v'], options);
    responses.push({ code: npm.status, stdout: npm.stdout, stderr: npm.stderr });
    await run(node, ['-e', `console.log('stdout'); console.error('stderr');`]);
    await run(node, ['-e', `console.log(JSON.stringify(process.argv.slice(1)));`, 'argument.mjs']);
    await run(node, ['-e', `console.log(process.env.LITE_NODE_REFERENCE); process.exitCode = 3;`]);
    await run(node, ['-e', `console.log('before-exit'); process.exit(4); console.log('after-exit');`]);
    await run(node, ['-e', `setTimeout(() => console.log('later'), 5); console.log('now');`]);
    await run(node, ['./entry.mjs', '--after']);
    await run(node, ['--trace-warnings', './entry.mjs', '--again']);
    await run(node, ['./await.mjs']);
    await run(node, ['./exit-code.mjs']);
    await run(node, ['-p', '6 * 7']);
    await run(node, ['-e', `
      const child = require('node:child_process').spawn('echo', ['nested']);
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.on('close', code => console.log('nested-exit', code));
    `]);
    await run(node, ['-e', `
      const { createServer } = require('node:http');
      const server = createServer((request, response) => response.end('ok'));
      server.listen(0, '127.0.0.1', () => {
        console.log('listening');
        setTimeout(() => server.close(() => console.log('closed')), 5);
      });
    `]);
    // 错误栈的运行器帧不同，仅归一化栈帧，仍比较错误类型、消息、stdout 与退出码。
    await run(node, ['./failure.mjs'], true);
    await run(node, ['./missing.mjs'], true);
    return responses;
  };
  try {
    const expected = await scenario(false);
    liteFs.mock({ exclude: [EXCLUDED, root] });
    liteChildProcess.mock();
    try {
      const actual = await scenario(true);
      // 预期 2：相同命令输入下，版本、输出、argv/env、重复加载及终态与真实 Node 一致
      assert.deepEqual(actual, expected, 'Node 命令实现应与真实 Node 的已测行为一致');
    } finally {
      liteChildProcess.unmock();
      liteFs.unmock();
    }
  } finally {
    realFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：普通 import 在宿主中加载源码，入口可重复执行，并发命令各自使用参数与输出管道。 */
test('普通 import：共享宿主全局、重复入口执行、并发输出与宿主环境恢复', async () => {
  const marker = Symbol.for('litenvi-node-native-import');
  globalThis[marker] = { count: 0 };
  const original = { argv: process.argv, env: process.env, cwd: process.cwd(), exitCode: process.exitCode,
    log: console.log, timer: setTimeout, readFile: realFs.readFileSync, exit: process.exit };
  const fixture = writeFixture(`
    const state = globalThis[Symbol.for('litenvi-node-native-import')];
    state.count++;
    await new Promise(resolve => setTimeout(resolve, Number(process.argv[2])));
    console.log(JSON.stringify({ tag: process.env.LITE_IMPORT_TAG, arg: process.argv[3], count: state.count }));
  `);
  const done = setup();
  const launch = (tag, delay) => {
    const child = liteChildProcess.spawn('node', [fixture, String(delay), tag], { env: { LITE_IMPORT_TAG: tag } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    return liteChildProcess.waitForClose(child).then(closed => ({ closed, output }));
  };
  try {
    // 输入：同一入口连续执行两次，再并发执行两次，ES 模块源码直接访问宿主全局标记
    const first = await launch('first', 1);
    const second = await launch('second', 1);
    const parallel = await Promise.all([launch('slow', 10), launch('fast', 1)]);
    // 预期 1：每次入口真实执行且正常退出
    for (const result of [first, second, ...parallel]) assert.deepEqual(result.closed, { code: 0, signal: null }, '普通 import 应成功执行');
    assert.equal(globalThis[marker].count, 4, '入口应共享宿主全局且每次重新执行');
    // 预期 2：并发命令的参数、env 与 stdout 不串到其他命令
    assert.deepEqual([first, second, ...parallel].map(result => {
      const { tag, arg } = JSON.parse(result.output);
      return [tag, arg];
    }), [['first', 'first'], ['second', 'second'], ['slow', 'slow'], ['fast', 'fast']], '并发输出与参数应对应各自命令');
    // 预期 3：宿主的 process 字段保持原来的值与对象
    assert.equal(process.argv, original.argv, '宿主 argv 应恢复');
    assert.equal(process.env, original.env, '宿主 env 应恢复');
    assert.equal(process.cwd(), original.cwd, '宿主 cwd 应保持不变');
    assert.equal(process.exitCode, original.exitCode, '宿主退出码应保持不变');
    assert.equal(console.log, original.log, '宿主 console 方法应恢复');
    assert.equal(setTimeout, original.timer, '宿主定时器方法应恢复');
    assert.equal(realFs.readFileSync, original.readFile, '宿主 fs 方法应恢复');
    assert.equal(process.exit, original.exit, '宿主 exit 方法应恢复');
  } finally {
    done();
    realFs.unlinkSync(fixture);
    delete globalThis[marker];
  }
});

/** 场景：入口通过原生 child_process 导出调用嵌套命令，执行仍统一留在内存分派中。 */
test('嵌套命令：spawn/spawnSync 统一入账，未实现的 fork 明确失败', async () => {
  const fixture = writeFixture(`
    import { spawn, spawnSync, fork } from 'node:child_process';
    console.log(spawnSync('echo', ['nested-sync'], { encoding: 'utf8' }).stdout.trim());
    try { fork(); } catch (error) { console.log('fork-blocked', /未实现内存语义/.test(error.message)); }
    const child = spawn('echo', ['nested-async']);
    child.stdout.on('data', chunk => process.stdout.write(chunk));
  `);
  const done = setup();
  try {
    // 输入：普通 import 入口执行同步与异步嵌套命令；fork 不传参数以保证回退错误时也不会启动真实进程
    const child = liteChildProcess.spawn('node', [fixture]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // 预期 1：父命令等待嵌套命令完成，所有输出进入父 stdout
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 0, signal: null }, '嵌套命令完成后父命令应正常退出');
    assert.equal(output, 'nested-sync\nfork-blocked true\nnested-async\n', '嵌套命令输出与 fork 边界应正确');
    // 预期 2：嵌套 echo 均记入内存运行账本
    assert.deepEqual(liteChildProcess.calls().map(call => call.command), ['node', 'echo', 'echo'], '嵌套命令应通过内存分派');
  } finally {
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：导入即登记——lite-cmd-node 被 import 后，mgr 注册表可按名寻址 node 与 npm 实现。 */
test('导入即登记：node/npm 在 mgr 登记名单、node 命令路径为 execPath 常量', () => {
  // 输入：读 mgr 注册表自省名单
  // 预期 1：node 完整路径在名单
  assert.ok(mgr.defined().includes(NODE_COMMAND_PATH), 'node 应在登记名单');
  // 预期 2：npm 完整路径在名单
  assert.ok(mgr.defined().includes('/mock-cmd/usr/local/bin/npm'), 'npm 应在登记名单');
  // 预期 3：裸名寻址到句柄
  assert.equal(mgr.command('node').path, NODE_COMMAND_PATH, '裸名 node 应寻址到命令句柄');
  // 预期 4：常量值为 /mock-cmd/usr/local/bin/node（lite-process 的 execPath 取此值）
  assert.equal(NODE_COMMAND_PATH, '/mock-cmd/usr/local/bin/node', 'node 命令路径应为命名空间内完整路径');
});

/** 场景：版本探测——node/npm 的 -v 同步回包分别对应本机安装版本。 */
test('版本探测：node -v 与 npm -v 同步回本机版本', () => {
  // 输入：先通过真实命令获取 npm 安装版本，再装配内存环境
  const expectedNpm = liteChildProcess.spawnSync('npm', ['-v'], { encoding: 'utf8', env: nativeReferenceEnv() });
  assert.equal(expectedNpm.status, 0, '本机 npm 版本探测应成功');
  const done = setup();
  try {
    // 输入：spawnSync node -v / npm -v
    const nodeV = liteChildProcess.spawnSync('node', ['-v'], { encoding: 'utf8' });
    const npmV = liteChildProcess.spawnSync('npm', ['-v'], { encoding: 'utf8' });
    // 预期 1：node -v 成功
    assert.equal(nodeV.status, 0, 'node -v 应成功');
    // 预期 2：node 版本与 process.version 一致
    assert.equal(nodeV.stdout.trim(), process.version, 'node 版本应与 process.version 一致');
    // 预期 3：npm -v 成功
    assert.equal(npmV.status, 0, 'npm -v 应成功');
    // 预期 4：npm 版本与本机 npm 的真实响应一致
    assert.equal(npmV.stdout, expectedNpm.stdout, 'npm 版本应与本机安装版本一致');
  } finally {
    done();
  }
});

/** 场景：入口脚本执行——.mjs 入口执行真实源码，副作用/env/argv 均为子进程口径。 */
test('入口脚本执行：真实源码、env 落位、argv 子进程口径、旗标剔除', async () => {
  liteFs.mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project', { recursive: true }); // fixture 副作用目录（卷内；缺失则入口写入 ENOENT）
  liteProcess.mock({ cwd: '/mock/project' });
  const fixture = writeFixture(`
liteFs.writeFileSync('/mock/project/fixture-out.json', JSON.stringify({
  argv: process.argv.slice(1, 4), env: process.env.ATB_CMD_NODE_PROBE, url: import.meta.url,
}));`);
  liteChildProcess.mock();
  try {
    // 输入：spawn node（带入口前旗标 + 入口后参数 + 自定义 env）
    const child = liteChildProcess.spawn('node', ['--max-old-space-size=1', fixture, '--after'], {
      env: { ATB_CMD_NODE_PROBE: 'lit' },
    });
    const closed = await liteChildProcess.waitForClose(child);
    const out = JSON.parse(liteFs.readFileSync('/mock/project/fixture-out.json', 'utf8'));
    // 预期 1：入口真实执行（副作用可见，import.meta.url 即入口自身）
    const entryUrl = new URL(out.url);
    // 原生 import 以 URL 缓存；运行序号只用于重执行入口，真实文件地址仍须一致。
    assert.match(entryUrl.searchParams.get('litenviRun'), /^\d+$/, '入口 URL 应包含重新执行入口所需的运行序号');
    entryUrl.searchParams.delete('litenviRun');
    assert.equal(entryUrl.href, pathToFileURL(realFs.realpathSync(fixture)).href, '入口应对应真实文件（realpath 归一：macOS /var → /private/var）');
    // 预期 2：options.env 已落 process.env（入口加载期可读）
    assert.equal(out.env, 'lit', 'env 应先落 process.env');
    // 预期 3：argv 为子进程口径 [入口, 入口后参数]——入口前旗标剔除
    assert.deepEqual(out.argv, [fixture, '--after'], 'argv 应为子进程口径且剔除前置旗标');
    // 预期 4：入口及其任务结束后正常退出
    assert.deepEqual(closed, { code: 0, signal: null }, '有限入口应正常退出');
  } finally {
    liteChildProcess.unmock();
    liteProcess.unmock();
    liteFs.unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：入口加载失败——顶层抛错的入口按子进程异常退出收场（stderr + exit 1）。 */
test('入口加载失败：stderr 带错误信息、退出码 1', async () => {
  liteFs.mock({ exclude: [EXCLUDED] });
  const fixture = writeFixture(`throw new Error('fixture-boom');`);
  liteChildProcess.mock();
  try {
    // 输入：spawn node 加载必抛的入口
    const child = liteChildProcess.spawn('node', [fixture]);
    const stderr = new Promise((resolve) => child.stderr.once('data', (c) => resolve(String(c))));
    const { code } = await liteChildProcess.waitForClose(child);
    // 预期 1：stderr 带入口错误信息
    assert.match(await stderr, /fixture-boom/, 'stderr 应带入口错误信息');
    // 预期 2：退出码 1（子进程异常退出语义）
    assert.equal(code, 1, '加载失败应按退出码 1 收场');
  } finally {
    liteChildProcess.unmock();
    liteFs.unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：内联求值——-e 执行代码，stdout 写入子进程管道并正常退出。 */
test('内联求值：-e 输出进入 stdout，执行结束正常退出', async () => {
  const done = setup();
  try {
    // 输入：spawn node -e，输出一个值
    const child = liteChildProcess.spawn('node', ['-e', 'console.log(1)']);
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const outcome = await liteChildProcess.waitForClose(child);
    // 预期 1：输出来自子进程 stdout
    assert.equal(stdout, '1\n', '内联求值应输出到 stdout');
    // 预期 2：求值结束正常退出
    assert.deepEqual(outcome, { code: 0, signal: null }, '内联求值完成应退出');
  } finally {
    done();
  }
});

/** 场景：长驻任务——定时器保持 Node 存活，kill 后取消定时器并关闭子进程。 */
test('长驻任务：定时器保持存活，kill 后停止输出并关闭', async () => {
  const done = setup();
  try {
    // 输入：启动持续输出的 Node 定时器，收到首条输出后终止
    const child = liteChildProcess.spawn('node', ['-e', "setInterval(() => console.log('tick'), 5)"]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    await new Promise(resolve => child.stdout.once('data', resolve));
    // 预期 1：主脚本执行完后，活动定时器仍使进程存活
    assert.equal(child.exitCode, null, '活动定时器应保持进程存活');
    const closed = liteChildProcess.waitForClose(child);
    assert.equal(child.kill(), true, '应能终止活动子进程');
    // 预期 2：信号退出且之后不再输出
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' }, 'kill 应以信号退出');
    const stoppedOutput = output;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(output, stoppedOutput, '终止后定时器不得继续输出');
  } finally {
    done();
  }
});

/** 场景：共享服务门面——入口使用调用方的 liteServer 环境，关闭监听后正常退出。 */
test('共享服务门面：内存服务关闭后 Node 正常退出', async () => {
  const done = setup();
  liteServer.mock();
  const serverUrl = new URL('../lite-server.mjs', import.meta.url).href;
  const fixture = writeFixture(`
    import server from '${serverUrl}';
    const listener = server.createServer((request, response) => response.end('ok'));
    listener.listen(0, '127.0.0.1', () => {
      console.log('listening');
      listener.close(() => console.log('closed'));
    });
  `);
  try {
    // 输入：入口使用共享 liteServer 门面，监听成功后立即关闭
    const child = liteChildProcess.spawn('node', [fixture]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const closed = liteChildProcess.waitForClose(child);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      // 预期 1：入口与服务均结束后正常退出
      assert.deepEqual(await closed, { code: 0, signal: null }, '关闭共享服务后应正常退出');
      // 预期 2：监听与关闭的回调均实际执行
      assert.equal(output, 'listening\nclosed\n', '服务回调的输出应进入子进程管道');
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    done();
    liteServer.unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：撤销环境——unmock 停止子进程任务，防止定时器继续修改内存文件。 */
test('撤销环境：unmock 后定时器不再产生文件副作用', async () => {
  const done = setup();
  try {
    // 输入：定时器每次写文件，首次完成后撤销子进程 mock；次数上限防止失败时挂住测试
    const child = liteChildProcess.spawn('node', ['-e', `
      const fs = require('node:fs');
      let count = 0;
      const timer = setInterval(() => {
        fs.writeFileSync('/node-ticks', String(++count));
        console.log('tick');
        if (count === 10) clearInterval(timer);
      }, 5);
    `]);
    await new Promise(resolve => child.stdout.once('data', resolve));
    const last = liteFs.readFileSync('/node-ticks', 'utf8');
    liteChildProcess.unmock();
    await new Promise(resolve => setTimeout(resolve, 25));
    // 预期 1：环境撤销后，原子进程的定时器不能再写文件
    assert.equal(liteFs.readFileSync('/node-ticks', 'utf8'), last, 'unmock 应取消活动子进程的定时器');
  } finally {
    done();
  }
});

/** 场景：同步入口限制——spawnSync('node', [入口]) 未实现（import 是异步的），失败并指引。 */
test('同步入口限制：spawnSync 入口按失败收场并指引改用 spawn', () => {
  const done = setup();
  try {
    // 输入：spawnSync node 带入口参数
    const r = liteChildProcess.spawnSync('node', ['/mock/project/whatever.mjs'], { encoding: 'utf8' });
    // 预期 1：按失败收场
    assert.equal(r.status, 1, '同步执行入口应失败');
    // 预期 2：失败信息指引改用 spawn
    assert.match(r.stderr, /改用 spawn/, '失败信息应指引改用 spawn');
  } finally {
    done();
  }
});

/** 场景：npm 参数边界——除 -v 外的参数未实现内存语义，按失败收场。 */
test('npm 参数边界：非 -v 参数按失败收场', () => {
  const done = setup();
  try {
    // 输入：spawnSync npm test
    const r = liteChildProcess.spawnSync('npm', ['test'], { encoding: 'utf8' });
    // 预期 1：按失败收场
    assert.equal(r.status, 1, '未实现的 npm 参数应失败');
    // 预期 2：失败信息说明未实现
    assert.match(r.stderr, /未实现/, '失败信息应说明未实现内存语义');
  } finally {
    done();
  }
});
