// lite-cmd-eslint 套件共享装配（plain module，非 test 文件）：主测试文件与 native-reference
// 对照用例双侧共用的 mock 装配、真实源码夹具暂存与 spawn 门路。f_moduleSources 记录 write()
// 写入的 .mjs 夹具原文，setup() 收尾统一清理；状态为模块级单例，同进程内经同一 specifier
// 导入共享同一份（f_ 前缀仅限本文件内部状态）。
import nativeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteChildProcess from '../lite-child_process.mjs';
import { t_install } from '../lite-cmd-eslint.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';

// 逐用例装配：mock 内存卷 + spawn 边界（eslint 执行唯一入口——执行寻址须卷内 /mock-cmd
// 系统卷）；t_install 在卷建立后调用——/mock-cmd 系统卷已持久存在时即刻补命令文件，
// 不依赖「卷内无 /mock-cmd 才触发」的惰性安装时序。收尾卸载子进程运行态并摘除钩子。
// 卷排除本仓库根（真实文件不落卷）
export const REAL_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
// 临时夹具目录由环境变量提供，未设置时使用平台默认位置，不依赖 node:os。
export const TEMP_ROOT = path.resolve(process.env.TMPDIR || process.env.TEMP || process.env.TMP
  || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp') : '/tmp'));
let f_sourceRoot;
const f_moduleSources = new Map();

// 只读访问器：暂存根路径供断言消费（f_sourceRoot 本身保持文件私有，setup 逐用例重写）
export const sourceRoot = () => f_sourceRoot;

export function setup() {
  f_moduleSources.clear();
  f_sourceRoot = nativeFs.mkdtempSync(path.join(REAL_ROOT, 'scripts/tests/.native-eslint-'));
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  t_install();
  liteChildProcess.t_mock();
  mgr.command('eslint').t_onRun(null);
  return () => {
    mgr.command('eslint').t_onRun(null);
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
    nativeFs.rmSync(f_sourceRoot, { recursive: true, force: true });
    f_moduleSources.clear();
  };
}

// 准备：将本用例声明的模块原文写成真实源码夹具；不转换源码，命令只接收真实 --config。
export function prepareEslintConfig(argv, cwd) {
  let args = [...argv], config;
  const at = args.indexOf('--config');
  if (at >= 0 && args[at + 1] !== undefined) config = path.resolve(cwd, args[at + 1]);
  else {
    let current = cwd;
    while (current !== path.dirname(current)) {
      const file = path.join(current, 'eslint.config.mjs');
      if (f_moduleSources.has(file)) { config = file; break; }
      current = path.dirname(current);
    }
  }
  if (!config || liteFs.t_isPassthrough(config) || !f_moduleSources.has(config)) return args;
  const runRoot = nativeFs.mkdtempSync(path.join(f_sourceRoot, 'run-'));
  for (const [file, text] of f_moduleSources) {
    const destination = path.join(runRoot, file.slice(path.parse(file).root.length));
    nativeFs.mkdirSync(path.dirname(destination), { recursive: true });
    nativeFs.writeFileSync(destination, text);
  }
  const actual = path.join(runRoot, config.slice(path.parse(config).root.length));
  if (at >= 0) args[at + 1] = actual; else args.push('--config', actual);
  return args;
}

// 操作与观测：执行公开异步命令，只返回真实输出与退出结果，不包装断言。
export async function spawnEslint(argv, options = {}) {
  const args = prepareEslintConfig(argv, options.cwd || '/mock/project');
  const child = liteChildProcess.spawn('eslint', args, options);
  let stdout = '', stderr = '', error;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', value => { error = value; });
  const closed = await liteChildProcess.waitForClose(child);
  return { status: closed.code, signal: closed.signal, stdout, stderr, error };
}

export const write = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  liteFs.mkdirSync(path.dirname(file), { recursive: true });
  liteFs.writeFileSync(file, text);
  if (file.endsWith('.mjs')) f_moduleSources.set(file, text);
};

// 原生 ESLint CLI 对照夹具：宿主 devDependencies 的真实 eslint 可执行文件（flat config 同构夹具）
export const ESLINT_BIN = path.join(REAL_ROOT, 'node_modules', '.bin', 'eslint');
