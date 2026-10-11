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
import { createStorageMock } from './browser-storage.mjs';

// 可控写入故障开关：维护一个目标片段集合（子串匹配），命中任一片段即视为应注入写入失败。
// 片段可在用例运行中动态增删（故障解除后重试、只对指定目标故障等场景）；本身不含任何
// 业务路径语义，调用方把项目专属的基础谓词与 matches 组合后传给 buildMockEnvironment
// 的 failWrite 即可。
export function setFileWriteError() {
  const fragments = new Set();
  return {
    matches: (target) => [...fragments].some((frag) => target.includes(frag)),
    add: (...frags) => { for (const frag of frags) fragments.add(frag); },
    remove: (frag) => { fragments.delete(frag); },
  };
}

// 最小组件替身：浏览器界面元素的状态面（文本/标题/类名/数据集/属性），只记录状态变化，
// 不做任何布局与 DOM 结构——供 View–Action 架构的 action 用例在无真实浏览器的情况下
// 断言 action 对界面组件状态的感知与修改。零业务语义，任意项目可复用。
export function createElement(tag = 'div') {
  const classes = new Set();
  const attributes = new Map();
  return {
    tagName: String(tag).toUpperCase(),
    textContent: '', title: '', hidden: false,
    dataset: {},
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      toggle: (name, force) => {
        const target = force === undefined ? !classes.has(name) : Boolean(force);
        if (target) classes.add(name); else classes.delete(name);
        return target;
      },
      contains: (name) => classes.has(name),
    },
    get className() { return [...classes].join(' '); },
    setAttribute(name, value) { attributes.set(String(name), String(value)); },
    getAttribute(name) { return attributes.has(String(name)) ? attributes.get(String(name)) : null; },
  };
}

