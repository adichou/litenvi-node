// lite-cmd-node 门面用例：通过 lite-child_process 执行 Node/npm 命令。
// Node 异步脚本执行真实源码，输出、参数、环境与退出行为对照原生命令；同步面仅支持版本探测。
// 运行方式：node --test tests/lite-cmd-node.test.mjs，无需 VM 实验参数。
// 用例注释格式：方法级写测试场景；语句中「输入」标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import liteChildProcess from '../lite-child_process.mjs';
import { liteProcess } from '../lite-process.mjs';
import mgr from '../lite-cmd-mgr.mjs';
// 命令集自测经显式 t_install() 安装（导入不登记，mgr 不再反向加载本模块，无 TDZ 约束）；
// echo 等 OS 命令是嵌套 spawn 用例的对照载荷，一并安装
import { t_commands, t_install } from '../lite-cmd-node.mjs';
import { t_install as t_installOsCommands } from '../lite-cmd-os.mjs';

const NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';
const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));
// 逐用例装配：命令集安装（幂等）+ 内存卷（命令执行寻址依赖）+ spawn 边界
function f_setup() {
  t_install();
  t_installOsCommands();
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  return () => {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  };
}

// 夹具工厂：真实目录提供入口源码，共享 liteFs 门面承接内存文件副作用。
import realFs, { readFileSync as nativeReadFileSync, writeFileSync as nativeWriteFileSync, existsSync as nativeExistsSync } from 'node:fs';
import os from 'node:os';
import liteFs from '../lite-fs.mjs';
import liteServer from '../lite-server.mjs';
const liteFsUrl = new URL('../lite-fs.mjs', import.meta.url).href;
let fixtureSeq = 0;
function f_writeFixture(code) {
  const name = path.join(EXCLUDED, `lite-cmd-node-fixture-${process.pid}-${++fixtureSeq}.mjs`);
  realFs.writeFileSync(name, `import liteFs from '${liteFsUrl}';\n${code}\n`);
  return name;
}

/** 场景：模拟 npm 固定版本，不依赖宿主 PATH 或 npm 安装。 */
test('npm 固定版本：空 PATH 也返回 10.9.0', () => {
  const done = f_setup();
  const originalPath = process.env.PATH;
  try {
    // 输入：移除宿主 npm 搜索路径，分别查询两个版本入口。
    process.env.PATH = '';
    for (const flag of ['-v', '--version']) {
      const result = liteChildProcess.spawnSync('npm', [flag], { encoding: 'utf8' });
      // 预期 1：版本为固定模拟值，不需要读取本机安装信息。
      assert.equal(result.status, 0, '固定 npm 版本查询不应依赖本机安装');
      assert.equal(result.stdout, '10.9.0\n', '模拟 npm 版本应固定为 10.9.0');
      assert.equal(result.stderr, '', '固定 npm 版本查询不应产生错误');
    }
    // 预期 2：其余工具链信息使用固化快照，JSON 和文本输出均不需要本机 npm。
    const metadata = liteChildProcess.spawnSync('npm', ['--versions', '--json'], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, '固定工具链信息查询应成功');
    const versions = JSON.parse(metadata.stdout);
    assert.equal(versions.npm, '10.9.0', '工具链信息应保留固定 npm 版本');
    assert.equal(versions.node, '22.12.0', '工具链信息应使用采集的 Node 版本');
    assert.equal(versions.v8, '12.4.254.21-node.21', '工具链信息应使用采集的 V8 版本');
    const text = liteChildProcess.spawnSync('npm', ['--versions'], { encoding: 'utf8' });
    assert.equal(text.status, 0, '文本工具链信息查询应成功');
    assert.match(text.stdout, /npm: '10.9.0'/, '文本信息应包含固定 npm 版本');

  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    done();
  }
});

