// lite-child_process：node:child_process 的 spawn/spawnSync 切换门面。
// 默认转发真实 Node；mock 后经 mgr 解析并执行内存命令，全部调用统一记入 calls()，reset()
// 只清账本。spawn 通过流与异步事件报告结果，启动失败发 error/close；spawnSync 按 encoding
// 返回 Buffer 或字符串，并提供 status/signal/output/pid。自然退出与信号退出均移除 PID。
// 命令实现通过 lite-process 的 commandContext 获取进程能力；不在命令模块维护子进程账本。
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import timers from 'node:timers';
import { PassThrough } from 'node:stream';
import { constants } from 'node:os';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import liteFs from './lite-fs.mjs';
import mgr from './lite-cmd-mgr.mjs';
import { commandContext, ProcessExitError } from './lite-process.mjs';
// 运行态自身的调度不计入虚拟 Node 脚本的定时器。
const { setImmediate, setInterval, clearInterval } = timers;
const signals = constants.signals;

// 启动失败沿用 Node 的系统错误字段，异步 spawn 通过 error 事件投递。
function spawnError(kind, command, args, code = 'ENOENT') {
    const error = new Error(`${kind} ${command} ${code}`);
    error.code = code;
    error.errno = -(constants.errno[code] || constants.errno.ENOENT);
    error.syscall = `${kind} ${command}`;
    error.path = command;
    error.spawnargs = [...args];
    return error;
}

// 参数错误沿用 Node 的字段名、类型描述和原值展示，便于直接对照原生返回。
function argumentError(name, value, expected, reason) {
    const kind = name.includes('.') ? 'property' : 'argument';
    let message;
    if (reason) {
        const rendered = inspect(value);
        message = `The ${kind} '${name}' ${reason}. Received ${rendered.length > 128 ? `${rendered.slice(0, 128)}...` : rendered}`;
    } else {
        const actual = value === null || value === undefined ? String(value)
            : typeof value === 'function' ? `function ${value.name}`
                : typeof value === 'object' && value.constructor?.name ? `an instance of ${value.constructor.name}`
                    : `type ${typeof value} (${inspect(value)})`;
        message = `The "${name}" ${kind} must be ${expected}. Received ${actual}`;
    }
    const error = new TypeError(message);
    error.code = reason ? 'ERR_INVALID_ARG_VALUE' : 'ERR_INVALID_ARG_TYPE';
    return error;
}

function cwdPath(value) {
    if (value == null) return undefined;
    if (value instanceof URL) value = fileURLToPath(value);
    if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw argumentError('options.cwd', value, 'of type string or an instance of Buffer or URL');
    if (value.includes(typeof value === 'string' ? '\0' : 0))
        throw argumentError('options.cwd', value, null, 'must be a string, Uint8Array, or URL without null bytes');
    const text = typeof value === 'string' ? value : Buffer.from(value).toString();
    return path.resolve(commandContext().cwd(), text);
}

// 同时支持 spawn(command, args, options) 与 spawn(command, options)。
function spawnArguments(command, args, options = {}) {
    if (typeof command !== 'string') throw argumentError('file', command, 'of type string');
    if (command.includes('\0')) throw argumentError('file', command, null, 'must be a string without null bytes');
    if (!command) throw argumentError('file', command, null, 'cannot be empty');
    if (args == null) args = [];
    if (!Array.isArray(args)) {
        if (typeof args !== 'object') throw argumentError('args', args, 'of type object');
        options = args;
        args = [];
    }
    for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && args[i].includes('\0'))
            throw argumentError(`args[${i}]`, args[i], null, 'must be a string without null bytes');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options))
        throw argumentError('options', options, 'of type object');
    const cwd = cwdPath(options.cwd);
    return { command, args: args.map(String), options, cwd };
}

function inputBuffer(input, encoding) {
    // Node 只为 truthy 的 options.input 安装输入；其余值相当于空输入。
    if (!input) return Buffer.alloc(0);
    if (typeof input === 'string') return Buffer.from(input, encoding);
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    throw argumentError('options.stdio[0]', input, 'of type string or an instance of Buffer, TypedArray, or DataView');
}