export async function buildMockEnvironment({
  srcRoot, projectRoot, env = {}, initialData, failWrite,
  now = '2026-10-08T04:00:00.000Z', sideEntries,
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
  const commandExitCodes = new Map();
  const unexpected = [];
  const logs = [];
  let sideEntriesFace = {};
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

  // 内存 Git 沙盒：模拟真实仓库的常见命令序列（init / switch / branch / rev-parse / rev-list /
  // log / remote / symbolic-ref / status --porcelain / add -A / commit --only），让依赖 git 的业务
  // 链路在内存中完整跑通；序列之外的任何 git 调用仍按未声明调用拒绝并记账。
  // 分支模型：默认分支 main（init -b 可指定）；bornBranches 只收录已指向提交的分支——
  // 空仓库时当前分支「未出生」（switch -c 等价改名，首个提交使其出生），与真实 git 语义一致。
  const gitLog = [];
  const committedPaths = new Set();
  let currentBranch = 'main';
  const bornBranches = new Set();
  // 整树工作区状态（workingTreeSnapshot 用的无 pathspec status）：遍历项目根，
  // 排除 .git / node_modules / 根 .gitignore 前缀规则与已提交路径；沙盒只有未跟踪（??）一种脏形态。
  const listUncommittedFiles = () => {
    let ignoreRules = [];
    try {
      ignoreRules = filesystem.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split('\n')
        .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    } catch { /* 无 .gitignore */ }
    const ignored = (rel) => ignoreRules.some((rule) => rel === rule
      || rel.startsWith(rule.endsWith('/') ? rule : `${rule}/`));
    const out = [];
    const walk = (abs, rel) => {
      let names = [];
      try { names = filesystem.readdirSync(abs); } catch { return; }
      for (const name of names) {
        if (name === '.git' || name === 'node_modules') continue;
        const childAbs = path.join(abs, name);
        const childRel = rel ? `${rel}/${name}` : name;
        let stat = null;
        try { stat = filesystem.statSync(childAbs); } catch { continue; }
        if (stat.isDirectory()) { walk(childAbs, childRel); continue; }
        if (ignored(childRel)) continue;
        const committed = [...committedPaths].some((c) => childRel === c || childRel.startsWith(`${c}/`));
        if (!committed) out.push(childRel);
      }
    };
    walk(projectRoot, '');
    return out.sort();
  };
  const fakeGit = (argv) => {
    const readonly = argv[0] === '--no-optional-locks';
    const args = readonly ? argv.slice(1) : argv;
    const pathspec = () => args.slice(args.indexOf('--') + 1)[0];
    const headKnown = () => gitLog.length
      ? { status: 0, stdout: `${gitLog[gitLog.length - 1].hash}\n`, stderr: '' }
      : { status: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" };
    if (args[0] === 'init') {
      const bIdx = args.indexOf('-b');
      currentBranch = bIdx !== -1 ? String(args[bIdx + 1] || 'main') : 'main';
      return { status: 0, stdout: `Initialized empty Git repository in ${projectRoot}/.git\n`, stderr: '' };
    }
    if (args[0] === 'switch') {
      const target = String(args[args.length - 1] || '');
      if (args.includes('-c')) {
        // 已有提交：创建并切换（引用出生）；空仓库（HEAD 未出生）：等价把未出生分支改名
        if (gitLog.length) bornBranches.add(target);
      } else if (!bornBranches.has(target)) {
        return { status: 128, stdout: '', stderr: `fatal: invalid reference: ${target}\n` };
      }
      currentBranch = target;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'branch') {
      if (typeof args[1] === 'string' && args[1].startsWith('--format=')) {
        const names = [...bornBranches].sort();
        return { status: 0, stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
      }
      if (args[1] === '--show-current') {
        return { status: 0, stdout: `${currentBranch}\n`, stderr: '' };
      }
      const name = typeof args[1] === 'string' && !args[1].startsWith('-') ? args[1] : null;
      if (name) {
        const sha = String(args[2] || '');
        if (!gitLog.some((c) => c.hash.startsWith(sha))) {
          return { status: 128, stdout: '', stderr: `fatal: not a valid object name: ${sha || '(missing)'}\n` };
        }
        bornBranches.add(name);
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (args[0] === 'rev-parse') {
      if (args[1] === '--is-inside-work-tree') return { status: 0, stdout: 'true\n', stderr: '' };
      if (args[1] === '--show-toplevel') return { status: 0, stdout: `${projectRoot}\n`, stderr: '' };
      if (args[1] === 'HEAD') return headKnown();
      if (args[1] === '--verify') {
        // refs/heads/<分支>（可带 ^{commit} 后缀）：按分支出生语义解析（stdout 取沙盒最新提交哈希近似——消费方只判定状态码）
        const ref = String(args[2] || '').match(/^refs\/heads\/(.+?)(\^\{commit\})?$/);
        if (ref) {
          return bornBranches.has(ref[1]) && gitLog.length
            ? { status: 0, stdout: `${gitLog[gitLog.length - 1].hash}\n`, stderr: '' }
            : { status: 128, stdout: '', stderr: '' };
        }
        return headKnown();
      }
    }
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      // 线性历史祖先判定：提交下标 a <= b 即 a 是 b 的祖先；未知提交按非祖先（退出码 1）
      const idxOf = (ref) => gitLog.findIndex((c) => c.hash === String(ref).toLowerCase());
      const a = idxOf(String(args[2] || ''));
      const b = idxOf(String(args[3] || ''));
      return a !== -1 && b !== -1 && a <= b
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-list' && args.includes('--max-parents=0')) {
      // 线性历史：根提交即首条
      return gitLog.length
        ? { status: 0, stdout: `${gitLog[0].hash}\n`, stderr: '' }
        : { status: 128, stdout: '', stderr: "fatal: bad revision 'HEAD'\n" };
    }
    if (args[0] === 'log') {
      if (!gitLog.length) {
        return { status: 128, stdout: '', stderr: `fatal: your current branch '${currentBranch}' does not have any commits yet\n` };
      }
      // 位置起点 + --not 排除（product-release collectExtraCommits 口径）：
      // include = 起点可达（线性：下标 <= 起点），exclude = 各排除提交可达（下标 <= 排除点），
      // 差集即 排除点最浅者 < 下标 <= 起点；无位置起点时为全历史。
      let startIdx = gitLog.length - 1;
      let excludeBefore = -1;
      let excludeMode = false;
      let fmt = '--format=%H';
      for (const arg of args.slice(1)) {
        if (arg === '--not') { excludeMode = true; continue; }
        if (typeof arg === 'string' && arg.startsWith('--format=')) { fmt = arg; continue; }
        if (typeof arg === 'string' && arg.startsWith('--')) continue;
        const idx = gitLog.findIndex((c) => c.hash === String(arg).toLowerCase());
        if (idx === -1) {
          return { status: 128, stdout: '', stderr: `fatal: bad revision '${arg}'\n` };
        }
        if (excludeMode) excludeBefore = Math.max(excludeBefore, idx);
        else startIdx = Math.min(startIdx, idx);
      }
      const rows = [];
      for (let i = startIdx; i > excludeBefore; i--) {
        const c = gitLog[i];
        const line = fmt.slice('--format='.length)
          .replace('%H', c.hash).replace('%h', c.hash.slice(0, 7))
          .replace('%an', c.author).replace('%aI', c.at).replace('%cI', c.at)
          .replace('%s', c.subject)
          .split('%x09').join('\t');
        rows.push(line);
      }
      return { status: 0, stdout: rows.join('\n') + (rows.length ? '\n' : ''), stderr: '' };
    }
    if (args[0] === 'remote') {
      // 沙盒恒有唯一远端 origin（仅本地名字与 URL 事实，无任何网络交互）
      if (args[1] === 'get-url') {
        const name = String(args[2] || '');
        return name === 'origin'
          ? { status: 0, stdout: `https://git.mock.local${projectRoot}.git\n`, stderr: '' }
          : { status: 128, stdout: '', stderr: `error: No such remote '${name}'\n` };
      }
      return { status: 0, stdout: 'origin\n', stderr: '' };
    }
    if (args[0] === 'symbolic-ref' && args[1] === '--short' && args[2] === 'HEAD') {
      // HEAD 恒为指向当前分支的符号引用（未出生分支同样成立，与真实 git 一致）
      return { status: 0, stdout: `${currentBranch}\n`, stderr: '' };
    }
    if (args[0] === 'status' && args[1] === '--porcelain' && !args.includes('--')) {
      // 整树口径（无 pathspec，-uall 等修饰参数任意）：逐文件列出未提交路径
      const lines = listUncommittedFiles().map((rel) => `?? ${rel}`);
      return { status: 0, stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '' };
    }
    if (args[0] === 'status' && args[1] === '--porcelain' && args.includes('--')) {
      const target = pathspec();
      // 已入库路径已从工作区移除：模拟真实 git 的未暂存删除差异（删除即留痕链路依赖此判定）。
      if (committedPaths.has(target) && !filesystem.existsSync(path.join(projectRoot, target))) {
        return { status: 0, stdout: ` D ${target}\n`, stderr: '' };
      }
      return { status: 0, stdout: committedPaths.has(target) ? '' : `?? ${target}/\n`, stderr: '' };
    }
    if (args[0] === 'ls-files' && args.includes('--error-unmatch')) {
      // pathspec 可匹配性判定（commitPaths 容错重试用）：-- 之后的路径在已提交集合或磁盘上即匹配
      const p = pathspec();
      const matchable = [...committedPaths].some((c) => p === c || p.startsWith(`${c}/`))
        || filesystem.existsSync(path.join(projectRoot, p));
      return matchable
        ? { status: 0, stdout: `${p}\n`, stderr: '' }
        : { status: 128, stdout: '', stderr: `fatal: pathspec '${p}' did not match any files\n` };
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
      // 复用确定性随机序列生成提交号：结果稳定可断言，短号随提交次序变化；
      // 提交时间取 Mock 时钟（log %cI 可断言）；首提交使当前分支出生。
      const hash = cryptoMock.randomBytes(20).toString('hex');
      gitLog.push({ hash, subject, paths, at: new clock.Date().toISOString(), author: 'mock-user' });
      bornBranches.add(currentBranch);
      return { status: 0, stdout: '', stderr: '' };
    }
    return deny('git 序列外调用')(args.join(' '));
  };
  const childProcess = {
    // Mock 世界工具链：npm test 立即「跑完」（异步 emit 输出与退出码，默认 0，可经
    // setCommandExitCode 切换）；其余命令仍按未声明调用记账。
    spawn(command, args, options) {
      // git（绑定 projectRoot 的 cwd）：把沙盒 git 结果包装成异步子进程事件（realExec 等
      // 异步执行器消费 close/stdout/stderr）；npm test 立即「跑完」（异步 emit 输出与退出码，
      // 默认 0，可经 setCommandExitCode 切换）；其余命令仍按未声明调用记账。
      if (command === 'git' && options?.cwd === projectRoot) {
        const result = fakeGit(args);
        const child = new EventEmitter();
        child.pid = 4244;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => {
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('exit', result.status, null);
          child.emit('close', result.status, null);
        });
        return child;
      }
      if (command === 'npm' && args[0] === 'test') {
        const key = [command, ...args].join(' ');
        const exitCode = commandExitCodes.has(key) ? commandExitCodes.get(key) : 0;
        const child = new EventEmitter();
        child.pid = 4243;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => {
          try { child.stdout.emit('data', Buffer.from('mock npm test run\n')); } catch { /* 无监听者 */ }
          child.emit('exit', exitCode, null);
          child.emit('close', exitCode, null);
        });
        return child;
      }
      return deny('spawn')(command, args);
    },
    execFile: deny('execFile'),
    exec: deny('exec'), execSync: deny('execSync'), fork: deny('fork'),
    // Mock 世界 PATH 中无可执行文件：which 探测一律「未找到」（execFileSync 非零退出即抛错，
    // 与真实 Node 行为一致）；其余命令仍按未声明调用记账。
    execFileSync(command) {
      if (command === 'which') {
        throw Object.assign(new Error("execFileSync 'which' exited with 1"), { status: 1 });
      }
      return deny('execFileSync')(command, Array.from(arguments).slice(1));
    },
    spawnSync(command, args, options) {
      if (command === 'git' && options?.cwd === projectRoot) return fakeGit(args);
      // Mock 世界自带固定版本的工具链（只读版本查询，无副作用）；其余命令仍按未声明调用记账。
      if (command === 'node' && args[0] === '-v') return { status: 0, stdout: 'v22.0.0\n', stderr: '' };
      if (command === 'npm' && args[0] === '-v') return { status: 0, stdout: '10.0.0\n', stderr: '' };
      if (command === 'npm' && args[0] === 'test') {
        const key = [command, ...args].join(' ');
        const exitCode = commandExitCodes.has(key) ? commandExitCodes.get(key) : 0;
        return { status: exitCode, stdout: 'mock npm test run\n', stderr: '' };
      }
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
  // localStorage / sessionStorage 替身：前端代码的两条键值存储通道（内存实现，随环境销毁，
  // 不跨环境共享；两通道为独立实例互不串扰——对应浏览器两个独立存储区）。注入 VM 全局供
  // action 直连读写；返回面暴露只读视图（getItem / key / length）供用例断言——写通道仅
  // 被测业务自身，与 fs / git 观测面同一口径。
  const { mock: localStorageMock, view: localStorageView } = createStorageMock();
  const { mock: sessionStorageMock, view: sessionStorageView } = createStorageMock();
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
    // fetch 替身：前端代码（action 层）的全局通道——同源相对路径直达内存传输层（同 VM 的
    // 服务端路由）；跨源 / 绝对地址按未声明调用记账。
    fetch: transport.fetch,
    localStorage: localStorageMock,
    sessionStorage: sessionStorageMock,
  });
  // 浏览器同构：window 即全局——前端代码（View 与 View–Action 模块）经 window.* 直连通道
  // （window.ATBActions / window.ATBOncall 等）访问挂载面；自引用使其在 VM 内成立。
  context.window = context;
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
    // 附加源码入口（如前端 action 模块）：与主入口同一加载边界与依赖图，加载后把模块
    // 命名空间经返回面 exports 交给用例——测试直接调用 VM 内的真实源码导出。
    const exports = {};
    for (const item of sideEntries || []) {
      const module = await loadModule(pathToFileURL(item.file).href);
      await module.link((specifier, parent) => loadModule(specifier.startsWith('node:')
        ? specifier : new URL(specifier, parent.identifier).href));
      await module.evaluate();
      exports[item.key] = module.namespace;
    }
    await transport.waitForListening();
    sideEntriesFace = Object.freeze(exports);
  } catch (error) {
    try { await dispose(); } catch { /* 启动已失败：保留原始错误，收口问题不掩盖 */ }
    throw error;
  }
  return {
    now, dispose,
    // 附加入口的模块命名空间（sideEntries 未传时为空对象）
    exports: sideEntriesFace,
    // 命令退出码开关（环境级，无业务语义）：key 为完整 argv 空格拼接（如 'npm test --silent'），
    // 未设置的命令缺省退出 0；传 null/undefined 删除恢复缺省。
    setCommandExitCode: (key, code) => {
      if (code == null) commandExitCodes.delete(String(key));
      else commandExitCodes.set(String(key), code);
    },
    // 通用观测面：未声明调用记账、服务日志，以及只读的 fs / git 查询对象与 http 入口
    // （request 动作 + requests 流水账）。
    unexpected, logs,
    fs: createFsView(filesystem),
    git: createGitView(gitLog, committedPaths),
    http: Object.freeze({ request: transport.request, requests: transport.requests }),
    // localStorage / sessionStorage 只读视图：断言被测业务的键值记忆写入（写通道仅被测业务自身）
    localStorage: localStorageView,
    sessionStorage: sessionStorageView,
  };
}