/** 场景：真实测试夹具执行名称筛选、重复运行、失败退出和实际覆盖率，不回放 TAP。 */
test('node --test：真实断言、名称过滤、重复执行及覆盖率', async () => {
  const fixture = f_writeFixture(`
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    test('alpha', function alpha() {
      console.log('fixture-executed:' + process.env.LITE_TEST_INPUT);
      assert.equal(Number(process.env.LITE_TEST_INPUT) * 2, 4, '实际计算结果应为 4');
    });
    test('beta', function beta() { assert.equal(1 + 1, 3, '真实失败断言'); });
  `);
  const done = f_setup();
  const run = async (args, value) => {
    const child = liteChildProcess.spawn('node', args, { env: { LITE_TEST_INPUT: value }, encoding: 'utf8' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    return { ...closed, stdout, stderr };
  };
  try {
    // 输入：同一真实文件分别筛选通过、修改输入后重跑失败，再运行全部并收集覆盖率。
    const pass = await run(['--test', '--test-name-pattern', '^alpha$', fixture], '2');
    const fail = await run(['--test', '--test-name-pattern=^alpha$', fixture], '3');
    const coverage = await run(['--test', '--experimental-test-coverage', fixture], '2');
    // 预期 1：名称筛选只执行 alpha，输出来自真实方法体。
    assert.equal(pass.code, 0, `合法输入应通过：${pass.stderr}`);
    assert.match(pass.stdout, /^ok 1 - alpha$/m, '应输出真实 alpha 通过结果');
    assert.match(pass.stdout, /fixture-executed:2/, '应真实执行方法体并读取本次命令输入');
    assert.doesNotMatch(pass.stdout, /not ok .*beta/, '未匹配名称的 beta 不应执行');
    // 预期 2：新上下文重复加载相同文件，不复用首次结果或泄漏到宿主测试注册表。
    assert.equal(fail.code, 1, '改变输入后真实断言失败应退出 1');
    assert.match(fail.stdout, /fixture-executed:3/, '再次运行应读取新的输入并重新执行');
    assert.match(fail.stdout, /not ok 1 - alpha/, '应报告真实 alpha 失败');
    assert.match(fail.stdout, /实际计算结果应为 4/, '失败详情应来自真实断言');
    // 预期 3：覆盖率运行整个文件，失败退出码和实际 V8 覆盖率同时保留。
    assert.equal(coverage.code, 1, '覆盖率运行应保留 beta 的真实失败退出码');
    assert.match(coverage.stdout, /not ok 2 - beta/, '覆盖率运行应执行未筛选的 beta');
    assert.match(coverage.stdout, /# start of coverage report/, '应输出原生测试运行器的覆盖率报告');
    assert.match(coverage.stdout, /line %.*branch %.*funcs %/, '覆盖率表应包含行、分支和函数指标');
    assert.doesNotMatch(coverage.stdout, /lite-cmd-node(?:-test-worker)?\.mjs/, '目标项目覆盖率不应混入虚拟命令执行器');
    assert.match(coverage.stdout, new RegExp(path.basename(fixture).replaceAll('.', '\\.')), '覆盖率应包含实际执行的夹具文件');
  } finally { done(); realFs.unlinkSync(fixture); }
});

/** 场景：测试启动参数、源码作用域和执行错误均明确失败，不能悄悄回退或产生成功 TAP。 */
test('node --test 边界：非法参数、缺失源码与内存独有源码明确失败', async () => {
  const fixture = f_writeFixture(`import { test } from 'node:test'; test('probe', () => console.log('真实执行'));`);
  const done = f_setup();
  liteFs.mkdirSync('/mock', { recursive: true });
  liteFs.writeFileSync('/mock/memory-only.mjs', `throw new Error('不应被原生加载');`);
  const scenarios = [
    { args: ['--test'], error: /需要显式指定测试文件/ },
    { args: ['--test', '--test-name-pattern'], error: /缺少表达式/ },
    { args: ['--test', '--unsupported', fixture], error: /测试运行参数未实现/ },
    { args: ['--test', '--test-name-pattern=[', fixture], error: /regular expression|Invalid/i },
    { args: ['--test', '--test-coverage-include', '--experimental-test-coverage', fixture], error: /缺少 glob/ },
    { args: ['--test', '--test-coverage-exclude'], error: /缺少 glob/ },
    { args: ['--test', '/mock/missing.mjs'], error: /Cannot find module/ },
    { args: ['--test', '/mock/memory-only.mjs'], error: /Cannot find module/ },
  ];
  try {
    // 输入：每次都通过公共子进程入口启动真实命令实现。
    for (const scenario of scenarios) {
      const child = liteChildProcess.spawn('node', scenario.args);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const closed = await liteChildProcess.waitForClose(child);
      // 预期 1：不支持的输入明确失败，不能凭空生成通过结果。
      assert.equal(closed.code, 1, `${scenario.args.join(' ')} 应明确失败`);
      assert.match(output, scenario.error, `${scenario.args.join(' ')} 应保留实际失败原因`);
      assert.doesNotMatch(output, /^ok \d+ - probe$/m, '启动或加载失败不能冒充测试已通过');
    }
  } finally { done(); realFs.unlinkSync(fixture); }
});

/** 场景：覆盖率范围旗标把统计限定在指定 glob 内——范围外真实模块不计入覆盖率表，等号与空格取值均可。 */
test('node --test 覆盖率范围：include/exclude glob 生效', async () => {
  const foreignDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-cov-foreign-'));
  const foreign = path.join(foreignDir, 'foreign.mjs');
  realFs.writeFileSync(foreign, 'export const v = 1;\n');
  const fixture = f_writeFixture(`
    import { test } from 'node:test';
    import { v } from '${pathToFileURL(foreign).href}';
    test('scope', function scope() { if (v !== 1) throw new Error('范围外模块应真实加载'); });
  `);
  const done = f_setup();
  const run = async args => {
    const child = liteChildProcess.spawn('node', args);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    return { ...closed, stdout, stderr };
  };
  try {
    const dir = path.dirname(fixture);
    const foreignReal = realFs.realpathSync(foreignDir); // 覆盖率按 realpath 匹配（/var → /private/var）
    // 输入：默认运行、include 锚定夹具目录（等号取值）、exclude 排除范围外目录（空格取值，真实路径）。
    const all = await run(['--test', '--experimental-test-coverage', fixture]);
    const scoped = await run(['--test', '--experimental-test-coverage', `--test-coverage-include=${dir}/**`, fixture]);
    const excluded = await run(['--test', '--experimental-test-coverage', '--test-coverage-exclude', `${foreignReal}/**`, fixture]);
    // 预期 1：默认运行把加载到的范围外真实模块计入覆盖率表。
    assert.equal(all.code, 0, `范围用例应通过：${all.stderr}`);
    assert.match(all.stdout, /foreign\.mjs/, '默认运行应把范围外真实模块计入覆盖率');
    // 预期 2：include 锚定后范围外模块消失，夹具自身仍被统计。
    assert.doesNotMatch(scoped.stdout, /foreign\.mjs/, 'include 应把范围外模块排除出覆盖率');
    assert.match(scoped.stdout, /lite-cmd-node-fixture-[^.]*\.mjs/, 'include 后夹具自身仍应统计');
    // 预期 3：exclude（空格取值）同样把范围外模块排除。
    assert.doesNotMatch(excluded.stdout, /foreign\.mjs/, 'exclude 应把范围外模块排除出覆盖率');
    assert.match(excluded.stdout, /lite-cmd-node-fixture-[^.]*\.mjs/, 'exclude 不应波及夹具自身统计');
  } finally { done(); realFs.unlinkSync(fixture); realFs.rmSync(foreignDir, { recursive: true, force: true }); }
});

/** 场景：等待中的真实测试 Worker 随虚拟子进程终止，后续命令仍正常运行。 */
test('node --test 信号：终止等待中的真实 Worker 并清理资源', async () => {
  const fixture = f_writeFixture(`
    import { test } from 'node:test';
    test('blocked', async () => {
      const channel = new BroadcastChannel('litenvi-blocked-test');
      console.log('waiting-for-signal');
      await new Promise(resolve => { channel.onmessage = resolve; });
      channel.close();
    });
  `);
  const done = f_setup();
  let child;
  try {
    // 输入：真实方法已执行到等待状态，再从公共句柄发送终止信号。
    child = liteChildProcess.spawn('node', ['--test', '--', fixture]);
    const closed = liteChildProcess.waitForClose(child);
    await new Promise(resolve => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('waiting-for-signal')) resolve(); });
    });
    const killed = child.kill('SIGTERM');
    const result = await closed;
    // 预期 1：回执保留信号，Worker 被清理，不生成伪造成功结果。
    assert.equal(killed, true, '应能终止等待中的测试命令');
    assert.deepEqual(result, { code: null, signal: 'SIGTERM' }, '终止回执应保留 SIGTERM');
    // 预期 2：终止不会污染宿主命令分派。
    const version = liteChildProcess.spawnSync('npm', ['-v'], { encoding: 'utf8' });
    assert.equal(version.stdout, '10.9.0\n', '终止后后续命令仍应正常运行');
  } finally { child?.kill('SIGKILL'); done(); realFs.unlinkSync(fixture); }
});

