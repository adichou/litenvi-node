// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-node：Node/npm 命令定义，执行入口统一经 lite-child_process。
// 退出意图类型来自无依赖的 lite-process-exit-error，不经命令注册表引用。
// 脚本经普通 import 在宿主内执行，不启动真实子进程，也不使用 VM 模块加载器。
// AsyncLocalStorage 将 process、console、定时器及服务调用路由到当前虚拟命令；
// 不包装原生 fs：自研脚本显式使用 lite-fs 访问内存卷，原生 fs 的方法与 ESM 导出保持不变。
// spawn 输入运行期暂存为 fd 0（lite-fs 管道型记录），脚本内 liteFs.readFileSync(0) 同步可读。
// 入口 URL 带运行序号以重新执行入口，依赖保持原生 import 缓存与共享全局语义。
// 文件存在性检查显式经 lite-fs；真实源码必须由调用方列入 exclude，运行数据继续留内存。
// --test 使用独立 Worker 中的原生 node:test（isolation:none），支持显式文件、名称筛选、
// --experimental-test-coverage 及覆盖率范围旗标 --test-coverage-include / --test-coverage-
// exclude（等号与空格取值均可、可重复，以真实路径锚定的 glob 经 run() 的 coverageInclude/
// ExcludeGlobs 透传，语义与原生命令一致），输出真实 TAP/V8 覆盖率；每次独立缓存，不启动 OS 子进程。
// Worker 启动逻辑内置于本文件，以完整私有函数启动，不依赖额外的 Worker 入口文件。
// 测试 Worker 不共享父进程的 lite 单例状态，测试文件需自行装配其环境；未支持的测试选项明确失败。
// npm -v/--version 固定返回 10.9.0；--versions[ --json] 使用本次采集的工具链快照，不探测宿主。
// npm run <script> [-- args]：自 cwd 逐级向上读最近 package.json 的 scripts[name]，经 shell-quote
// 解析为单命令 argv 后经内存分派执行（操作符/管道/重定向等 shell 语法明确报错，不回退真实
// shell）；banner（> name@version script 与命令行）记 stdout，嵌套命令的 stdout/stderr 与退出
// 码透传，未登记命令报 127；-- 之后的参数原样追加到脚本 argv。同步面要求嵌套命令提供同步
// 实现，仅异步的命令（如 node 脚本）报 127。不实现 pre/post 生命周期钩子、npm test/start 等
// 别名、node_modules/.bin PATH 前缀与 npm_* 环境变量——这些面明确报错，防止静默偏差。
import path from 'node:path';
import liteFs from './lite-fs.mjs';
import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import timers from 'node:timers';
import childProcess from 'node:child_process';
import { parse as f_shellParse } from 'shell-quote';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { i_stageStdin, i_releaseStdin } from './lite-fs.mjs';
import liteServer from './lite-server.mjs';
import liteChildProcess from './lite-child_process.mjs';
import mgr from './lite-cmd-mgr.mjs';
import { ProcessExitError } from './lite-process-exit-error.mjs';
import { promisify, inspect } from 'node:util';

// 私有：node 命令注册路径——登记表键与安装幂等判定用；进程门面的 execPath 视图经 mgr
// 通用寻址取命令条目的 execPath 接口，不再依赖本常量导出。
const f_NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';
const f_execution = new AsyncLocalStorage();
const f_hostTimers = { ...timers };
// 私有方法：仅在本文件实现中使用，不导出。
const f_currentRuntime = () => { const runtime = f_execution.getStore(); return runtime?.finished ? undefined : runtime; };

const f_hostProcess = process;
const f_active = new Set();
let f_restoreBoundaries, f_sequence = 0;

