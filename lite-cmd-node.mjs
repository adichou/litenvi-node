// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；无前缀的接口允许所有调用方使用。
// lite-cmd-node：Node/npm 命令定义，执行入口统一经 lite-child_process。
// 脚本经普通 import 在宿主内执行，不启动真实子进程，也不使用 VM 模块加载器。
// AsyncLocalStorage 将 process、console、定时器及文件/服务调用路由到当前虚拟命令；
// 入口 URL 带运行序号以重新执行入口，依赖保持原生 import 缓存与共享全局语义。
import path from 'node:path';
import realFs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import timers from 'node:timers';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import liteFs from './lite-fs.mjs';
import liteServer from './lite-server.mjs';
import liteChildProcess from './lite-child_process.mjs';
import { pkg_ProcessExitError } from './lite-cmd-mgr.mjs';
import { promisify } from 'node:util';

// 内部导出：供进程模块构造虚拟 execPath，测试使用公共字段验证。
export const pkg_NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';
const f_execution = new AsyncLocalStorage();
const f_hostTimers = { ...timers };
const f_hostFs = { ...realFs };
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
    for (const key of ['argv', 'env', 'execPath', 'execArgv', 'pid', 'stdin', 'stdout', 'stderr', 'cwd', 'exit']) {
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
    // 同步文件调用经 liteFs；同步重入时允许门面把排除路径转给真实 fs。
    let insideFs = false;
    for (const key of Object.keys(realFs).filter(key => key.endsWith('Sync') && typeof realFs[key] === 'function')) {
        const original = realFs[key];
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_replace(realFs, key, { writable: true, value: function (...args) {
            const runtime = f_currentRuntime();
            if (!runtime || insideFs) return original.apply(this, args);
            insideFs = true;
            try { return liteFs[key](...args); }
            finally { insideFs = false; }
        } });
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
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = childProcess[key];
        const f_dispatch = function (...args) {
            const runtime = f_currentRuntime();
            if (!runtime) return original.apply(this, args);
            if (key === 'fork') throw new Error(`lite-cmd-node：子进程接口 ${key} 未实现内存语义`);
            const result = liteChildProcess[key](...args);
            return ['spawn', 'exec', 'execFile'].includes(key) ? runtime.f_trackChild(result) : result;
        };
        if (key === 'exec' || key === 'execFile') {
            Object.defineProperty(f_dispatch, promisify.custom, { value: (...args) => {
                const runtime = f_currentRuntime();
                const method = runtime ? liteChildProcess[key] : original;
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
function f_invocation(argv, ctx) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-v' || arg === '--version') return { kind: 'version' };
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
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_runNode(plan, ctx, child) {
    const pending = new Set(), servers = new Set(), children = new Set();
    const cwd = ctx.cwd();
    const inheritedExitCode = f_hostProcess.exitCode;
    const runtime = { finished: false };
    let mainDone = false, importing = false, check;
    const stdout = child.stdout, stderr = child.stderr;
    const console = new Console({ stdout, stderr, colorMode: false });
    const proc = Object.assign(new EventEmitter(), {
        argv: [ctx.execPath, ...(plan.kind === 'file' ? [plan.file] : []), ...plan.args],
        env: { ...(ctx.options.env ?? ctx.env) }, execPath: ctx.execPath, execArgv: [],
        pid: child.pid, platform: f_hostProcess.platform, version: f_hostProcess.version, versions: f_hostProcess.versions,
        stdin: child.stdin, stdout, stderr, cwd: () => cwd, exitCode: undefined,
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        exit(code = proc.exitCode ?? 0) { ctx.recordExit(code); throw new pkg_ProcessExitError(Number(code) & 255); },
    });
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
        if (error instanceof pkg_ProcessExitError) f_finish(error.exitCode);
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
        if (runtime.finished) throw new pkg_ProcessExitError(0);
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
                    args[0] = (...result) => { servers.delete(server); f_checkIdle(); callback?.(...result); };
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
            const imported = f_hostFs.existsSync(plan.file) ? import(url.href)
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
    run(argv, ctx, child) {
        const plan = f_invocation(argv, ctx);
        if (plan.kind === 'version') {
            child.stdout.write(`${process.version}\n`);
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        } else f_runNode(plan, ctx, child);
    },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    runSync(argv, ctx) {
        if (f_invocation(argv, ctx).kind === 'version') return { status: 0, stdout: `${process.version}\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: 'lite-cmd-node：node 入口的同步执行未实现（import 是异步的），请改用 spawn\n' };
    },
};

let f_npmVersion;
// 私有方法：仅在本文件实现中使用，不导出。
function f_installedNpmVersion() {
    if (f_npmVersion) return f_npmVersion;
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        try {
            const executable = realFs.realpathSync(path.join(directory, 'npm'));
            const metadata = JSON.parse(realFs.readFileSync(path.resolve(path.dirname(executable), '..', 'package.json'), 'utf8'));
            if (metadata.name === 'npm' && typeof metadata.version === 'string') return f_npmVersion = metadata.version;
        } catch { /* 继续查找 PATH 中的 npm 安装位置 */ }
    }
    throw new Error('lite-cmd-node：无法读取当前 npm 的版本元数据');
}

// 系统命令由 mgr 导入时自动登记；npm 版本来自安装元数据，mock 时不启动真实进程。
// 内部导出：仅供 mgr 登记命令实现，测试通过 child_process 的公共入口验证。
export const pkg_COMMANDS = {
    [pkg_NODE_COMMAND_PATH]: f_nodeImpl,
    '/mock-cmd/usr/local/bin/npm': {
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        runSync(argv) {
            if (argv[0] === '-v' || argv[0] === '--version') return { status: 0, stdout: `${f_installedNpmVersion()}\n`, stderr: '' };
            return { status: 1, stdout: '', stderr: 'lite-cmd-node：npm 该参数未实现内存语义\n' };
        },
    },
};