/** 场景：普通 import 在宿主中加载源码，入口可重复执行，并发命令各自使用参数与输出管道。 */
test('普通 import：共享宿主全局、重复入口执行、并发输出与宿主环境恢复', async () => {
  const marker = Symbol.for('litenvi-node-native-import');
  globalThis[marker] = { count: 0 };
  const original = { argv: process.argv, env: process.env, cwd: process.cwd(), exitCode: process.exitCode,
    log: console.log, timer: setTimeout, readFile: realFs.readFileSync, exit: process.exit };
  const fixture = f_writeFixture(`
    const state = globalThis[Symbol.for('litenvi-node-native-import')];
    state.count++;
    await new Promise(resolve => setTimeout(resolve, Number(process.argv[2])));
    console.log(JSON.stringify({ tag: process.env.LITE_IMPORT_TAG, arg: process.argv[3], count: state.count }));
  `);
  const done = f_setup();
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

/** 场景：虚拟 Node 命令运行期间不替换原生 fs，CJS、ESM 默认和具名导入保持同一原生接口。
 * 夹具只观测原生接口身份，不通过原生 fs 读写业务文件；stdin 闸门保持命令运行以检查中间状态。 */
test('显式文件边界：运行中原生 fs 保持不变', { timeout: 5000 }, async () => {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const original = { read: realFs.readFileSync, write: realFs.writeFileSync, exists: realFs.existsSync };
  const fixture = f_writeFixture(`
    import fs from 'node:fs';
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { createRequire } from 'node:module';
    const cjsFs = createRequire(import.meta.url)('fs');
    console.log(JSON.stringify({
      esm: readFileSync === fs.readFileSync && writeFileSync === fs.writeFileSync && existsSync === fs.existsSync,
      cjs: cjsFs.readFileSync === fs.readFileSync && cjsFs.writeFileSync === fs.writeFileSync && cjsFs.existsSync === fs.existsSync,
    }));
    await new Promise(resolve => process.stdin.once('data', resolve));
    console.log('released');
  `);
  const done = f_setup();
  let child, closed;
  try {
    // 输入：启动夹具，收到接口观测结果后仍阻塞于 stdin，不使用固定睡眠猜测运行阶段。
    child = liteChildProcess.spawn('node', [fixture]);
    closed = liteChildProcess.waitForClose(child);
    let output = '';
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.split('\n')[0])); }
          catch (error) { reject(error); }
        }
      });
      child.once('error', reject);
      child.once('close', () => reject(new Error('夹具未报告接口身份便提前退出')));
    });
    const imports = await ready;
    // 预期 1：命令确实仍在运行，原生默认对象和 ESM 具名导出均未被换成包装函数。
    assert.equal(child.exitCode, null, 'stdin 闸门释放前虚拟 Node 应保持运行');
    assert.equal(realFs.readFileSync, original.read, '命令运行中不得替换原生 readFileSync');
    assert.equal(realFs.writeFileSync, original.write, '命令运行中不得替换原生 writeFileSync');
    assert.equal(realFs.existsSync, original.exists, '命令运行中不得替换原生 existsSync');
    assert.equal(nativeReadFileSync, original.read, '命令运行中不得改写 ESM 具名 readFileSync');
    assert.equal(nativeWriteFileSync, original.write, '命令运行中不得改写 ESM 具名 writeFileSync');
    assert.equal(nativeExistsSync, original.exists, '命令运行中不得改写 ESM 具名 existsSync');
    assert.deepEqual(imports, { esm: true, cjs: true }, '脚本中的 CJS 与 ESM 导入应保持一致的原生 fs 接口');

    // 输入：显式释放 stdin 闸门，等待命令通过正常生命周期结束。
    child.stdin.end('release');
    // 预期 2：命令正常退出，期间保留的原生接口在退出后仍保持原样。
    assert.deepEqual(await closed, { code: 0, signal: null }, '释放闸门后虚拟 Node 应正常结束');
    assert.ok(output.endsWith('released\n'), '脚本应在闸门释放后继续执行到结尾');
    assert.equal(realFs.readFileSync, original.read, '命令结束后原生 readFileSync 应保持原样');
    assert.equal(nativeReadFileSync, original.read, '命令结束后 ESM 具名 readFileSync 应保持原样');
  } finally {
    child?.stdin.end('cleanup');
    if (closed) await closed;
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：自研入口显式使用 lite-fs 执行读写和业务计算，写入故障经脚本处理后反映到 stderr 与退出码。 */
test('显式文件边界：lite-fs 读写与故障传播', async () => {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const fixture = f_writeFixture(`
    try {
      const input = JSON.parse(liteFs.readFileSync('/mock/project/input.json', 'utf8'));
      liteFs.writeFileSync('/mock/project/output.json', JSON.stringify({ doubled: input.value * 2 }));
      console.log('saved');
    } catch (error) {
      console.error(error.code);
      process.exitCode = 7;
    }
  `);
  const done = f_setup();
  let remove;
  try {
    // 输入：内存输入值为 6，真实入口负责读取、计算并保存结果，不预置输出。
    liteFs.mkdirSync('/mock/project', { recursive: true });
    liteFs.writeFileSync('/mock/project/input.json', '{"value":6}');
    const normal = liteChildProcess.spawn('node', [fixture]);
    let stdout = '';
    normal.stdout.on('data', chunk => { stdout += chunk; });
    // 预期 1：完整入口真实计算并写入内存卷，命令正常退出。
    assert.deepEqual(await liteChildProcess.waitForClose(normal), { code: 0, signal: null }, '显式 lite-fs 入口应正常结束');
    assert.equal(stdout, 'saved\n', '入口成功写入后应报告 saved');
    assert.deepEqual(JSON.parse(liteFs.readFileSync('/mock/project/output.json', 'utf8')), { doubled: 12 }, '入口应根据内存输入真实计算出 doubled=12');

    // 输入：清除上次输出，仅在 lite-fs 写入边界注入 EACCES，再执行同一完整入口。
    liteFs.unlinkSync('/mock/project/output.json');
    remove = liteFs.t_inject({ op: 'writeFileSync', path: '/mock/project/output.json', code: 'EACCES' });
    const failed = liteChildProcess.spawn('node', [fixture]);
    let stderr = '', failedOutput = '';
    failed.stderr.on('data', chunk => { stderr += chunk; });
    failed.stdout.on('data', chunk => { failedOutput += chunk; });
    // 预期 2：故障由脚本自身处理，产生预期退出码，不伪造写入成功或终止宿主进程。
    assert.deepEqual(await liteChildProcess.waitForClose(failed), { code: 7, signal: null }, '写入被拒绝时应按脚本逻辑退出 7');
    assert.equal(stderr, 'EACCES\n', '脚本应通过 stderr 报告写入错误码');
    assert.equal(failedOutput, '', '写入失败时不得报告 saved');
    assert.equal(liteFs.existsSync('/mock/project/output.json'), false, '故障写入不应生成输出文件');
  } finally {
    remove?.();
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：入口通过原生 child_process 导出调用嵌套命令，执行仍统一留在内存分派中。 */
test('嵌套命令：spawn/spawnSync 统一入账，未实现的 fork 明确失败', async () => {
  const fixture = f_writeFixture(`
    import { spawn, spawnSync, fork } from 'node:child_process';
    console.log(spawnSync('echo', ['nested-sync'], { encoding: 'utf8' }).stdout.trim());
    try { fork(); } catch (error) { console.log('fork-blocked', /未实现内存语义/.test(error.message)); }
    const child = spawn('echo', ['nested-async']);
    child.stdout.on('data', chunk => process.stdout.write(chunk));
  `);
  const done = f_setup();
  try {
    // 输入：普通 import 入口执行同步与异步嵌套命令；fork 不传参数以保证回退错误时也不会启动真实进程
    const child = liteChildProcess.spawn('node', [fixture]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    // 预期 1：父命令等待嵌套命令完成，所有输出进入父 stdout
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 0, signal: null }, '嵌套命令完成后父命令应正常退出');
    assert.equal(output, 'nested-sync\nfork-blocked true\nnested-async\n', '嵌套命令输出与 fork 边界应正确');
    // 预期 2：嵌套 echo 均记入内存运行账本
    assert.deepEqual(liteChildProcess.t_calls().map(call => call.command), ['node', 'echo', 'echo'], '嵌套命令应通过内存分派');
  } finally {
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：导入即登记——lite-cmd-node 被 import 后，mgr 注册表可按名寻址 node 与 npm 实现。 */
test('导入即登记：node/npm 在 mgr 登记名单、node 命令路径为 execPath 常量', () => {
  // 输入：读 mgr 注册表自省名单
  // 预期 1：node 完整路径在名单
  assert.ok(mgr.t_defined().includes(NODE_COMMAND_PATH), 'node 应在登记名单');
  // 预期 2：npm 完整路径在名单
  assert.ok(mgr.t_defined().includes('/mock-cmd/usr/local/bin/npm'), 'npm 应在登记名单');
  // 预期 3：裸名寻址到句柄
  assert.equal(mgr.command('node').path, NODE_COMMAND_PATH, '裸名 node 应寻址到命令句柄');
  // 预期 4：常量值为 /mock-cmd/usr/local/bin/node（lite-process 的 execPath 取此值）
  assert.equal(NODE_COMMAND_PATH, '/mock-cmd/usr/local/bin/node', 'node 命令路径应为命名空间内完整路径');
});

/** 场景：版本探测——node 使用宿主版本，npm 固定为 10.9.0。 */
test('版本探测：node 回宿主版本，npm 回固定 10.9.0', () => {
  const done = f_setup();
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
    // 预期 4：npm 版本使用固定模拟值，不依赖本机安装。
    assert.equal(npmV.stdout, '10.9.0\n', 'npm 版本应固定为 10.9.0');
  } finally {
    done();
  }
});

/** 场景：入口脚本执行——.mjs 入口执行真实源码，副作用/env/argv 均为子进程口径。 */
test('入口脚本执行：真实源码、env 落位、argv 子进程口径、旗标剔除', async () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project', { recursive: true }); // fixture 副作用目录（卷内；缺失则入口写入 ENOENT）
  liteProcess.t_mock({ cwd: '/mock/project' });
  const fixture = f_writeFixture(`
liteFs.writeFileSync('/mock/project/fixture-out.json', JSON.stringify({
  argv: process.argv.slice(1, 4), env: process.env.APP_CMD_NODE_PROBE, url: import.meta.url,
}));`);
  liteChildProcess.t_mock();
  try {
    // 输入：spawn node（带入口前旗标 + 入口后参数 + 自定义 env）
    const child = liteChildProcess.spawn('node', ['--max-old-space-size=1', fixture, '--after'], {
      env: { APP_CMD_NODE_PROBE: 'lit' },
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
    liteChildProcess.t_unmock();
    liteProcess.t_unmock();
    liteFs.t_unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：假世界并发执行 Node 文件入口，argv 双视图一致、子进程互不串线且父世界保持原值。 */
test('假世界文件入口：argv 双视图一致、并发隔离与父世界保持', async () => {
  // 输入：父世界 argv 为 parent.mjs --parent，入口记录两条 argv 视图并等待 stdin 放行
  const nativeArgv = process.argv;
  const parentArgv = [NODE_COMMAND_PATH, '/mock/project/parent.mjs', '--parent'];
  const processUrl = new URL('../lite-process.mjs', import.meta.url).href;
  const fixture = f_writeFixture(`
    import { liteProcess } from ${JSON.stringify(processUrl)};
    const f_snapshot = () => ({ native: [...process.argv], facade: [...liteProcess.argv] });
    const before = f_snapshot();
    console.log('ready');
    await new Promise(resolve => process.stdin.once('data', resolve));
    console.log(JSON.stringify({ before, after: f_snapshot() }));
  `);
  const done = f_setup();
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteProcess.t_mock({ cwd: '/mock/project', argv: parentArgv });
  const running = [];
  const launch = tag => {
    const child = liteChildProcess.spawn('node', ['--no-warnings', fixture, tag]);
    const run = { child, stdout: '', stderr: '', closed: liteChildProcess.waitForClose(child) };
    run.ready = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        run.stdout += chunk;
        if (run.stdout.startsWith('ready\n')) resolve();
      });
      child.stderr.on('data', chunk => { run.stderr += chunk; });
      run.closed.then(() => {
        if (!run.stdout.startsWith('ready\n')) reject(new Error(`入口 ${tag} 未就绪：${run.stderr}`));
      }, reject);
    });
    running.push(run);
    return run;
  };
  const parentSnapshot = () => ({ native: [...process.argv], facade: [...liteProcess.argv] });
  try {
    // 预期 1：启动前父世界 argv 与 mock 给定值一致
    assert.deepEqual(liteProcess.argv, parentArgv, '启动前父世界 argv 应为给定值');
    // 输入：先启动 A 并等待就绪，再启动 B；分别记录只有 A 和 A/B 同时运行时的父世界视图
    const first = launch('A');
    await first.ready;
    const duringFirst = parentSnapshot();
    const second = launch('B');
    await second.ready;
    const duringBoth = parentSnapshot();
    // 输入：通过 stdin 先放行 B，保留 A 的等待状态
    second.child.stdin.end('continue');
    // 预期 2：B 在 A 仍等待时正常退出
    assert.deepEqual(await second.closed, { code: 0, signal: null }, `入口 B 应正常退出：${second.stderr}`);
    // 输入：B 退出后再通过 stdin 放行 A，使 A 重读自己的 argv
    first.child.stdin.end('continue');
    // 预期 3：A 恢复执行后正常退出
    assert.deepEqual(await first.closed, { code: 0, signal: null }, `入口 A 应正常退出：${first.stderr}`);

    const expectedChild = tag => {
      const argv = [NODE_COMMAND_PATH, fixture, tag];
      return { before: { native: argv, facade: argv }, after: { native: argv, facade: argv } };
    };
    const expectedParent = { native: [...nativeArgv], facade: parentArgv };
    // 预期 4：入口等待前后的双视图均为各自参数，父世界运行中和结束后保持原值，宿主 argv 不变
    assert.deepEqual({
      first: JSON.parse(first.stdout.slice('ready\n'.length)),
      second: JSON.parse(second.stdout.slice('ready\n'.length)),
      duringFirst, duringBoth, after: parentSnapshot(),
    }, {
      first: expectedChild('A'), second: expectedChild('B'),
      duringFirst: expectedParent, duringBoth: expectedParent, after: expectedParent,
    }, '文件入口的 argv 双视图应随各自运行上下文隔离，不能覆盖父世界或其他子进程');
  } finally {
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(running.map(run => run.closed));
    done();
    liteProcess.t_unmock();
    process.argv = nativeArgv;
    realFs.unlinkSync(fixture);
  }
});

/** 场景：假世界文件入口异常退出或被终止后，父世界与宿主 argv 保持原值。 */
test('假世界文件入口：异常退出与 kill 保持父世界 argv', async () => {
  // 输入：入口先输出两条 argv 视图，收到 stdin 后抛错或显式退出；kill 场景保持等待
  const nativeArgv = process.argv;
  const parentArgv = [NODE_COMMAND_PATH, '/mock/project/parent.mjs', '--parent'];
  const processUrl = new URL('../lite-process.mjs', import.meta.url).href;
  const fixture = f_writeFixture(`
    import { liteProcess } from ${JSON.stringify(processUrl)};
    console.log(JSON.stringify({ native: process.argv, facade: liteProcess.argv }));
    await new Promise(resolve => process.stdin.once('data', resolve));
    if (process.argv[2] === 'throw') throw new Error('argv-entry-failure');
    process.exit(7);
  `);
  const done = f_setup();
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteProcess.t_mock({ cwd: '/mock/project', argv: parentArgv });
  let child;
  try {
    for (const mode of ['throw', 'exit', 'kill']) {
      // 输入：分别执行抛错、显式退出与外部终止三个文件入口
      child = liteChildProcess.spawn('node', [fixture, mode]);
      const closed = liteChildProcess.waitForClose(child);
      const output = await new Promise(resolve => child.stdout.once('data', chunk => resolve(String(chunk))));
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const argv = [NODE_COMMAND_PATH, fixture, mode];
      // 预期 1：异常发生前，两条 argv 视图一致，父世界和宿主参数未被覆盖
      assert.deepEqual(JSON.parse(output), { native: argv, facade: argv }, `${mode} 入口应读取自己的参数`);
      assert.deepEqual(liteProcess.argv, parentArgv, `${mode} 运行期间父世界参数应保持原值`);
      assert.equal(process.argv, nativeArgv, `${mode} 运行期间宿主 argv 引用应保持原值`);
      // 输入：kill 场景直接终止，其余场景通过 stdin 放行入口
      if (mode === 'kill') child.kill();
      else child.stdin.end('continue');
      // 预期 2：退出方式符合输入，退出后父世界和宿主参数保持原值
      assert.deepEqual(await closed, mode === 'kill' ? { code: null, signal: 'SIGTERM' }
        : { code: mode === 'throw' ? 1 : 7, signal: null }, `${mode} 应按对应方式退出`);
      if (mode === 'throw') assert.match(stderr, /argv-entry-failure/, '入口异常应通过 stderr 报告');
      assert.deepEqual(liteProcess.argv, parentArgv, `${mode} 结束后父世界参数应保持原值`);
      assert.equal(process.argv, nativeArgv, `${mode} 结束后宿主 argv 引用应保持原值`);
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const closed = liteChildProcess.waitForClose(child);
      child.kill();
      await closed;
    }
    done();
    liteProcess.t_unmock();
    process.argv = nativeArgv;
    realFs.unlinkSync(fixture);
  }
});

/** 场景：入口加载失败——顶层抛错的入口按子进程异常退出收场（stderr + exit 1）。 */
test('入口加载失败：stderr 带错误信息、退出码 1', async () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  const fixture = f_writeFixture(`throw new Error('fixture-boom');`);
  liteChildProcess.t_mock();
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
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：内联求值——-e 执行代码，stdout 写入子进程管道并正常退出。 */
test('内联求值：-e 输出进入 stdout，执行结束正常退出', async () => {
  const done = f_setup();
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
  const done = f_setup();
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
    await new Promise(resolve => setImmediate(resolve)); // 负空间观察：终止后无新输出
    assert.equal(output, stoppedOutput, '终止后定时器不得继续输出');
  } finally {
    done();
  }
});

/** 场景：共享服务门面——入口使用调用方的 liteServer 环境，关闭监听后正常退出。 */
test('共享服务门面：内存服务关闭后 Node 正常退出', async () => {
  const done = f_setup();
  liteServer.t_mock();
  const serverUrl = new URL('../lite-server.mjs', import.meta.url).href;
  const fixture = f_writeFixture(`
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
    liteServer.t_unmock();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：撤销环境——unmock 停止子进程任务，防止定时器继续修改内存文件。 */
test('撤销环境：unmock 后定时器不再产生文件副作用', async () => {
  const fixture = f_writeFixture(`
    let count = 0;
    const timer = setInterval(() => {
      liteFs.writeFileSync('/node-ticks', String(++count));
      console.log('tick');
      if (count === 10) clearInterval(timer);
    }, 5);
  `);
  const done = f_setup();
  try {
    // 输入：定时器每次写文件，首次完成后撤销子进程 mock；次数上限防止失败时挂住测试
    const child = liteChildProcess.spawn('node', [fixture]);
    await new Promise(resolve => child.stdout.once('data', resolve));
    const last = liteFs.readFileSync('/node-ticks', 'utf8');
    liteChildProcess.t_unmock();
    await new Promise(resolve => setImmediate(resolve)); // 负空间观察：撤销后无新写入
    // 预期 1：环境撤销后，原子进程的定时器不能再写文件
    assert.equal(liteFs.readFileSync('/node-ticks', 'utf8'), last, 'unmock 应取消活动子进程的定时器');
  } finally {
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：同步入口限制——spawnSync('node', [入口]) 未实现（import 是异步的），失败并指引。 */
test('同步入口限制：spawnSync 入口按失败收场并指引改用 spawn', () => {
  const done = f_setup();
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
  const done = f_setup();
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


/** 场景：-- 结束选项解析，脚本与 stdin 两条公共执行路径均能输出结果。 */
test('Node 选项终止符：-- 后运行脚本，无脚本时读取 stdin', async () => {
  const done = f_setup();
  const fixture = f_writeFixture('console.log(process.argv.slice(2).join("|"));');
  const run = (args, input) => {
    const child = liteChildProcess.spawn('node', args);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = liteChildProcess.waitForClose(child);
    child.stdin.end(input);
    return closed.then(result => ({ ...result, stdout, stderr }));
  };
  try {
    // 输入：脚本名后的 -flag 是 argv；只有 -- 时通过 stdin 提供 JavaScript
    assert.deepEqual(await run(['--', fixture, '-flag']), { code: 0, signal: null, stdout: '-flag\n', stderr: '' }, '终止符后的脚本参数应保持字面值');
    assert.deepEqual(await run(['--'], 'console.log("stdin-after-separator")'),
      { code: 0, signal: null, stdout: 'stdin-after-separator\n', stderr: '' }, '无脚本名时应执行 stdin');
  } finally { done(); realFs.unlinkSync(fixture); }
});

/** 场景：脚本重设 process 字段仅影响虚拟运行态，宿主同时写 argv 后仍能恢复。 */
test('Process 字段写入：脚本与宿主环境保持各自视图', async () => {
  const done = f_setup();
  const originalArgv = process.argv;
  const originalEnv = process.env;
  try {
    // 输入：脚本从原生 process 入口写字段，并在退出前保持活动
    const child = liteChildProcess.spawn('node', ['-e', `
      const nativeProcess = require('node:process');
      nativeProcess.argv = ['script-argv'];
      nativeProcess.env = { MARK: 'script-env' };
      nativeProcess.execArgv = ['script-exec-argv'];
      process.liteCoverageMarker = 'shared-property';
      console.log(JSON.stringify([process.argv, process.env.MARK, process.execArgv, process.liteCoverageMarker]));
      delete process.liteCoverageMarker;
      setInterval(() => {}, 1000);
    `]);
    const closed = liteChildProcess.waitForClose(child);
    try {
      const output = await new Promise(resolve => child.stdout.once('data', chunk => resolve(chunk.toString())));
      // 预期：脚本可以写自己的 process 字段，宿主不读取到这些虚拟值
      assert.deepEqual(JSON.parse(output), [['script-argv'], 'script-env', ['script-exec-argv'], 'shared-property'], '脚本应看到自己的写入');
      assert.equal(process.env, originalEnv, '宿主环境对象不应被脚本替换');
      process.argv = [...originalArgv, 'host-argv'];
      assert.equal(process.argv.at(-1), 'host-argv', '宿主上下文仍能写自己的 argv');
    } finally { process.argv = originalArgv; child.kill(); await closed; }
    assert.equal(process.argv, originalArgv, '运行结束后宿主 argv 引用应恢复');
    assert.equal(process.liteCoverageMarker, undefined, '脚本创建的共享属性应已自行清理');
  } finally { process.argv = originalArgv; done(); }
});

/** 场景：终止持有监听服务的脚本时，服务资源也随命令释放。 */
test('活动服务清理：终止 Node 后关闭其监听端口', async () => {
  const done = f_setup();
  liteServer.t_mock();
  const serverUrl = new URL('../lite-server.mjs', import.meta.url).href;
  const fixture = f_writeFixture(`
    import server from '${serverUrl}';
    server.createServer((_req, res) => res.end('active')).listen(0, () => console.log('ready'));
  `);
  try {
    // 输入：脚本保持服务监听，从公共子进程句柄终止它
    const child = liteChildProcess.spawn('node', [fixture]);
    const closed = liteChildProcess.waitForClose(child);
    await new Promise(resolve => child.stdout.once('data', resolve));
    const port = liteServer.t_port();
    assert.ok(port > 0, '终止前服务应有实际监听端口');
    child.kill();
    // 预期：子进程以信号结束，服务监听已解除
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' }, '终止信号应反映在子进程结果上');
    const { default: http } = await import('node:http');
    const connection = await new Promise(resolve => {
      http.get({ hostname: '127.0.0.1', port }, response => { response.resume(); resolve('connected'); })
        .on('error', error => resolve(error.code));
    });
    assert.equal(connection, 'ECONNREFUSED', '命令结束后原端口应拒绝新连接');
  } finally { done(); liteServer.t_unmock(); realFs.unlinkSync(fixture); }
});

/** 场景：信号到达虚拟进程时已注册处理器则消费执行，未注册则按默认语义终止。 */
test('内存 Node 收到信号时执行处理器，未处理信号仍直接终止', async () => {
  // 输入：虚拟进程注册 SIGTERM 处理器后收信号，对照未注册形态。
  const done = f_setup();
  try {
    const child = liteChildProcess.spawn('node', ['-e', "process.on('SIGTERM', () => { console.log('received'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000)"]);
    let output = '';
    await new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) resolve(); }));
    const closed = liteChildProcess.waitForClose(child);
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 7, signal: null }, '处理器应决定退出码');
    assert.match(output, /received/, '处理器应收到信号');
    const other = liteChildProcess.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise(resolve => other.once('spawn', resolve));
    const terminated = liteChildProcess.waitForClose(other);
    other.kill('SIGTERM');
    assert.deepEqual(await terminated, { code: null, signal: 'SIGTERM' }, '未处理信号应按信号终止');
  } finally { done(); }
});

/** 场景：虚拟进程内经 process.kill 探测自身与他者 PID 的存活语义。 */
test('内存 Node 通过 process.kill 检查虚拟进程存活', async () => {
  // 输入：进程脚本内经 process.kill 以信号 0 探测自身与未知 PID。
  const done = f_setup();
  try {
    const child = liteChildProcess.spawn('node', ['-e', `
      try { console.log(process.kill(process.pid, 0)); }
      catch (error) { console.log(error.code); }
      try { process.kill(2147483647, 0); }
      catch (error) { console.log(error.code); }
    `]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 0, signal: null }, '处理器消费信号后应正常退出');
    assert.equal(output.trim(), 'true\nESRCH', '脚本应能检查虚拟 PID，未知 PID 返回 ESRCH');
  } finally { done(); }
});

/** 场景：服务关闭回调挂起不阻塞信号关停的进程内兜底退出路径。 */
test('信号关停遇到服务关闭挂起时仍触发进程内兜底退出', async () => {
  // 输入：关闭回调注入挂起故障后向进程发送关停信号。
  const done = f_setup();
  liteServer.t_mock();
  const fixture = f_writeFixture(`
    import liteServer from ${JSON.stringify(new URL('../lite-server.mjs', import.meta.url).href)};
    const server = liteServer.createServer((_req, res) => res.end('ok'));
    server.listen(0, () => console.log('ready'));
    process.on('SIGTERM', () => {
      setTimeout(() => { console.log('fallback'); process.exit(0); }, 60).unref();
      server.close(() => { console.log('closed'); process.exit(0); });
    });
  `);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  try {
    liteServer.t_inject({ operation: 'close', wait, once: true });
    const child = liteChildProcess.spawn('node', [fixture]);
    let output = '';
    await new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) resolve(); }));
    const closed = liteChildProcess.waitForClose(child);
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 0, signal: null }, '兜底应以正常退出码结束');
    assert.match(output, /fallback/, '关闭挂起时应执行兜底');
    assert.doesNotMatch(output, /closed/, '闸门释放前关闭回调不得执行');
  } finally { release(); liteServer.t_unmock(); done(); realFs.rmSync(fixture, { force: true }); }
});

/** 场景：spawn 输入暂存为 fd 0——脚本内 liteFs.readFileSync(0) 同步读到 spawn 的 input；无输入读得空串。 */
test('stdin 同步读面：脚本 liteFs.readFileSync(0) 收到 spawn input，无输入为空', async () => {
  const done = f_setup();
  const fixture = f_writeFixture(`
    process.stdout.write(liteFs.readFileSync(0, 'utf8'));
  `);
  try {
    // 输入：带 input 的异步 spawn（脚本同步读 fd 0）
    const withInput = await new Promise(resolve => {
      const child = liteChildProcess.spawn('node', [fixture], { input: 'guard-payload\n' });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', () => resolve({ stdout }));
    });
    assert.equal(withInput.stdout, 'guard-payload\n', '预期 1：stdout 回显 stdin 输入');
    // 输入：无 input（暂存空缓冲）
    const noInput = await new Promise(resolve => {
      const child = liteChildProcess.spawn('node', [fixture], {});
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', () => resolve({ stdout }));
    });
    assert.equal(noInput.stdout, '', '预期 2：无输入读得空串');
  } finally { done(); realFs.rmSync(fixture, { force: true }); }
});

/** 场景：跨运行隔离——上一次运行的 fd 0 暂存在 dispose 时释放，后继运行只读到自己的输入。 */
test('stdin 暂存跨运行隔离：第二次运行不残留第一次输入', async () => {
  const done = f_setup();
  const fixture = f_writeFixture(`
    process.stdout.write(liteFs.readFileSync(0, 'utf8'));
  `);
  try {
    // 输入：同一夹具连续两次不同输入
    const outputs = [];
    for (const input of ['first\n', 'second\n']) {
      outputs.push(await new Promise(resolve => {
        const child = liteChildProcess.spawn('node', [fixture], { input });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', () => resolve(stdout));
      }));
    }
    // 预期：两次运行各自读到自己的输入，无跨运行残留
    assert.deepEqual(outputs, ['first\n', 'second\n'], '输出应按完成顺序逐条到达');
  } finally { done(); realFs.rmSync(fixture, { force: true }); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——命令集无独立门面实例，以测试协作面
 * t_commands 的函数身份验证（业务经 litenvi-node/lite-cmd-node.mjs 导入须与库内部相对导入一致）。 */
test('包自引用 specifier 与相对导入共享同一单例', async () => {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('litenvi-node/lite-cmd-node.mjs');
  assert.equal(selfRef.t_commands(), t_commands(), '同一模块经不同 specifier 应共享同一实例');
});

/** 场景：npm run 在内存世界执行 package.json 脚本——banner、嵌套命令输出、退出码与 `--`
 * 参数透传均经内存分派，未找到脚本/清单、未登记命令与 shell 语法明确失败。 */
test('npm run：内存执行脚本、banner 与退出码透传', async () => {
  const done = f_setup();
  const helloFixture = f_writeFixture("console.log('hello-out');");
  try {
    // 输入：内存卷装配示例项目——入口脚本为真实夹具文件（import 经原生加载器），`--` 参数追加到脚本 argv。
    liteFs.mkdirSync('/proj', { recursive: true });
    liteFs.writeFileSync('/proj/package.json', JSON.stringify({
      name: 'demo', version: '1.2.3',
      scripts: {
        hello: `node ${helloFixture}`,
        args: 'node -p "process.argv.slice(1).join(\'|\')"',
        bad: 'no-such-cmd --flag',
        pipe: 'echo a && echo b',
      },
    }));
    const run = async (argv, cwd = '/proj') => {
      const child = liteChildProcess.spawn('npm', argv, { cwd, encoding: 'utf8' });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = await liteChildProcess.waitForClose(child);
      return { code: closed.code, stdout, stderr };
    };
    // 预期 1：合法脚本的 banner（含 name@version 与命令行）、嵌套输出与退出 0。
    const hello = await run(['run', 'hello']);
    assert.equal(hello.code, 0, 'npm run 合法脚本应退出 0');
    assert.ok(hello.stdout.includes(`> demo@1.2.3 hello\n> node ${helloFixture}\n\n`), 'banner 应含 name@version 与命令行');
    assert.ok(hello.stdout.includes('hello-out'), '嵌套命令输出应透传');
    // 预期 2：`--` 之后的参数原样追加到脚本 argv。
    const args = await run(['run', 'args', '--', 'x', 'y']);
    assert.equal(args.code, 0, '参数透传脚本应退出 0');
    assert.ok(args.stdout.includes('x|y'), '-- 参数应追加到脚本 argv');
    // 预期 3：脚本缺失、package.json 缺失、未登记命令与 shell 操作符均明确失败。
    const missing = await run(['run', 'absent']);
    assert.equal(missing.code, 1, '缺失脚本应退出 1');
    assert.ok(missing.stderr.includes('Missing script: "absent"'), '缺失脚本应按 npm 口径报错');
    const noPkg = await run(['run', 'hello'], liteFs.mkdirSync('/nowhere', { recursive: true }) && '/nowhere');
    assert.equal(noPkg.code, 1, '无 package.json 应退出 1');
    assert.ok(noPkg.stderr.includes('未找到 package.json'), '无 package.json 应明确报错');
    const bad = await run(['run', 'bad']);
    assert.equal(bad.code, 127, '未登记命令应退出 127');
    assert.ok(bad.stderr.includes('未在内存命令集登记'), '未登记命令应指明命令名');
    const pipe = await run(['run', 'pipe']);
    assert.equal(pipe.code, 1, 'shell 操作符脚本应退出 1');
    assert.ok(pipe.stderr.includes('未实现的 shell 语法'), 'shell 操作符应明确报错');
  } finally { done(); realFs.unlinkSync(helloFixture); }
});

/** 场景：npm run 同步面要求嵌套命令提供同步实现；用户级命令可同步执行，异步专用命令明确
 * 报 127；信号转发给嵌套命令并由其结算退出码。 */
test('npm run：同步面限制与信号转发', async () => {
  const done = f_setup();
  const slowFixture = f_writeFixture("process.stdout.write('ready');\nprocess.on('SIGTERM', () => { process.stdout.write('term'); process.exit(3); });\n");
  try {
    // 输入：用户级同步命令 + 仅异步的 node 真实夹具脚本（SIGTERM 自结算）。
    liteFs.mkdirSync('/proj', { recursive: true });
    liteFs.writeFileSync('/proj/package.json', JSON.stringify({
      name: 'demo', version: '1.0.0',
      scripts: { sync: 'mocksync --flag', nodeonly: `node ${slowFixture}`, slow: `node ${slowFixture}`, asynccmd: 'asyncmd' },
    }));
    mgr.t_defineUserCommand('mocksync', {
      i_runSync: argv => ({ status: 0, stdout: `sync-ok ${argv.join(',')}\n`, stderr: '' }),
    });
    mgr.t_defineUserCommand('asyncmd', {
      i_run(argv, ctx, child) { child.stdout.write('async\n'); child.emit('exit', 0, null); child.emit('close', 0, null); },
    });
    // 预期 1：同步面执行提供同步实现的命令，banner 与输出聚合。
    const sync = liteChildProcess.spawnSync('npm', ['run', 'sync'], { cwd: '/proj', encoding: 'utf8' });
    assert.equal(sync.status, 0, '同步命令经 npm run 应退出 0');
    assert.ok(sync.stdout.includes('> demo@1.0.0 sync\n> mocksync --flag\n\n'), '同步面应保留 banner');
    assert.ok(sync.stdout.includes('sync-ok --flag'), '同步面应聚合嵌套输出');
    // 预期 2：node 的同步限制按其自身消息透传（status 1）；完全无同步实现的命令报 127。
    const nodeOnly = liteChildProcess.spawnSync('npm', ['run', 'nodeonly'], { cwd: '/proj', encoding: 'utf8' });
    assert.equal(nodeOnly.status, 1, 'node 同步限制应透传其退出码');
    assert.ok(nodeOnly.stderr.includes('同步执行未实现'), 'node 同步限制消息应透传');
    const asyncOnly = liteChildProcess.spawnSync('npm', ['run', 'asynccmd'], { cwd: '/proj', encoding: 'utf8' });
    assert.equal(asyncOnly.status, 127, '无同步实现的命令应报 127');
    assert.ok(asyncOnly.stderr.includes('无法同步执行'), '同步面应说明无法同步执行');
    // 预期 3：npm 子进程的 SIGTERM 转发给嵌套命令，退出码由脚本结算。
    const child = liteChildProcess.spawn('npm', ['run', 'slow'], { cwd: '/proj', encoding: 'utf8' });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    await new Promise(resolve => child.stdout.on('data', function ready(chunk) {
      if (String(stdout).includes('ready')) { child.stdout.off('data', ready); resolve(); }
    }));
    child.kill('SIGTERM');
    const closed = await liteChildProcess.waitForClose(child);
    assert.equal(closed.code, 3, 'SIGTERM 应转发嵌套命令并按脚本退出码结算');
    assert.ok(stdout.includes('term'), '信号处理输出应透传');
  } finally { done(); realFs.unlinkSync(slowFixture); }
});