// 替换只在有脚本运行时保留；宿主调用以及其他异步上下文始终走原来的实现。
// 私有方法：仅在本文件实现中使用，不导出。
function f_installBoundaries() {
    const originals = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_replace = (owner, key, descriptor, original = Object.getOwnPropertyDescriptor(owner, key)) => {
        originals.push([owner, key, original]);
        Object.defineProperty(owner, key, { configurable: true, enumerable: original?.enumerable ?? true, ...descriptor });
        return original;
    };
    for (const key of ['argv', 'env', 'execPath', 'execArgv', 'pid', 'stdin', 'stdout', 'stderr', 'cwd', 'exit', 'kill']) {
        const original = Object.getOwnPropertyDescriptor(f_hostProcess, key);
        f_replace(f_hostProcess, key, {
            // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
            get() {
                const runtime = f_currentRuntime();
                return runtime ? runtime.proc[key] : original.get ? original.get.call(f_hostProcess) : original.value;
            },
            // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
            set(value) {
                const runtime = f_currentRuntime();
                if (runtime) runtime.proc[key] = value;
                else if (original.set) original.set.call(f_hostProcess, value);
                else original.value = value;
            },
        }, original);
    }
    // exitCode 在 Node 上不可重新定义；全局 process 通过代理提供当前命令的视图。
    const processFace = new Proxy(f_hostProcess, {
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        get(target, key) {
            const runtime = f_currentRuntime();
            return runtime && key in runtime.proc ? runtime.proc[key] : Reflect.get(target, key);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        set(target, key, value) {
            const runtime = f_currentRuntime();
            if (runtime && key in runtime.proc) { runtime.proc[key] = value; return true; }
            return Reflect.set(target, key, value);
        },
    });
    f_replace(globalThis, 'process', { get: () => f_currentRuntime() ? processFace : f_hostProcess });
    for (const key of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'trace', 'assert']) {
        const original = console[key];
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_replace(console, key, { writable: true, value: function (...args) {
            const runtime = f_currentRuntime();
            return runtime ? runtime.console[key](...args) : original.apply(this, args);
        } });
    }
    for (const key of ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate']) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_dispatch = (...args) => {
            const runtime = f_currentRuntime();
            return (runtime ? runtime.timers[key] : f_hostTimers[key])(...args);
        };
        f_replace(globalThis, key, { writable: true, value: f_dispatch });
        f_replace(timers, key, { writable: true, value: f_dispatch });
    }
    for (const owner of [http, https, net, tls, liteServer]) {
        const original = owner.createServer;
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_replace(owner, 'createServer', { writable: true, value: function (...args) {
            const runtime = f_currentRuntime();
            const server = original.apply(this, args);
            return runtime ? runtime.f_trackServer(server) : server;
        } });
    }
    // 显式方法映射：lite 门面侧逐个点访问列出（本项目对象禁变量键——前缀盲区检查），
    // node: 原生侧同名读取保留循环（node: 内建豁免动态键检查）。
    const f_liteMethods = {
        spawn: liteChildProcess.spawn,
        spawnSync: liteChildProcess.spawnSync,
        exec: liteChildProcess.exec,
        execSync: liteChildProcess.execSync,
        execFile: liteChildProcess.execFile,
        execFileSync: liteChildProcess.execFileSync,
        fork: liteChildProcess.fork,
    };
    for (const [key, liteMethod] of Object.entries(f_liteMethods)) {
        const original = childProcess[key];
        const f_dispatch = function (...args) {
            const runtime = f_currentRuntime();
            if (!runtime) return original.apply(this, args);
            if (key === 'fork') throw new Error(`lite-cmd-node：子进程接口 ${key} 未实现内存语义`);
            const result = liteMethod(...args);
            return ['spawn', 'exec', 'execFile'].includes(key) ? runtime.f_trackChild(result) : result;
        };
        if (key === 'exec' || key === 'execFile') {
            Object.defineProperty(f_dispatch, promisify.custom, { value: (...args) => {
                const runtime = f_currentRuntime();
                const method = runtime ? liteMethod : original;
                const promise = method[promisify.custom](...args);
                if (runtime) runtime.f_trackChild(promise.child);
                return promise;
            } });
        }
        f_replace(childProcess, key, { writable: true, value: f_dispatch });
    }
    syncBuiltinESMExports();
    return () => {
        for (const [owner, key, original] of originals.reverse()) Object.defineProperty(owner, key, original);
        syncBuiltinESMExports();
    };
}

// 私有方法：仅在本文件实现中使用，不导出。
const f_invocation = (argv, ctx) => {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-v' || arg === '--version') return { kind: 'version' };
        if (arg === '--test') return f_testInvocation(argv, ctx);
        if (['-e', '--eval', '-p', '--print'].includes(arg))
            return { kind: 'eval', code: argv[i + 1] ?? '', print: arg === '-p' || arg === '--print', args: argv.slice(i + 2) };
        if (arg === '--') {
            const file = argv[++i];
            return file ? { kind: 'file', file: path.resolve(ctx.cwd(), file), args: argv.slice(i + 1) } : { kind: 'stdin', args: [] };
        }
        if (arg.startsWith('-')) continue;
        return { kind: 'file', file: path.resolve(ctx.cwd(), arg), args: argv.slice(i + 1) };
    }
    return { kind: 'stdin', args: [] };
};

