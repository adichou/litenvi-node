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
import { ProcessExitError } from './lite-cmd-mgr.mjs';

export const NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';
const execution = new AsyncLocalStorage();
const hostTimers = { ...timers };
const hostFs = { ...realFs };
const currentRuntime = () => { const runtime = execution.getStore(); return runtime?.finished ? undefined : runtime; };
const hostProcess = process;
const active = new Set();
let restoreBoundaries, sequence = 0;

// 替换只在有脚本运行时保留；宿主调用以及其他异步上下文始终走原来的实现。
function installBoundaries() {
    const originals = [];
    const replace = (owner, key, descriptor, original = Object.getOwnPropertyDescriptor(owner, key)) => {
        originals.push([owner, key, original]);
        Object.defineProperty(owner, key, { configurable: true, enumerable: original?.enumerable ?? true, ...descriptor });
        return original;
    };
    for (const key of ['argv', 'env', 'execPath', 'execArgv', 'pid', 'stdin', 'stdout', 'stderr', 'cwd', 'exit']) {
        const original = Object.getOwnPropertyDescriptor(hostProcess, key);
        replace(hostProcess, key, {
            get() {
                const runtime = currentRuntime();
                return runtime ? runtime.proc[key] : original.get ? original.get.call(hostProcess) : original.value;
            },
            set(value) {
                const runtime = currentRuntime();
                if (runtime) runtime.proc[key] = value;
                else if (original.set) original.set.call(hostProcess, value);
                else original.value = value;
            },
        }, original);
    }
    // exitCode 在 Node 上不可重新定义；全局 process 通过代理提供当前命令的视图。
    const processFace = new Proxy(hostProcess, {
        get(target, key) {
            const runtime = currentRuntime();
            return runtime && key in runtime.proc ? runtime.proc[key] : Reflect.get(target, key);
        },
        set(target, key, value) {
            const runtime = currentRuntime();
            if (runtime && key in runtime.proc) { runtime.proc[key] = value; return true; }
            return Reflect.set(target, key, value);
        },
    });
    replace(globalThis, 'process', { get: () => currentRuntime() ? processFace : hostProcess });
    for (const key of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'trace', 'assert']) {
        const original = console[key];
        replace(console, key, { writable: true, value: function (...args) {
            const runtime = currentRuntime();
            return runtime ? runtime.console[key](...args) : original.apply(this, args);
        } });
    }
    for (const key of ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate']) {
        const dispatch = (...args) => {
            const runtime = currentRuntime();
            return (runtime ? runtime.timers[key] : hostTimers[key])(...args);
        };
        replace(globalThis, key, { writable: true, value: dispatch });
        replace(timers, key, { writable: true, value: dispatch });
    }
    // 同步文件调用经 liteFs；同步重入时允许门面把排除路径转给真实 fs。
    let insideFs = false;
    for (const key of Object.keys(realFs).filter(key => key.endsWith('Sync') && typeof realFs[key] === 'function')) {
        const original = realFs[key];
        replace(realFs, key, { writable: true, value: function (...args) {
            const runtime = currentRuntime();
            if (!runtime || insideFs) return original.apply(this, args);
            insideFs = true;
            try { return liteFs[key](...args); }
            finally { insideFs = false; }
        } });
    }
    for (const owner of [http, https, net, tls, liteServer]) {
        const original = owner.createServer;
        replace(owner, 'createServer', { writable: true, value: function (...args) {
            const runtime = currentRuntime();
            const server = original.apply(this, args);
            return runtime ? runtime.trackServer(server) : server;
        } });
    }
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = childProcess[key];
        replace(childProcess, key, { writable: true, value: function (...args) {
            const runtime = currentRuntime();
            if (!runtime) return original.apply(this, args);
            if (key !== 'spawn' && key !== 'spawnSync') throw new Error(`lite-cmd-node：子进程接口 ${key} 未实现内存语义`);
            const result = liteChildProcess[key](...args);
            return key === 'spawn' ? runtime.trackChild(result) : result;
        } });
    }
    syncBuiltinESMExports();
    return () => {
        for (const [owner, key, original] of originals.reverse()) Object.defineProperty(owner, key, original);
        syncBuiltinESMExports();
    };
}