function createMemorySpawn() {
    const calls = [];
    let nextPid = 4201; // PID 不依赖账本长度，清账后仍保持当前会话内唯一
    const children = new Map();
    const states = new WeakMap();
    let disposed = false;
    function resolveCall(command, args, options, cwd, kind) {
        calls.push({ command, args: [...args], options: { ...options } });
        if (cwd !== undefined) {
            try {
                if (!liteFs.statSync(cwd).isDirectory())
                    return { error: spawnError(kind, command, args, 'ENOTDIR') };
            } catch (error) {
                return { error: spawnError(kind, command, args, error.code || 'ENOENT') };
            }
        }
        const cmd = mgr.resolve(command);
        return cmd ? { cmd } : { error: spawnError(kind, command, args) };
    }
    function signalName(sig) {
        if (sig === 0) return 0;
        const name = typeof sig === 'number'
            ? Object.keys(signals).find(key => signals[key] === sig)
            : String(sig).toUpperCase();
        if (!Object.hasOwn(signals, name)) {
            const error = new TypeError(`Unknown signal: ${sig}`);
            error.code = 'ERR_UNKNOWN_SIGNAL';
            throw error;
        }
        return name;
    }
    function finish(child, code, signal = null) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const state = states.get(child);
        if (state.paused && signal === null) {
            state.pending.push(() => finish(child, code, signal));
            return;
        }
        child.emit('exit', code, signal);
    }
    function deliverSignal(child, sig) {
        const name = signalName(sig);
        if (!children.has(child.pid)) return false;
        if (name === 0) return true;
        const state = states.get(child);
        if (name === 'SIGSTOP') { state.paused = true; return true; }
        if (name === 'SIGCONT') {
            state.paused = false;
            for (const resume of state.pending.splice(0)) resume();
            return true;
        }
        if (['SIGCHLD', 'SIGWINCH', 'SIGURG'].includes(name)) return true;
        state.pending.length = 0;
        state.terminating = true;
        queueMicrotask(() => finish(child, null, name));
        return true;
    }
    function piped(options, index) {
        const mode = Array.isArray(options.stdio) ? options.stdio[index] : options.stdio;
        return mode === undefined || mode === null || mode === 'pipe';
    }
    function spawn(command, args, options) {
        let cwd;
        ({ command, args, options, cwd } = spawnArguments(command, args, options));
        const contextOptions = { ...options, ...(cwd !== undefined || options.cwd === null ? { cwd } : {}) };
        const { cmd, error } = resolveCall(command, args, options, cwd, 'spawn');
        const child = new EventEmitter();
        child.stdin = piped(options, 0) ? new PassThrough() : null;
        child.stdout = piped(options, 1) ? new PassThrough() : null;
        child.stderr = piped(options, 2) ? new PassThrough() : null;
        child.stdio = [child.stdin, child.stdout, child.stderr];
        child.spawnfile = command;
        child.spawnargs = [command, ...args];
        child.pid = error ? undefined : nextPid++;
        child.exitCode = null;
        child.signalCode = null;
        child.killed = false;
        let closed = false;
        let closing = false;
        // close 必须晚于管道读取结束；未被消费的管道也要排空，避免等待永久悬挂。
        const close = (code, signal) => {
            if (closing) return false;
            closing = true;
            for (const stream of [child.stdout, child.stderr]) {
                stream?.end();
                stream?.resume();
            }
            setImmediate(() => { if (!disposed) child.emit('close', code, signal); });
            return true;
        };
        const state = { paused: false, pending: [], terminating: false, lifetime: null };
        states.set(child, state);
        child.ref = () => { state.lifetime?.ref(); };
        child.unref = () => { state.lifetime?.unref(); };
        child.kill = (sig = 'SIGTERM') => {
            const delivered = deliverSignal(child, sig);
            if (delivered) child.killed = true;
            return delivered;
        };
        child.once('exit', (code, signal) => {
            child.exitCode = code;
            child.signalCode = signal;
            clearInterval(state.lifetime);
            state.lifetime = null;
            state.pending.length = 0;
            children.delete(child.pid);
            close(code, signal);
        });
        child.once('close', () => { closed = true; children.delete(child.pid); });
        if (error) {
            queueMicrotask(() => {
                if (disposed) return;
                child.emit('error', error);
                child.exitCode = error.errno;
                close(error.errno, null);
            });
            return child;
        }
        // 虚拟子进程持有独立引用；unref 释放它，退出或卸载世界时统一清理。
        state.lifetime = setInterval(() => {}, 0x7fffffff);
        children.set(child.pid, child);
        // 命令只写子进程管道；stdio 为 ignore 时由内部空流吸收，公开字段仍为 null。
        const discard = new PassThrough();
        discard.resume();
        const commandStream = stream => new Proxy(stream || discard, { get(target, key) {
            if (key === 'write') return (...args) => {
                if (disposed || closing) return discard.write(...args);
                if (state.paused) {
                    const chunk = Buffer.isBuffer(args[0]) ? Buffer.from(args[0]) : args[0];
                    state.pending.push(() => target.write(chunk, ...args.slice(1)));
                    return true;
                }
                return target.write(...args);
            };
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const stdout = commandStream(child.stdout), stderr = commandStream(child.stderr);
        const emitCommand = (event, ...args) => {
            if (disposed || (event === 'exit' && (child.exitCode !== null || child.signalCode !== null))
                || (event === 'close' && closed)) return false;
            if (state.paused && (event === 'exit' || event === 'close')) {
                state.pending.push(() => emitCommand(event, ...args));
                return true;
            }
            if (event === 'close') return close(...args);
            return child.emit(event, ...args);
        };
        const io = new Proxy(child, { get(target, key) {
            if (key === 'stdout') return stdout;
            if (key === 'stderr') return stderr;
            if (key === 'emit') return emitCommand;
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        queueMicrotask(() => {
            if (disposed) return;
            child.emit('spawn');
            if (!children.has(child.pid) || state.terminating) return;
            try {
                // 所有命令先领取一次故障；等待逻辑与命令是否提供异步实现无关。
                const fault = cmd.takeFault();
                if (fault) {
                    const fire = () => {
                        if (disposed || !children.has(child.pid) || state.terminating) return;
                        if (fault.stderr) io.stderr.write(Buffer.from(fault.stderr));
                        finish(child, fault.exit ?? 1);
                    };
                    if (fault.wait instanceof Promise) fault.wait.then(fire, fire);
                    else fire();
                    return;
                }
                if (typeof cmd.impl.run === 'function') cmd.impl.run([...args], {
                    ...commandContext(contextOptions),
                    onDispose: cleanup => { state.cleanup = cleanup; },
                }, io);
                else if (typeof cmd.impl.runSync === 'function') {
                    const result = cmd.runSync(args, commandContext(contextOptions), null);
                    if (result.stdout) io.stdout.write(result.stdout);
                    if (result.stderr) io.stderr.write(result.stderr);
                    finish(child, result.status ?? 0, result.signal ?? null);
                }
            } catch (error) {
                if (error instanceof ProcessExitError) finish(child, error.exitCode);
                else {
                    io.stderr.write(`${error.stack || error}\n`);
                    finish(child, 1);
                }
            }
        });
        return child;
    }
    function spawnSync(command, args, options) {
        let cwd;
        ({ command, args, options, cwd } = spawnArguments(command, args, options));
        const input = inputBuffer(options.input, options.encoding);
        const contextOptions = { ...options, ...(cwd !== undefined || options.cwd === null ? { cwd } : {}) };
        const found = resolveCall(command, args, options, cwd, 'spawnSync');
        if (found.error || typeof found.cmd.impl.runSync !== 'function') {
            return { error: found.error || spawnError('spawnSync', command, args), status: null, signal: null,
                output: null, pid: 0, stdout: undefined, stderr: undefined };
        }
        let result;
        try {
            const context = commandContext(contextOptions);
            context.input = piped(options, 0) ? input : Buffer.alloc(0); // 保留原始 options，忽略的 stdin 不消费输入
            result = found.cmd.runSync(args, context);
        }
        catch (error) {
            result = error instanceof ProcessExitError
                ? { status: error.exitCode }
                : { status: 1, stderr: `${error.stack || error}\n` };
        }
        const encode = value => options.encoding && options.encoding !== 'buffer'
            ? Buffer.from(value || '').toString(options.encoding) : Buffer.from(value || '');
        const stdout = piped(options, 1) ? encode(result.stdout) : null;
        const stderr = piped(options, 2) ? encode(result.stderr) : null;
        return { status: result.status ?? 0, signal: result.signal ?? null, output: [null, stdout, stderr],
            pid: nextPid++, stdout, stderr };
    }
    return {
        spawn, spawnSync, calls,
        dispose() {
            disposed = true;
            for (const child of children.values()) {
                const state = states.get(child);
                clearInterval(state.lifetime);
                state.lifetime = null;
                state.pending.length = 0;
                state.cleanup?.(); // 撤销环境时同时回收命令创建的定时器、服务等运行资源
            }
            children.clear();
        },
        // 自然退出和信号退出都除名，信号 0 仅检查进程是否存在。
        signal(pid, sig = 'SIGTERM') {
            const name = signalName(sig);
            const child = children.get(Number(pid));
            return child ? deliverSignal(child, name) : false;
        },
    };
}

let memory = null; // 未设置 → 默认实现（真实 spawn/spawnSync）

const liteChildProcess = {
    // 统一执行入口：真实分支透传 child_process（生产行为不变）；内存分支见 createMemorySpawn
    spawn(...args) { return memory ? memory.spawn(...args) : realSpawn(...args); },
    spawnSync(...args) { return memory ? memory.spawnSync(...args) : realSpawnSync(...args); },
    // 设置内存实现；返回该实现（calls 已在门面上代理，一般无须直接持有）
    mock() { return memory ?? (memory = createMemorySpawn()); },
    // 移除内存实现，回到真实 spawn；调用记录与在册子进程随实例一并丢弃
    unmock() { memory?.dispose(); memory = null; },
    // 等待子进程 close 并取终态 { code, signal }——真实与内存子进程同口径（一次性事件 →
    // 可 await 的值的收敛包装，替代消费侧手写 new Promise + on('close')）；spawn 失败
    //（error 事件，如命令不存在）按拒绝收场。先取 Promise 再触发动作，监听时序才有保证
    waitForClose(child) {
        return new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
    },
    // signal(pid, sig)：通用信号投递——按 pid 向在册内存子进程发信号（能力上对应真实
    // world 的信号投递；kill 命令与 liteProcess.kill 消费此面，pkill/timeout 或测试直发皆可）。
    // 与替身子进程对象的 child.kill(sig)（ChildProcess#kill 对应面）共用投递原语。
    // 落在本门面是因为 pid 登记表随子进程创建在此（mgr/lite-process 反向导入会成环）；
    // 须先 mock()，返回是否送达
    signal(pid, sig = 'SIGTERM') {
        if (!memory)
            throw new Error('liteChildProcess.signal 需先 mock() 设置内存实现');
        return memory.signal(pid, sig);
    },
    // 调用历史（非执行历史）：spawn/spawnSync 调用按发生顺序入账——发生在边界，先于命令
    // 解析；派发失败（命令未装卷/未注册，未执行）的调用同样在列；须先 mock()
    calls() {
        if (!memory)
            throw new Error('liteChildProcess.calls 需先 mock() 设置内存实现');
        return memory.calls.map(call => ({ ...call, args: [...call.args], options: { ...call.options } }));
    },
    // 统一清空所有命令的调用账本；命令配置、在册子进程与 PID 序列均保留
    reset() {
        if (!memory)
            throw new Error('liteChildProcess.reset 需先 mock() 设置内存实现');
        memory.calls.length = 0;
    },
};

export default liteChildProcess;