// 私有：解析已支持的测试运行参数；未知选项明确报错，不退回普通脚本执行。
// 覆盖率范围旗标（--test-coverage-include/--test-coverage-exclude）只入运行器选项、不入
// execArgv——它们是 node:test 的报告过滤项，不是 Node 进程选项（与原生命令的归类一致）。
const f_testInvocation = (argv, ctx) => {
    const files = [], execArgv = [], coverageInclude = [], coverageExclude = [];
    let coverage = false, literal = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!literal && arg === '--') { literal = true; continue; }
        if (!literal && arg === '--test') continue;
        if (!literal && arg === '--experimental-test-coverage') {
            coverage = true;
            execArgv.push(arg);
        } else if (!literal && arg === '--test-name-pattern') {
            if (argv[i + 1] === undefined) throw new Error('lite-cmd-node：--test-name-pattern 缺少表达式');
            execArgv.push(`--test-name-pattern=${argv[++i]}`);
        } else if (!literal && arg.startsWith('--test-name-pattern=')) {
            execArgv.push(arg);
        } else if (!literal && arg.startsWith('--test-coverage-include=')) {
            coverageInclude.push(arg.slice('--test-coverage-include='.length));
        } else if (!literal && arg === '--test-coverage-include') {
            if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('lite-cmd-node：--test-coverage-include 缺少 glob');
            coverageInclude.push(argv[++i]);
        } else if (!literal && arg.startsWith('--test-coverage-exclude=')) {
            coverageExclude.push(arg.slice('--test-coverage-exclude='.length));
        } else if (!literal && arg === '--test-coverage-exclude') {
            if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('lite-cmd-node：--test-coverage-exclude 缺少 glob');
            coverageExclude.push(argv[++i]);
        } else if (!literal && arg.startsWith('-')) {
            throw new Error(`lite-cmd-node：测试运行参数未实现：${arg}`);
        } else files.push(path.resolve(ctx.cwd(), arg));
    }
    if (!files.length) throw new Error('lite-cmd-node：--test 需要显式指定测试文件');
    return { kind: 'test', files, execArgv, coverage, coverageInclude, coverageExclude };
};

// 私有：完整函数作为 Worker 入口，依赖只在独立上下文内加载，不修改宿主测试注册表。
async function f_runTestWorker() {
    const { workerData } = await import('node:worker_threads');
    const { run } = await import('node:test');
    const { tap } = await import('node:test/reporters');
    process.argv = [workerData.execPath, ...workerData.files];
    // 私有：仅调整独立 Worker 的 cwd 视图，宿主工作目录保持不变。
    process.cwd = function f_currentDirectory() { return workerData.cwd; };
    // 私有：覆盖率范围旗标经 run() 的 coverageInclude/ExcludeGlobs 透传（与原生命令同语义：
    // 显式 include 会覆盖 node_modules 默认排除，调用方需自行补依赖 exclude）。
    const stream = run({
        files: workerData.files,
        isolation: 'none',
        coverage: workerData.coverage,
        coverageIncludeGlobs: workerData.coverageInclude,
        coverageExcludeGlobs: workerData.coverageExclude,
    });
    // 私有：程序化 run 不自动把失败映射成退出码，显式保留测试失败与取消结果。
    stream.on('test:fail', function f_failed() { process.exitCode = 1; });
    stream.compose(tap).pipe(process.stdout);
}