function invocation(argv, ctx) {
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

function runNode(plan, ctx, child) {
    const pending = new Set(), servers = new Set(), children = new Set();
    const cwd = ctx.cwd();
    const inheritedExitCode = hostProcess.exitCode;
    const runtime = { finished: false };
    let mainDone = false, importing = false, check;
    const stdout = child.stdout, stderr = child.stderr;
    const console = new Console({ stdout, stderr, colorMode: false });
    const proc = Object.assign(new EventEmitter(), {
        argv: [ctx.execPath, ...(plan.kind === 'file' ? [plan.file] : []), ...plan.args],
        env: { ...(ctx.options.env ?? ctx.env) }, execPath: ctx.execPath, execArgv: [],
        pid: child.pid, platform: hostProcess.platform, version: hostProcess.version, versions: hostProcess.versions,
        stdin: child.stdin, stdout, stderr, cwd: () => cwd, exitCode: undefined,
        exit(code = proc.exitCode ?? 0) { ctx.recordExit(code); throw new ProcessExitError(Number(code) & 255); },
    });
    const release = () => {
        if (!runtime.finished || importing) return;
        active.delete(runtime);
        if (!active.size && restoreBoundaries) {
            execution.exit(restoreBoundaries);
            restoreBoundaries = undefined;
        }
    };
    const dispose = () => {
        runtime.finished = true;
        hostTimers.clearImmediate(check);
        for (const handle of pending) { hostTimers.clearTimeout(handle); hostTimers.clearImmediate(handle); }
        pending.clear();
        for (const server of servers) {
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            server.close();
        }
        servers.clear();
        // node:process 的 exitCode 不可代理重定义，按共享进程语义读取并在结束时恢复。
        hostProcess.exitCode = inheritedExitCode;
        release();
    };
    const finish = code => {
        if (runtime.finished) return;
        dispose();
        execution.exit(() => {
            child.emit('exit', Number(code) & 255, null);
            child.emit('close', Number(code) & 255, null);
        });
    };
    const fail = error => {
        if (runtime.finished) return;
        if (error instanceof ProcessExitError) finish(error.exitCode);
        else { stderr.write(`${error.stack || error}\n`); finish(1); }
    };
    const checkIdle = () => {
        hostTimers.clearImmediate(check);
        check = hostTimers.setImmediate(() => {
            if (mainDone && !runtime.finished && !servers.size && !children.size && ![...pending].some(handle => handle.hasRef()))
                finish(proc.exitCode ?? (hostProcess.exitCode !== inheritedExitCode ? hostProcess.exitCode : 0));
        });
    };
    const schedule = (kind, callback, delay, args) => {
        if (runtime.finished) throw new ProcessExitError(0);
        let handle;
        const invoke = () => {
            if (kind !== 'interval') pending.delete(handle);
            if (runtime.finished) return;
            try { callback(...args); } catch (error) { fail(error); }
            checkIdle();
        };
        handle = kind === 'immediate' ? hostTimers.setImmediate(invoke)
            : kind === 'interval' ? hostTimers.setInterval(invoke, delay) : hostTimers.setTimeout(invoke, delay);
        pending.add(handle);
        const unref = handle.unref.bind(handle);
        handle.unref = () => { unref(); checkIdle(); return handle; };
        return handle;
    };
    const clear = handle => { hostTimers.clearTimeout(handle); hostTimers.clearImmediate(handle); pending.delete(handle); checkIdle(); };
    const timerFace = {
        setTimeout: (callback, delay, ...args) => schedule('timeout', callback, delay, args),
        setInterval: (callback, delay, ...args) => schedule('interval', callback, delay, args),
        setImmediate: (callback, ...args) => schedule('immediate', callback, 0, args),
        clearTimeout: clear, clearInterval: clear, clearImmediate: clear,
    };
    const trackServer = server => {
        server.once('close', () => { servers.delete(server); checkIdle(); });
        const proxy = new Proxy(server, { get(target, key) {
            const value = target[key];
            if (typeof value !== 'function') return value;
            return (...args) => {
                if (key === 'listen') servers.add(server);
                if (key === 'close') {
                    const callback = args[0];
                    args[0] = (...result) => { servers.delete(server); checkIdle(); callback?.(...result); };
                }
                const result = value.apply(target, args);
                return result === target ? proxy : result;
            };
        } });
        return proxy;
    };
    const trackChild = child => {
        children.add(child);
        child.once('close', () => { children.delete(child); checkIdle(); });
        return child;
    };
    Object.assign(runtime, { proc, console, timers: timerFace, trackServer, trackChild });
    active.add(runtime);
    if (!restoreBoundaries) restoreBoundaries = execution.exit(installBoundaries);
    child.once('exit', dispose);
    ctx.onDispose?.(dispose);
    const require = createRequire(pathToFileURL(plan.file || path.join(cwd, '[eval].js')));
    const evaluate = code => {
        const module = { exports: {} };
        const value = new Function('require', 'module', 'exports', '__filename', '__dirname', 'source', 'return eval(source)')
            (require, module, module.exports, '[eval]', cwd, code);
        if (plan.print) console.log(value);
        mainDone = true;
        checkIdle();
    };
    execution.run(runtime, () => {
        if (plan.kind === 'file') {
            const url = pathToFileURL(plan.file);
            url.searchParams.set('litenviRun', String(++sequence));
            importing = true;
            const imported = hostFs.existsSync(plan.file) ? import(url.href)
                : Promise.reject(Object.assign(new Error(`Cannot find module '${plan.file}'`), { code: 'MODULE_NOT_FOUND' }));
            imported.then(() => { mainDone = true; checkIdle(); }).catch(fail).finally(() => {
                importing = false;
                release();
            });
        } else if (plan.kind === 'eval') {
            try { evaluate(plan.code); } catch (error) { fail(error); }
        } else if (child.stdin) {
            let code = '';
            child.stdin.on('data', chunk => { code += chunk; });
            child.stdin.once('end', () => execution.run(runtime, () => { try { evaluate(code); } catch (error) { fail(error); } }));
        } else {
            try { evaluate(''); } catch (error) { fail(error); }
        }
    });
}

const nodeImpl = {
    run(argv, ctx, child) {
        const plan = invocation(argv, ctx);
        if (plan.kind === 'version') {
            child.stdout.write(`${process.version}\n`);
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        } else runNode(plan, ctx, child);
    },
    runSync(argv, ctx) {
        if (invocation(argv, ctx).kind === 'version') return { status: 0, stdout: `${process.version}\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: 'lite-cmd-node：node 入口的同步执行未实现（import 是异步的），请改用 spawn\n' };
    },
};

let npmVersion;
function installedNpmVersion() {
    if (npmVersion) return npmVersion;
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        try {
            const executable = realFs.realpathSync(path.join(directory, 'npm'));
            const metadata = JSON.parse(realFs.readFileSync(path.resolve(path.dirname(executable), '..', 'package.json'), 'utf8'));
            if (metadata.name === 'npm' && typeof metadata.version === 'string') return npmVersion = metadata.version;
        } catch { /* 继续查找 PATH 中的 npm 安装位置 */ }
    }
    throw new Error('lite-cmd-node：无法读取当前 npm 的版本元数据');
}

// 系统命令由 mgr 导入时自动登记；npm 版本来自安装元数据，mock 时不启动真实进程。
export const COMMANDS = {
    [NODE_COMMAND_PATH]: nodeImpl,
    '/mock-cmd/usr/local/bin/npm': {
        runSync(argv) {
            if (argv[0] === '-v' || argv[0] === '--version') return { status: 0, stdout: `${installedNpmVersion()}\n`, stderr: '' };
            return { status: 1, stdout: '', stderr: 'lite-cmd-node：npm 该参数未实现内存语义\n' };
        },
    },
};
export default COMMANDS;
