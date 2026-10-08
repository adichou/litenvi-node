// 跨项目测试环境（environment）：在独立 VM 中加载完整生产模块，只在 Node 环境边界注入替身。
// 不截断服务端源码、不替换业务函数，也不在全局 monkey-patch 宿主进程。本文件不含任何具体
// 项目的业务语义，可在任意 Node 项目复用：虚拟项目根、源码根、进程环境变量、初始数据铺设
// 与写入失败注入均由调用方传入（projectRoot / srcRoot / env / initialData / failWrite）；项目
// 专属的装配与业务断言放在项目的 utils 层（依赖方向：utils → environment，不反向依赖）。
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Volume, createFsFromVolume } from 'memfs';
import FakeTimers from '@sinonjs/fake-timers';
import { createFsView } from './fs.mjs';
import { createGitView } from './git.mjs';
import { createHttpTransport } from './http.mjs';

export async function buildMockEnvironment({
  srcRoot, projectRoot, env = {}, initialData, failWrite,
  now = '2026-10-08T04:00:00.000Z',
} = {}) {
  if (!srcRoot) throw new Error('buildMockEnvironment 需要显式传入 srcRoot（生产入口源码文件路径，其所在目录即源码加载边界）。');
  if (!projectRoot) throw new Error('buildMockEnvironment 需要显式传入 projectRoot（Mock 世界的虚拟项目根，与调用方业务路径同源）。');
  if (!vm.SourceTextModule) throw new Error('请通过聚合入口运行，或给 Node 添加 --experimental-vm-modules。');
  const srcRootDir = path.dirname(srcRoot);
  const volume = new Volume();
  const filesystem = createFsFromVolume(volume);
  // Mock 家目录与临时目录：任意项目的 os.homedir()/tmpdir() 缺省落点。
  filesystem.mkdirSync('/mock/home', { recursive: true });
  filesystem.mkdirSync('/mock/tmp', { recursive: true });
  const clock = FakeTimers.createClock(Date.parse(now));
  const unexpected = [];
  const logs = [];
  let disposed = false;

  function deny(label) {
    return (...args) => {
      const error = new Error(`未声明的环境调用：${label} ${JSON.stringify(args.slice(0, 2))}`);
      unexpected.push(error.message);
      throw error;
    };
  }

  // 假 HTTP 传输层：服务端不绑定真实端口，客户端 request() 直调内存流（见 request.mjs）。
  const transport = createHttpTransport({ deny });

  const writeFileSync = filesystem.writeFileSync.bind(filesystem);
  filesystem.writeFileSync = (target, ...args) => {
    if (failWrite && failWrite(target)) {
      throw Object.assign(new Error('注入的文件写入失败'), { code: 'EIO' });
    }
    return writeFileSync(target, ...args);
  };
  // 初始数据由调用方铺设；之后一切状态均由真实生产业务写入。
  if (initialData) initialData(filesystem);

  // 内存 Git 沙盒：模拟真实仓库的常见命令序列（is-inside-work-tree / show-toplevel /
  // status --porcelain / add -A / commit --only / rev-parse HEAD），让依赖 git 的业务
  // 链路在内存中完整跑通；序列之外的任何 git 调用仍按未声明调用拒绝并记账。
  const gitLog = [];
  const committedPaths = new Set();
  const fakeGit = (argv) => {
    const readonly = argv[0] === '--no-optional-locks';
    const args = readonly ? argv.slice(1) : argv;
    const pathspec = () => args.slice(args.indexOf('--') + 1)[0];
    if (args[0] === 'rev-parse') {
      if (args[1] === '--is-inside-work-tree') return { status: 0, stdout: 'true\n', stderr: '' };
      if (args[1] === '--show-toplevel') return { status: 0, stdout: `${projectRoot}\n`, stderr: '' };
      if (args[1] === 'HEAD') {
        return gitLog.length
          ? { status: 0, stdout: `${gitLog[gitLog.length - 1].hash}\n`, stderr: '' }
          : { status: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" };
      }
    }
    if (args[0] === 'status' && args[1] === '--porcelain' && args.includes('--')) {
      const target = pathspec();
      // 已入库路径已从工作区移除：模拟真实 git 的未暂存删除差异（删除即留痕链路依赖此判定）。
      if (committedPaths.has(target) && !filesystem.existsSync(path.join(projectRoot, target))) {
        return { status: 0, stdout: ` D ${target}\n`, stderr: '' };
      }
      return { status: 0, stdout: committedPaths.has(target) ? '' : `?? ${target}/\n`, stderr: '' };
    }
    if (!readonly && args[0] === 'add' && args[1] === '-A' && args.includes('--')) {
      const target = pathspec();
      // 已跟踪路径的删除可暂存（git add -A 报告删除）；从未入库的缺失路径仍按 pathspec 错误拒绝。
      if (!filesystem.existsSync(path.join(projectRoot, target)) && !committedPaths.has(target)) {
        return { status: 128, stdout: '', stderr: `fatal: pathspec '${target}' did not match any files\n` };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (!readonly && args[0] === 'commit' && args.includes('--only') && args.includes('-m')) {
      const subject = args[args.indexOf('-m') + 1];
      const paths = args.slice(args.indexOf('--') + 1);
      for (const item of paths) committedPaths.add(item);
      // 复用确定性随机序列生成提交号：结果稳定可断言，短号随提交次序变化。
      const hash = cryptoMock.randomBytes(20).toString('hex');
      gitLog.push({ hash, subject, paths });
      return { status: 0, stdout: '', stderr: '' };
    }
    return deny('git 序列外调用')(args.join(' '));
  };
  const childProcess = {
    spawn: deny('spawn'), execFile: deny('execFile'), execFileSync: deny('execFileSync'),
    exec: deny('exec'), execSync: deny('execSync'), fork: deny('fork'),
    spawnSync(command, args, options) {
      if (command === 'git' && options?.cwd === projectRoot) return fakeGit(args);
      return deny('spawnSync')(command, args);
    },
  };
  const processMock = Object.assign(new EventEmitter(), {
    env: { HOME: '/mock/home', PATH: '', ...env },
    cwd: () => projectRoot, pid: 4242, platform: 'darwin', arch: 'arm64',
    execPath: '/mock/node', argv: ['/mock/node', srcRoot],
    kill: deny('process.kill'), exit: deny('process.exit'),
  });
  let randomSequence = 0;
  const cryptoMock = {
    ...crypto,
    randomBytes: (size) => Buffer.alloc(size, ++randomSequence % 256),
    randomUUID: () => `00000000-0000-4000-8000-${String(++randomSequence).padStart(12, '0')}`,
  };
  const osMock = { homedir: () => '/mock/home', tmpdir: () => '/mock/tmp', platform: () => 'darwin', arch: () => 'arm64' };
  const mocks = {
    'node:fs': filesystem, 'node:child_process': childProcess, 'node:crypto': cryptoMock,
    'node:os': osMock, 'node:http': transport.httpMock,
    'node:https': { request: deny('https.request'), get: deny('https.get') },
    'node:net': { createServer: deny('net.createServer'), connect: deny('net.connect'), createConnection: deny('net.createConnection') },
  };
  const context = vm.createContext({
    process: processMock, Buffer, URL, URLSearchParams,
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    fetch: deny('fetch'),
  });
  const modules = new Map();
  const pureBuiltins = new Set(['node:path', 'node:url', 'node:util']);

  async function loadModule(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    if (identifier.startsWith('node:')) {
      let values = mocks[identifier];
      if (!values) {
        if (!pureBuiltins.has(identifier)) return deny('未注入模块')(identifier);
        values = await import(identifier);
      }
      const exports = { ...values, default: values.default || values };
      const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context, identifier });
      modules.set(identifier, module);
      return module;
    }
    const filename = fileURLToPath(identifier);
    if (!filename.startsWith(`${srcRootDir}${path.sep}`)) return deny('srcRoot 目录外模块')(filename);
    // 真实文件读取仅用于测试执行器加载源码，业务 fs 已完全替换为内存文件系统。
    const module = new vm.SourceTextModule(realFs.readFileSync(filename, 'utf8'), {
      context, identifier,
      initializeImportMeta(meta) { meta.url = identifier; },
    });
    modules.set(identifier, module);
    return module;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    clock.reset();
    processMock.removeAllListeners();
    await transport.close();
    volume.reset();
    assert.equal(clock.countTimers(), 0, '环境清理后不得残留定时任务');
    assert.ok(!transport.isListening(), '环境清理后服务必须关闭');
    // 收口自动检查：用例无须显式调用，任何未声明的环境调用都在这里红。
    assert.deepEqual(unexpected, [], `环境收口：不得有未声明的环境调用；服务日志：\n${logs.join('\n')}`);
  }

  try {
    const entry = await loadModule(pathToFileURL(srcRoot).href);
    await entry.link((specifier, parent) => loadModule(specifier.startsWith('node:')
      ? specifier : new URL(specifier, parent.identifier).href));
    await entry.evaluate();
    await transport.waitForListening();
  } catch (error) {
    try { await dispose(); } catch { /* 启动已失败：保留原始错误，收口问题不掩盖 */ }
    throw error;
  }
  return {
    now, dispose,
    // 通用观测面：未声明调用记账、服务日志，以及只读的 fs / git 查询对象与 http 入口
    // （request 动作 + requests 流水账）。
    unexpected, logs,
    fs: createFsView(filesystem),
    git: createGitView(gitLog, committedPaths),
    http: Object.freeze({ request: transport.request, requests: transport.requests }),
  };
}