// 私有：Worker 隔离原生 node:test 注册表与模块缓存，不启动 OS 子进程，不回放测试结果。
function f_runTests(plan, ctx, child) {
    let finished = false, worker;
    const f_finish = code => {
        if (finished) return;
        finished = true;
        child.emit('exit', code, null);
        child.emit('close', code, null);
    };
    const f_fail = error => { child.stderr.write(`${error.stack || error}\n`); f_finish(1); };
    try {
        for (const file of plan.files) {
            if (!liteFs.existsSync(file)) throw new Error(`Cannot find module '${file}'`);
        }
        const env = { ...(ctx.options.env ?? ctx.env) };
        // IDE 预加载和宿主测试标记不属于虚拟命令，不能污染隔离的测试运行器。
        for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'VSCODE_INSPECTOR_OPTIONS']) delete env[key];
        const source = `(${f_runTestWorker.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`;
        worker = new Worker(source, {
            eval: true,
            workerData: {
                files: plan.files,
                cwd: ctx.cwd(),
                execPath: ctx.execPath,
                coverage: plan.coverage,
                coverageInclude: plan.coverageInclude,
                coverageExclude: plan.coverageExclude,
            },
            execArgv: plan.execArgv, env, stdout: true, stderr: true,
        });
        worker.stdout.on('data', chunk => { if (!finished) child.stdout.write(chunk); });
        worker.stderr.on('data', chunk => { if (!finished) child.stderr.write(chunk); });
        worker.once('error', f_fail);
        worker.once('exit', f_finish);
        const f_dispose = () => { finished = true; void worker.terminate(); };
        child.once('exit', f_dispose);
        ctx.onDispose?.(f_dispose);
    } catch (error) { f_fail(error); }
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_runNode(plan, ctx, child) {
    const pending = new Set(), servers = new Set(), children = new Set();
    const cwd = ctx.cwd();
    const inheritedExitCode = f_hostProcess.exitCode;
    const runtime = { finished: false };
    // spawn 输入暂存为 fd 0：脚本内 liteFs.readFileSync(0) 同步读到 options.input 快照
    //（异步 spawn 经 ctx.options.input、同步命令经 ctx.input；流式 stdin 语义仍由
    // child.stdin 承担，暂存不消费流）。
    i_stageStdin(ctx.input ?? ctx.options?.input);
    let mainDone = false, importing = false, check;
    const stdout = child.stdout, stderr = child.stderr;
    const console = new Console({ stdout, stderr, colorMode: false });
    const proc = Object.assign(new EventEmitter(), {
        argv: [ctx.execPath, ...(plan.kind === 'file' ? [plan.file] : []), ...plan.args],
        env: { ...(ctx.options.env ?? ctx.env) }, execPath: ctx.execPath, execArgv: [],
        pid: child.pid, platform: f_hostProcess.platform, version: f_hostProcess.version, versions: f_hostProcess.versions,
        stdin: child.stdin, stdout, stderr, cwd: () => cwd, exitCode: undefined,
        kill(pid, signal = 'SIGTERM') {
            if (liteChildProcess.i_signal(pid, signal)) return true;
            const error = new Error('kill ESRCH');
            error.code = 'ESRCH';
            error.syscall = 'kill';
            throw error;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        exit(code = proc.exitCode ?? 0) { ctx.recordExit(code); throw new ProcessExitError(Number(code) & 255); },
    });
    // 细化 mgr 当前执行环境的 argv 视图（通用接口）：分派层默认视图含全部原始参数，node
    // 的参数文法剔除脚本前 CLI 旗标——脚本内 liteProcess.argv 与虚拟 process.argv 同源一致。
    mgr.i_setCurrentArgv(proc.argv);
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_release = () => {
        if (!runtime.finished || importing) return;
        f_active.delete(runtime);
        if (!f_active.size && f_restoreBoundaries) {
            f_execution.exit(f_restoreBoundaries);
            f_restoreBoundaries = undefined;
        }
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_dispose = () => {
        runtime.finished = true;
        i_releaseStdin(); // 释放 fd 0 暂存，防跨运行残留串读
        f_hostTimers.clearImmediate(check);
        for (const handle of pending) { f_hostTimers.clearTimeout(handle); f_hostTimers.clearImmediate(handle); }
        pending.clear();
        for (const server of servers) {
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            server.close();
        }
        servers.clear();
        // node:process 的 exitCode 不可代理重定义，按共享进程语义读取并在结束时恢复。
        f_hostProcess.exitCode = inheritedExitCode;
        f_release();
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_finish = code => {
        if (runtime.finished) return;
        f_dispose();
        f_execution.exit(() => {
            child.emit('exit', Number(code) & 255, null);
            child.emit('close', Number(code) & 255, null);
        });
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_fail = error => {
        if (runtime.finished) return;
        if (error instanceof ProcessExitError) f_finish(error.exitCode);
        else { stderr.write(`${error.stack || error}\n`); f_finish(1); }
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_checkIdle = () => {
        f_hostTimers.clearImmediate(check);
        check = f_hostTimers.setImmediate(() => {
            if (mainDone && !runtime.finished && !servers.size && !children.size && ![...pending].some(handle => handle.hasRef()))
                f_finish(proc.exitCode ?? (f_hostProcess.exitCode !== inheritedExitCode ? f_hostProcess.exitCode : 0));
        });
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_schedule = (kind, callback, delay, args) => {
        if (runtime.finished) throw new ProcessExitError(0);
        let handle;
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_invoke = () => {
            if (kind !== 'interval') pending.delete(handle);
            if (runtime.finished) return;
            try { callback(...args); } catch (error) { f_fail(error); }
            f_checkIdle();
        };
        handle = kind === 'immediate' ? f_hostTimers.setImmediate(f_invoke)
            : kind === 'interval' ? f_hostTimers.setInterval(f_invoke, delay) : f_hostTimers.setTimeout(f_invoke, delay);
        pending.add(handle);
        const unref = handle.unref.bind(handle);
        handle.unref = () => { unref(); f_checkIdle(); return handle; };
        return handle;
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_clear = handle => { f_hostTimers.clearTimeout(handle); f_hostTimers.clearImmediate(handle); pending.delete(handle); f_checkIdle(); };
    const timerFace = {
        setTimeout: (callback, delay, ...args) => f_schedule('timeout', callback, delay, args),
        setInterval: (callback, delay, ...args) => f_schedule('interval', callback, delay, args),
        setImmediate: (callback, ...args) => f_schedule('immediate', callback, 0, args),
        clearTimeout: f_clear, clearInterval: f_clear, clearImmediate: f_clear,
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_trackServer = server => {
        server.once('close', () => { servers.delete(server); f_checkIdle(); });
        const proxy = new Proxy(server, { get(target, key) {
            const value = target[key];
            if (typeof value !== 'function') return value;
            return (...args) => {
                if (key === 'listen') servers.add(server);
                if (key === 'close') {
                    const callback = args[0];
                    args[0] = (...result) => {
                        if (runtime.finished) return;
                        servers.delete(server);
                        try { callback?.(...result); } catch (error) { f_fail(error); }
                        f_checkIdle();
                    };
                }
                const result = value.apply(target, args);
                return result === target ? proxy : result;
            };
        } });
        return proxy;
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_trackChild = child => {
        children.add(child);
        child.once('close', () => { children.delete(child); f_checkIdle(); });
        return child;
    };
    Object.assign(runtime, { proc, console, timers: timerFace, f_trackServer, f_trackChild });
    f_active.add(runtime);
    if (!f_restoreBoundaries) f_restoreBoundaries = f_execution.exit(f_installBoundaries);
    child.once('exit', f_dispose);
    ctx.onDispose?.(f_dispose);
    ctx.onSignal?.(signal => {
        if (!proc.listenerCount(signal)) return false;
        f_execution.run(runtime, () => { try { proc.emit(signal, signal); } catch (error) { f_fail(error); } });
        return true;
    });
    const require = createRequire(pathToFileURL(plan.file || path.join(cwd, '[eval].js')));
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_evaluate = code => {
        const module = { exports: {} };
        const value = new Function('require', 'module', 'exports', '__filename', '__dirname', 'source', 'return eval(source)')
            (require, module, module.exports, '[eval]', cwd, code);
        if (plan.print) console.log(value);
        mainDone = true;
        f_checkIdle();
    };
    f_execution.run(runtime, () => {
        if (plan.kind === 'file') {
            const url = pathToFileURL(plan.file);
            url.searchParams.set('litenviRun', String(++f_sequence));
            importing = true;
            const imported = liteFs.existsSync(plan.file) ? import(url.href)
                : Promise.reject(Object.assign(new Error(`Cannot find module '${plan.file}'`), { code: 'MODULE_NOT_FOUND' }));
            imported.then(() => { mainDone = true; f_checkIdle(); }).catch(f_fail).finally(() => {
                importing = false;
                f_release();
            });
        } else if (plan.kind === 'eval') {
            try { f_evaluate(plan.code); } catch (error) { f_fail(error); }
        } else if (child.stdin) {
            let code = '';
            child.stdin.on('data', chunk => { code += chunk; });
            child.stdin.once('end', () => f_execution.run(runtime, () => { try { f_evaluate(code); } catch (error) { f_fail(error); } }));
        } else {
            try { f_evaluate(''); } catch (error) { f_fail(error); }
        }
    });
}

const f_nodeImpl = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    i_run(argv, ctx, child) {
        const plan = f_invocation(argv, ctx);
        if (plan.kind === 'version') {
            child.stdout.write(`${process.version}\n`);
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        } else if (plan.kind === 'test') f_runTests(plan, ctx, child);
        else f_runNode(plan, ctx, child);
    },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    i_runSync: (argv, ctx) => {
        if (f_invocation(argv, ctx).kind === 'version') return { status: 0, stdout: `${process.version}\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: 'lite-cmd-node：node 入口的同步执行未实现（import 是异步的），请改用 spawn\n' };
    },
};

// 私有：模拟 npm 的固定版本，不读取宿主 PATH 或安装元数据。
const f_npmVersion = '10.9.0';
// 私有：2026-11-09 采集的本机工具链信息，只用于模拟 npm --versions，不再探测宿主。
const f_npmVersions = Object.freeze({
    npm: f_npmVersion, node: '22.12.0', acorn: '8.14.0', ada: '2.9.2', amaro: '0.2.0',
    ares: '1.34.3', brotli: '1.1.0', cjs_module_lexer: '1.4.1', cldr: '46.0', icu: '76.1',
    llhttp: '9.2.1', modules: '127', napi: '9', nbytes: '0.1.1', ncrypto: '0.0.1',
    nghttp2: '1.64.0', nghttp3: '0.7.0', ngtcp2: '1.3.0', openssl: '3.0.15+quic',
    simdjson: '3.10.0', simdutf: '5.6.1', sqlite: '3.47.0', tz: '2024b', undici: '6.21.0',
    unicode: '16.0', uv: '1.49.1', uvwasi: '0.0.21', v8: '12.4.254.21-node.21', zlib: '1.3.0.1-motley-71660e1',
});


// npm 版本固定为 10.9.0，mock 时不启动真实进程。导入本模块不登记命令（mgr 不自动加载
// 命令集）——测试须显式调用 t_install() 安装（与 lite-cmd-git 同口径）。
// 内部导出：命令登记表，t_install() 整体安装；测试通过 child_process 的公共入口验证。
export const i_COMMANDS = {
    [f_NODE_COMMAND_PATH]: f_nodeImpl,
    '/mock-cmd/usr/local/bin/npm': {
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        i_run(argv, ctx, child) {
            if (argv[0] !== 'run') {
                const result = f_npmSyncResult(argv, ctx);
                if (result.stdout) child.stdout.write(result.stdout);
                if (result.stderr) child.stderr.write(result.stderr);
                child.emit('exit', result.status ?? 0, null);
                child.emit('close', result.status ?? 0, null);
                return;
            }
            const plan = f_npmRunPlan(argv.slice(1), ctx);
            if (plan.error) {
                child.stderr.write(plan.error);
                child.emit('exit', plan.exit, null);
                child.emit('close', plan.exit, null);
                return;
            }
            child.stdout.write(f_npmBanner(plan));
            const nested = liteChildProcess.spawn(plan.tokens[0], plan.tokens.slice(1), {
                cwd: ctx.cwd(), env: { ...(ctx.options?.env ?? ctx.env) },
            });
            // 私有：嵌套命令的退出即 npm 的退出；信号转发给嵌套命令并由其结算
            const f_settle = (code, signal) => {
                child.emit('exit', code, signal);
                child.emit('close', code, signal);
            };
            nested.stdout?.on('data', chunk => { child.stdout.write(chunk); });
            nested.stderr?.on('data', chunk => { child.stderr.write(chunk); });
            nested.once('error', () => {
                child.stderr.write(`npm error 脚本命令未在内存命令集登记：${plan.tokens[0]}\n`);
                f_settle(127, null);
            });
            nested.once('close', (code, signal) => f_settle(code, signal));
            ctx.onSignal?.(signal => { nested.kill(signal); return true; });
            ctx.onDispose?.(() => { nested.kill('SIGKILL'); });
        },
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        i_runSync(argv, ctx) { return f_npmSyncResult(argv, ctx); },
    },
};

// 测试专用：返回命令登记表本体，供包自引用单例检查比对模块身份——命令集无门面对象，
// 以本函数身份验证 specifier 与相对导入同源；生产代码禁止使用。
export function t_commands() {
    return i_COMMANDS;
}

// 测试专用：显式安装 node/npm 系统命令；重复调用保留已有钩子与故障配置（与 lite-cmd-git
// 同口径）。导入本模块不登记——需要 node/npm 命令的世界装配方（测试）显式调用。
export function t_install() {
    if (mgr.command(f_NODE_COMMAND_PATH)) return;
    for (const [cmdPath, impl] of Object.entries(i_COMMANDS))
        mgr.i_defineCommand(cmdPath, impl);
}

// 私有：npm 非异步面统一结果——版本探测、别名未实现与未实现参数的明确报错。
const f_npmSyncResult = (argv, ctx) => {
    if (argv[0] === '-v' || argv[0] === '--version') return { status: 0, stdout: `${f_npmVersion}\n`, stderr: '' };
    if (argv.includes('--versions') && argv.every(arg => ['--versions', '--json'].includes(arg))) {
        const output = argv.includes('--json') ? JSON.stringify(f_npmVersions, null, 2) : inspect(f_npmVersions);
        return { status: 0, stdout: `${output}\n`, stderr: '' };
    }
    if (argv[0] === 'run') {
        const plan = f_npmRunPlan(argv.slice(1), ctx);
        if (plan.error) return { status: plan.exit, stdout: '', stderr: plan.error };
        const nested = liteChildProcess.spawnSync(plan.tokens[0], plan.tokens.slice(1), {
            cwd: ctx.cwd(), env: { ...(ctx.options?.env ?? ctx.env) }, encoding: 'utf8',
        });
        if (nested.error) {
            // 命令未登记与命令仅有异步实现（如 node 脚本）在同步面同为无法执行，合并如实说明
            return {
                status: 127, stdout: f_npmBanner(plan),
                stderr: `npm error 脚本命令无法同步执行（未登记或仅支持异步）：${plan.tokens[0]}\n`,
            };
        }
        return { status: nested.status, stdout: f_npmBanner(plan) + (nested.stdout ?? ''), stderr: nested.stderr ?? '' };
    }
    if (['test', 'start', 'stop', 'restart'].includes(argv[0]))
        return { status: 1, stdout: '', stderr: 'lite-cmd-node：npm test/start 等别名未实现（pre/post 生命周期钩子未实现，请用 npm run <script>）\n' };
    return { status: 1, stdout: '', stderr: 'lite-cmd-node：npm 该参数未实现内存语义\n' };
};

// 私有：自 cwd 逐级向上找最近的 package.json；找不到返回 null（不落真实磁盘回退）。
function f_findPackageJson(cwd) {
    let dir = cwd;
    for (;;) {
        const file = path.join(dir, 'package.json');
        if (liteFs.existsSync(file)) return file;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// 私有：解析 npm run 计划；失败返回 { error, exit }，成功返回 { script, name, version, tokens, commandLine }。
const f_npmRunPlan = (argv, ctx) => {
    const name = argv[0];
    if (!name) return { error: 'lite-cmd-node：npm run 需要 <script> 名（无参列出脚本未实现）\n', exit: 1 };
    const divider = argv.indexOf('--');
    const extra = divider === -1 ? [] : argv.slice(divider + 1);
    const packageFile = f_findPackageJson(ctx.cwd());
    if (!packageFile) return { error: `lite-cmd-node：npm run 未找到 package.json（自 ${ctx.cwd()} 逐级向上）\n`, exit: 1 };
    let manifest;
    try {
        manifest = JSON.parse(liteFs.readFileSync(packageFile, 'utf8'));
    } catch (error) {
        return { error: `lite-cmd-node：package.json 解析失败：${error.message}\n`, exit: 1 };
    }
    const script = manifest.scripts?.[name];
    if (typeof script !== 'string' || !script.trim())
        return { error: `npm error Missing script: "${name}"\n`, exit: 1 };
    let tokens;
    try {
        tokens = f_shellParse(script);
    } catch (error) {
        return { error: `lite-cmd-node：脚本解析失败：${error.message}\n`, exit: 1 };
    }
    if (!tokens.length || tokens.some(token => typeof token !== 'string'))
        return { error: `lite-cmd-node：npm run 仅支持单命令 argv，脚本含未实现的 shell 语法：${script}\n`, exit: 1 };
    return {
        script: name, name: typeof manifest.name === 'string' ? manifest.name : '(unknown)',
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        tokens: [...tokens, ...extra],
        commandLine: extra.length ? `${script} ${extra.join(' ')}` : script,
    };
};

// 私有：npm run 的 banner（模拟口径统一记 stdout；真实 npm 的落点随版本有差异，以头注释声明为准）。
function f_npmBanner(plan) {
    return `> ${plan.name}@${plan.version} ${plan.script}\n> ${plan.commandLine}\n\n`;
}
