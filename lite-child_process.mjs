// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-child_process：node:child_process 的 spawn、exec、execFile 及同步版本切换门面。
// 默认转发真实 Node；mock 后经 mgr 解析并执行内存命令，全部调用统一记入 calls()，reset()
// 只清账本。spawn 通过流与异步事件报告结果，启动失败发 error/close；spawnSync 按 encoding
// 返回 Buffer 或字符串，并提供 status/signal/output/pid。自然退出与信号退出均移除 PID。
// 命令实现通过 lite-process 的 pkg_commandContext 获取进程能力；不在命令模块维护子进程账本。
import {
    spawn as realSpawn, spawnSync as realSpawnSync, exec as realExec, execSync as realExecSync,
    execFile as realExecFile, execFileSync as realExecFileSync,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import timers from 'node:timers';
import { PassThrough } from 'node:stream';
import { constants } from 'node:os';
import { inspect, promisify } from 'node:util';
import shellQuote from 'shell-quote';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import liteFs from './lite-fs.mjs';
import mgr from './lite-cmd-mgr.mjs';
import { pkg_commandContext, ProcessExitError } from './lite-process.mjs';
// 运行态自身的调度不计入虚拟 Node 脚本的定时器。
const { setImmediate: f_setImmediate, setInterval: f_setInterval, clearInterval: f_clearInterval, setTimeout: f_setTimeout, clearTimeout: f_clearTimeout } = timers;
const f_signals = constants.signals;

// 启动失败沿用 Node 的系统错误字段，异步 spawn 通过 error 事件投递。
// 私有方法：仅在本文件实现中使用，不导出。
function f_spawnError(kind, command, args, code = 'ENOENT') {
    const error = new Error(`${kind} ${command} ${code}`);
    error.code = code;
    error.errno = -(constants.errno[code] || constants.errno.ENOENT);
    error.syscall = `${kind} ${command}`;
    error.path = command;
    error.spawnargs = [...args];
    return error;
}

// 参数错误沿用 Node 的字段名、类型描述和原值展示，便于直接对照原生返回。
// 私有方法：仅在本文件实现中使用，不导出。
function f_argumentError(name, value, expected, reason) {
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

// 私有方法：仅在本文件实现中使用，不导出。
function f_cwdPath(value) {
    if (value == null) return undefined;
    if (value instanceof URL) value = fileURLToPath(value);
    if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw f_argumentError('options.cwd', value, 'of type string or an instance of Buffer or URL');
    if (value.includes(typeof value === 'string' ? '\0' : 0))
        throw f_argumentError('options.cwd', value, null, 'must be a string, Uint8Array, or URL without null bytes');
    const text = typeof value === 'string' ? value : Buffer.from(value).toString();
    return path.resolve(pkg_commandContext().cwd(), text);
}

// 同时支持 spawn(command, args, options) 与 spawn(command, options)。
// 私有方法：仅在本文件实现中使用，不导出。
function f_spawnArguments(command, args, options = {}) {
    if (typeof command !== 'string') throw f_argumentError('file', command, 'of type string');
    if (command.includes('\0')) throw f_argumentError('file', command, null, 'must be a string without null bytes');
    if (!command) throw f_argumentError('file', command, null, 'cannot be empty');
    if (args == null) args = [];
    if (!Array.isArray(args)) {
        if (typeof args !== 'object') throw f_argumentError('args', args, 'of type object');
        options = args;
        args = [];
    }
    for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && args[i].includes('\0'))
            throw f_argumentError(`args[${i}]`, args[i], null, 'must be a string without null bytes');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options))
        throw f_argumentError('options', options, 'of type object');
    const cwd = f_cwdPath(options.cwd);
    if (options.shell) {
        args = ['-c', [command, ...args].join(' ')];
        command = typeof options.shell === 'string' ? options.shell : '/bin/sh';
    }
    return { command, args: args.map(String), options, cwd };
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_inputBuffer(input, encoding) {
    // Node 只为 truthy 的 options.input 安装输入；其余值相当于空输入。
    if (!input) return Buffer.alloc(0);
    if (typeof input === 'string') return Buffer.from(input, encoding);
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    throw f_argumentError('options.stdio[0]', input, 'of type string or an instance of Buffer, TypedArray, or DataView');
}

// exec 的缓冲、回调及 Promise 适配均为本文件私有实现。
// 私有方法：仅在本文件实现中使用，不导出。
function f_normalizeExecArguments(file, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    options ??= {};
    if (typeof options !== 'object') throw Object.assign(new TypeError('The "options" argument must be of type object.'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (options.signal != null && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function'))
        throw Object.assign(new TypeError('The "options.signal" property must be an instance of AbortSignal.'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (options.killSignal !== undefined) {
        const signal = options.killSignal;
        const valid = typeof signal === 'number' ? Object.values(constants.signals).includes(signal)
            : typeof signal === 'string' && Object.hasOwn(constants.signals, signal.toUpperCase());
        if (!valid) throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: 'ERR_UNKNOWN_SIGNAL' });
    }
    if (callback != null && typeof callback !== 'function') {
        const error = new TypeError('The "callback" argument must be of type function.');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
    }
    for (const key of ['timeout', 'maxBuffer']) {
        const value = options[key];
        if (value !== undefined && (typeof value !== 'number' || !(value >= 0) || (key === 'timeout' && !Number.isInteger(value)))) {
            const error = new RangeError(`The value of "options.${key}" is out of range. It must be a positive number. Received ${value}`);
            error.code = 'ERR_OUT_OF_RANGE';
            throw error;
        }
    }
    return { file, args, options, callback };
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_commandText(command) {
    if (typeof command !== 'string' || command.includes('\0')) {
        const error = new TypeError('The "command" argument must be a string without null bytes.');
        error.code = typeof command === 'string' ? 'ERR_INVALID_ARG_VALUE' : 'ERR_INVALID_ARG_TYPE';
        throw error;
    }
}
// 私有方法：仅在本文件实现中使用，不导出。
const f_display = (file, args) => [file, ...args].join(' ');

// 私有方法：仅在本文件实现中使用，不导出。
function f_createExecMethods(backend) {
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_buffered(file, args, options, callback, cmd) {
        const child = backend.spawn(file, args, { ...options, stdio: 'pipe' });
        const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_decode = data => encoding && Buffer.isEncoding(encoding) ? data.toString(encoding) : data;
        const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
        const limit = options.maxBuffer ?? 1024 * 1024;
        let failure, timer, complete = false;
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_cleanup = () => { f_clearTimeout(timer); options.signal?.removeEventListener('abort', f_abort); };
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_abort = () => {
            if (complete) return;
            const error = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: options.signal.reason });
            child.kill(options.killSignal || 'SIGTERM');
            child.emit('error', error);
        };
        backend.f_onDispose(child, f_cleanup);
        for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
            if (failure) return;
            const data = Buffer.from(chunk), available = Math.max(0, limit - sizes[name]);
            chunks[name].push(data.subarray(0, available));
            sizes[name] += data.length;
            if (sizes[name] > limit) {
                failure = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
                child.kill(options.killSignal || 'SIGTERM');
            }
        });
        child.on('error', error => { failure ??= error; });
        child.once('close', (code, signal) => {
            if (complete) return;
            complete = true;
            f_cleanup();
            const stdout = f_decode(Buffer.concat(chunks.stdout)), stderr = f_decode(Buffer.concat(chunks.stderr));
            if (!failure && (code !== 0 || signal)) failure = Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
                code, killed: child.killed, signal,
            });
            if (failure) failure.cmd = cmd;
            callback?.(failure || null, stdout, stderr);
        });
        if (options.timeout) timer = f_setTimeout(() => child.kill(options.killSignal || 'SIGTERM'), options.timeout);
        if (options.signal) {
            if (options.signal.aborted) queueMicrotask(f_abort);
            else options.signal.addEventListener('abort', f_abort, { once: true });
        }
        return child;
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_sync(file, args, options, cmd) {
        const result = backend.spawnSync(file, args, options);
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_size = value => value == null ? 0 : Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
        if (!result.error && f_size(result.stdout) + f_size(result.stderr) > (options.maxBuffer ?? 1024 * 1024)) {
            result.error = Object.assign(new Error(`spawnSync ${file} ENOBUFS`), {
                code: 'ENOBUFS', errno: -constants.errno.ENOBUFS, syscall: `spawnSync ${file}`, path: file, spawnargs: args,
            });
        }
        if (result.error || result.status !== 0 || result.signal) {
            const error = result.error || new Error(`Command failed: ${cmd}${result.stderr?.length ? `\n${result.stderr}` : ''}`);
            const { error: _startupError, ...fields } = result;
            Object.assign(error, fields);
            throw error;
        }
        return result.stdout;
    }
    return {
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        execFile(file, args, options, callback) {
            ({ file, args, options, callback } = f_normalizeExecArguments(file, args, options, callback));
            return f_buffered(file, args, options, callback, f_display(file, args));
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        exec(command, options, callback) {
            f_commandText(command);
            if (typeof options === 'function') { callback = options; options = {}; }
            ({ options, callback } = f_normalizeExecArguments('/bin/sh', [], options, callback));
            const shell = typeof options.shell === 'string' ? options.shell : '/bin/sh';
            return f_buffered(shell, ['-c', command], { ...options, shell: false }, callback, command);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        execFileSync(file, args, options) {
            ({ file, args, options } = f_normalizeExecArguments(file, args, options));
            return f_sync(file, args, options, f_display(file, args));
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        execSync(command, options = {}) {
            f_commandText(command);
            ({ options } = f_normalizeExecArguments('/bin/sh', [], options));
            const shell = typeof options.shell === 'string' ? options.shell : '/bin/sh';
            return f_sync(shell, ['-c', command], { ...options, shell: false }, command);
        },
    };
}

// 与 Node 一致：promisify 返回 { stdout, stderr }，Promise.child 暴露可取消的子进程句柄。
// 私有方法：仅在本文件实现中使用，不导出。
function f_installExecPromisify(method) {
    Object.defineProperty(method, promisify.custom, { value: (...args) => {
        let child;
        // 私有方法：仅在本文件实现中使用，不导出。
        const promise = new Promise((resolve, reject) => {
            child = method(...args, (error, stdout, stderr) => {
                if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
                else resolve({ stdout, stderr });
            });
        });
        promise.child = child;
        return promise;
    } });
}

// 内存 POSIX shell 子集：外部命令继续经本模块的 spawn/spawnSync 分派。
const f_fdPrefix = '__litenvi_shell_fd_';
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellPrepare(source) {
    let quote = '', result = '';
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === '\\' && quote !== "'") {
            if (source[i + 1] !== '\n') result += char + (source[i + 1] || '');
            i++;
            continue;
        }
        if (!quote && char === '#' && (i === 0 || /[\s;|&]/.test(source[i - 1]))) {
            while (i + 1 < source.length && source[i + 1] !== '\n') i++;
            continue;
        }
        if ((char === "'" || char === '"') && (!quote || quote === char)) quote = quote ? '' : char;
        if (quote !== "'" && (char === '`' || (char === '$' && source[i + 1] === '(')))
            throw new Error('内存 shell 尚未支持命令替换');
        if (!quote && /[12]/.test(char) && source[i + 1] === '>' && (i === 0 || /[\s;|&]/.test(source[i - 1])))
            result += `${f_fdPrefix}${char} `;
        else result += !quote && char === '\n' ? ' ; ' : char;
    }
    if (quote) throw new Error('unterminated quoted string');
    return result;
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellParse(source, env) {
    const tokens = shellQuote.parse(f_shellPrepare(source), env, { splitUnquoted: true });
    const groups = [];
    let condition = ';', programs = [], program = { words: [], redirects: [] };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_finishProgram = () => { programs.push(program); program = { words: [], redirects: [] }; };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (typeof token === 'string') { program.words.push(token); continue; }
        if (token.comment !== undefined) continue;
        if (['<', '>', '>>', '>&'].includes(token.op)) {
            const marked = program.words.at(-1)?.startsWith(f_fdPrefix);
            const fd = marked ? Number(program.words.pop().slice(f_fdPrefix.length)) : 1;
            const target = tokens[++i];
            if (typeof target !== 'string') throw new Error('syntax error near redirection');
            program.redirects.push({ op: token.op, fd, target });
        } else if (token.op === '|') {
            if (!program.words.length) throw new Error('syntax error near pipe');
            f_finishProgram();
        } else if ([';', '&&', '||'].includes(token.op)) {
            if (program.words.length || program.redirects.length) f_finishProgram();
            if (programs.length) groups.push({ condition, programs });
            else if (token.op !== ';') throw new Error('syntax error near operator');
            condition = token.op; programs = [];
        } else throw new Error(`内存 shell 尚未支持操作符 ${token.op}`);
    }
    if (program.words.length || program.redirects.length) f_finishProgram();
    if (programs.length) groups.push({ condition, programs });
    else if (condition !== ';') throw new Error('syntax error after operator');
    return groups;
}
// 私有方法：仅在本文件实现中使用，不导出。
const f_shellBytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value || '');
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellState(argv, ctx) {
    if (argv[0] !== '-c') throw new Error('内存 shell 仅支持 -c command');
    const env = { ...(ctx.options.env ?? ctx.env) };
    const cwd = ctx.cwd();
    return { groups: f_shellParse(argv[1] || '', env), cwd, initialCwd: cwd, explicitCwd: ctx.options.cwd != null, env, stopped: false };
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellInputFor(program, state, input) {
    for (const redirect of program.redirects) {
        if (redirect.op === '<') input = liteFs.readFileSync(path.resolve(state.cwd, redirect.target));
        else if (redirect.op === '>') liteFs.writeFileSync(path.resolve(state.cwd, redirect.target), '');
        else if (redirect.op === '>>' && !liteFs.existsSync(path.resolve(state.cwd, redirect.target))) liteFs.writeFileSync(path.resolve(state.cwd, redirect.target), '');
    }
    return input;
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellRedirected(program, state, result) {
    let stdout = f_shellBytes(result.stdout), stderr = f_shellBytes(result.stderr);
    for (const { op, fd, target } of program.redirects) {
        if (op === '>&') {
            if (fd === 1 && target === '2') { stderr = Buffer.concat([stderr, stdout]); stdout = Buffer.alloc(0); }
            else if (fd === 2 && target === '1') { stdout = Buffer.concat([stdout, stderr]); stderr = Buffer.alloc(0); }
            else throw new Error('内存 shell 仅支持 1>&2 / 2>&1');
        } else if (op === '>' || op === '>>') {
            const filename = path.resolve(state.cwd, target), data = fd === 2 ? stderr : stdout;
            if (op === '>>') liteFs.appendFileSync(filename, data); else liteFs.writeFileSync(filename, data);
            if (fd === 2) stderr = Buffer.alloc(0); else stdout = Buffer.alloc(0);
        }
    }
    return { ...result, stdout, stderr };
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellBuiltin(program, state) {
    const [command, ...args] = program.words;
    if (!command || command === ':' || command === 'true') return { status: 0 };
    if (command === 'false') return { status: 1 };
    if (command === 'exit') { state.stopped = true; return { status: Number(args[0] || 0) & 255 }; }
    if (command !== 'cd') return null;
    const target = path.resolve(state.cwd, args[0] || state.env.HOME || state.cwd);
    try {
        if (!liteFs.statSync(target).isDirectory()) return { status: 1, stderr: `/bin/sh: cd: ${args[0]}: Not a directory\n` };
        state.cwd = target;
        return { status: 0 };
    } catch { return { status: 1, stderr: `/bin/sh: cd: ${args[0]}: No such file or directory\n` }; }
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_shellCompletion(result, command) {
    if (result.error) return { status: result.error.code === 'ENOENT' ? 127 : 126,
        stderr: `/bin/sh: ${command}: ${result.error.code === 'ENOENT' ? 'command not found' : result.error.code}\n` };
    return { ...result, status: result.signal ? 128 + (constants.signals[result.signal] || 0) : result.status };
}
// 私有方法：仅在本文件实现中使用，不导出。
const f_shellExecutionOptions = state => ({ env: state.env, ...((state.explicitCwd || state.cwd !== state.initialCwd) ? { cwd: state.cwd } : {}) });
// 私有方法：仅在本文件实现中使用，不导出。
const f_shellShouldRun = (condition, status) => condition !== '&&' || status === 0;
// 私有方法：仅在本文件实现中使用，不导出。
const f_shellSyntaxFailure = error => ({ status: 2, stdout: '', stderr: `/bin/sh: ${error.message}\n` });

const f_shellCommand = {
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    pkg_runSync(argv, ctx) {
        try {
            const state = f_shellState(argv, ctx), stdout = [], stderr = [];
            let status = 0;
            for (const group of state.groups) {
                if (!f_shellShouldRun(group.condition, status) || (group.condition === '||' && status === 0)) continue;
                let input = ctx.input || Buffer.alloc(0);
                for (const program of group.programs) {
                    input = f_shellInputFor(program, state, input);
                    const [file, ...args] = program.words;
                    const result = f_shellRedirected(program, state, f_shellBuiltin(program, state) || f_shellCompletion(liteChildProcess.spawnSync(file, args,
                        { ...f_shellExecutionOptions(state), encoding: 'buffer', input }), file));
                    status = result.status;
                    stderr.push(result.stderr);
                    input = result.stdout;
                    if (state.stopped) break;
                }
                stdout.push(input);
                if (state.stopped) break;
            }
            return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
        } catch (error) { return f_shellSyntaxFailure(error); }
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    pkg_run(argv, ctx, child) {
        let cancelled = false, current, unread = Buffer.alloc(0);
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_stop = () => { cancelled = true; current?.kill(); };
        child.once('exit', f_stop);
        ctx.onDispose?.(f_stop);
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_execute = (program, inheritedInput) => new Promise(resolve => {
            const [file, ...args] = program.words;
            current = liteChildProcess.spawn(file, args, f_shellExecutionOptions(state));
            const running = current;
            const stdout = [], stderr = [];
            let error;
            current.stdout.on('data', chunk => stdout.push(chunk));
            current.stderr.on('data', chunk => stderr.push(chunk));
            current.on('error', failure => { error = failure; });
            current.once('close', (code, signal) => {
                inheritedInput?.unpipe(running.stdin);
                if (inheritedInput) unread = running.stdin.read() || Buffer.alloc(0);
                current = null;
                resolve(f_shellCompletion({ status: code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error }, file));
            });
            if (inheritedInput) {
                if (unread.length) current.stdin.write(unread);
                unread = Buffer.alloc(0);
                inheritedInput.pipe(current.stdin);
            }
            else current.stdin.end(input);
        });
        let state, input;
        (async () => {
            try {
                state = f_shellState(argv, ctx);
                let status = 0;
                for (const group of state.groups) {
                    if (cancelled) return;
                    if (!f_shellShouldRun(group.condition, status) || (group.condition === '||' && status === 0)) continue;
                    input = Buffer.alloc(0);
                    for (const [index, program] of group.programs.entries()) {
                        input = f_shellInputFor(program, state, input);
                        // 私有方法：仅在本文件实现中使用，不导出。
                        const source = index === 0 && !program.redirects.some(redirect => redirect.op === '<') ? child.stdin : null;
                        const result = f_shellRedirected(program, state, f_shellBuiltin(program, state) || await f_execute(program, source));
                        if (cancelled) return;
                        status = result.status;
                        if (result.stderr.length) child.stderr.write(result.stderr);
                        input = result.stdout;
                        if (state.stopped) break;
                    }
                    if (input.length) child.stdout.write(input);
                    if (state.stopped) break;
                }
                child.emit('exit', status, null);
                child.emit('close', status, null);
            } catch (error) {
                if (cancelled) return;
                const result = f_shellSyntaxFailure(error);
                child.stderr.write(result.stderr);
                child.emit('exit', result.status, null);
                child.emit('close', result.status, null);
            }
        })();
    },
};

// 私有方法：创建内存子进程运行态；仅在本文件实现中使用，不导出。
function f_createMemorySpawn() {
    // 延迟到 mock 时登记，避开 mgr → 命令集 → child_process 的导入环。
    if (!mgr.command('/mock-cmd/bin/sh')) mgr.pkg_defineCommand('/mock-cmd/bin/sh', f_shellCommand);
    const calls = [];
    let nextPid = 4201; // PID 不依赖账本长度，清账后仍保持当前会话内唯一
    const children = new Map();
    const states = new WeakMap();
    let disposed = false;
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_resolveCall(command, args, options, cwd, kind) {
        calls.push({ command, args: [...args], options: { ...options } });
        if (cwd !== undefined) {
            try {
                if (!liteFs.statSync(cwd).isDirectory())
                    return { error: f_spawnError(kind, command, args, 'ENOTDIR') };
            } catch (error) {
                return { error: f_spawnError(kind, command, args, error.code || 'ENOENT') };
            }
        }
        const cmd = mgr.pkg_resolve(command);
        return cmd ? { cmd } : { error: f_spawnError(kind, command, args) };
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_signalName(sig) {
        if (sig === 0) return 0;
        const name = typeof sig === 'number'
            ? Object.keys(f_signals).find(key => f_signals[key] === sig)
            : String(sig).toUpperCase();
        if (!Object.hasOwn(f_signals, name)) {
            const error = new TypeError(`Unknown signal: ${sig}`);
            error.code = 'ERR_UNKNOWN_SIGNAL';
            throw error;
        }
        return name;
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_finish(child, code, signal = null) {
        if (disposed || child.exitCode !== null || child.signalCode !== null) return;
        const state = states.get(child);
        if (state.paused && signal === null) {
            state.pending.push(() => f_finish(child, code, signal));
            return;
        }
        child.emit('exit', code, signal);
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_deliverSignal(child, sig) {
        const name = f_signalName(sig);
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
        if (name !== 'SIGKILL' && state.onSignal?.(name)) return true;
        state.pending.length = 0;
        state.terminating = true;
        queueMicrotask(() => f_finish(child, null, name));
        return true;
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_piped(options, index) {
        const mode = Array.isArray(options.stdio) ? options.stdio[index] : options.stdio;
        return mode === undefined || mode === null || mode === 'pipe';
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_spawn(command, args, options) {
        let cwd;
        ({ command, args, options, cwd } = f_spawnArguments(command, args, options));
        const contextOptions = { ...options, ...(cwd !== undefined || options.cwd === null ? { cwd } : {}) };
        const { cmd, error } = f_resolveCall(command, args, options, cwd, 'spawn');
        const child = new EventEmitter();
        child.stdin = f_piped(options, 0) ? new PassThrough() : null;
        child.stdout = f_piped(options, 1) ? new PassThrough() : null;
        child.stderr = f_piped(options, 2) ? new PassThrough() : null;
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
        // 私有方法：关闭共享浏览器；仅在本文件实现中使用，不导出。
        const f_close = (code, signal) => {
            if (closing) return false;
            closing = true;
            for (const stream of [child.stdout, child.stderr]) {
                stream?.end();
                stream?.resume();
            }
            f_setImmediate(() => { if (!disposed) child.emit('close', code, signal); });
            return true;
        };
        const state = { paused: false, pending: [], terminating: false, lifetime: null, cleanups: new Set() };
        states.set(child, state);
        child.ref = () => { state.lifetime?.ref(); };
        child.unref = () => { state.lifetime?.unref(); };
        child.kill = (sig = 'SIGTERM') => {
            const delivered = f_deliverSignal(child, sig);
            if (delivered) child.killed = true;
            return delivered;
        };
        child.once('exit', (code, signal) => {
            child.exitCode = code;
            child.signalCode = signal;
            f_clearInterval(state.lifetime);
            state.lifetime = null;
            state.pending.length = 0;
            children.delete(child.pid);
            f_close(code, signal);
        });
        child.once('close', () => { closed = true; children.delete(child.pid); });
        if (error) {
            queueMicrotask(() => {
                if (disposed) return;
                child.emit('error', error);
                child.exitCode = error.errno;
                f_close(error.errno, null);
            });
            return child;
        }
        // 虚拟子进程持有独立引用；unref 释放它，退出或卸载世界时统一清理。
        state.lifetime = f_setInterval(() => {}, 0x7fffffff);
        children.set(child.pid, child);
        // 命令只写子进程管道；stdio 为 ignore 时由内部空流吸收，公开字段仍为 null。
        const discard = new PassThrough();
        discard.resume();
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_commandStream = stream => new Proxy(stream || discard, { get(target, key) {
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
        const stdout = f_commandStream(child.stdout), stderr = f_commandStream(child.stderr);
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_emitCommand = (event, ...args) => {
            if (disposed || (event === 'exit' && (child.exitCode !== null || child.signalCode !== null))
                || (event === 'close' && closed)) return false;
            if (state.paused && (event === 'exit' || event === 'close')) {
                state.pending.push(() => f_emitCommand(event, ...args));
                return true;
            }
            if (event === 'close') return f_close(...args);
            return child.emit(event, ...args);
        };
        const io = new Proxy(child, { get(target, key) {
            if (key === 'stdout') return stdout;
            if (key === 'stderr') return stderr;
            if (key === 'emit') return f_emitCommand;
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        queueMicrotask(() => {
            if (disposed) return;
            child.emit('spawn');
            if (!children.has(child.pid) || state.terminating) return;
            try {
                // 所有命令先领取一次故障；等待逻辑与命令是否提供异步实现无关。
                const fault = cmd.pkg_takeFault(args);
                if (fault) {
                    // 私有方法：仅在本文件实现中使用，不导出。
                    const f_fire = () => {
                        if (disposed || !children.has(child.pid) || state.terminating) return;
                        if (fault.stderr) io.stderr.write(Buffer.from(fault.stderr));
                        f_finish(child, fault.exit ?? 1);
                    };
                    if (fault.wait instanceof Promise) fault.wait.then(f_fire, f_fire);
                    else f_fire();
                    return;
                }
                if (typeof cmd.pkg_impl.pkg_run === 'function') cmd.pkg_impl.pkg_run([...args], {
                    ...pkg_commandContext(contextOptions),
                    onDispose: cleanup => { state.cleanups.add(cleanup); },
                    onSignal: handler => { state.onSignal = handler; },
                }, io);
                else if (typeof cmd.pkg_impl.pkg_runSync === 'function') {
                    const result = cmd.pkg_runSync(args, pkg_commandContext(contextOptions), null);
                    if (result.stdout) io.stdout.write(result.stdout);
                    if (result.stderr) io.stderr.write(result.stderr);
                    f_finish(child, result.status ?? 0, result.signal ?? null);
                }
            } catch (error) {
                if (error instanceof ProcessExitError) f_finish(child, error.exitCode);
                else {
                    io.stderr.write(`${error.stack || error}\n`);
                    f_finish(child, 1);
                }
            }
        });
        return child;
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_spawnSync(command, args, options) {
        let cwd;
        ({ command, args, options, cwd } = f_spawnArguments(command, args, options));
        const input = f_inputBuffer(options.input, options.encoding);
        const contextOptions = { ...options, ...(cwd !== undefined || options.cwd === null ? { cwd } : {}) };
        const found = f_resolveCall(command, args, options, cwd, 'spawnSync');
        if (found.error || typeof found.cmd.pkg_impl.pkg_runSync !== 'function') {
            return { error: found.error || f_spawnError('spawnSync', command, args), status: null, signal: null,
                output: null, pid: 0, stdout: undefined, stderr: undefined };
        }
        let result;
        try {
            const context = pkg_commandContext(contextOptions);
            context.input = f_piped(options, 0) ? input : Buffer.alloc(0); // 保留原始 options，忽略的 stdin 不消费输入
            result = found.cmd.pkg_runSync(args, context);
        }
        catch (error) {
            result = error instanceof ProcessExitError
                ? { status: error.exitCode }
                : { status: 1, stderr: `${error.stack || error}\n` };
        }
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_encode = value => options.encoding && options.encoding !== 'buffer'
            ? Buffer.from(value || '').toString(options.encoding) : Buffer.from(value || '');
        const stdout = f_piped(options, 1) ? f_encode(result.stdout) : null;
        const stderr = f_piped(options, 2) ? f_encode(result.stderr) : null;
        return { status: result.status ?? 0, signal: result.signal ?? null, output: [null, stdout, stderr],
            pid: nextPid++, stdout, stderr };
    }
    return {
        spawn: f_spawn, spawnSync: f_spawnSync, calls,
        ...f_createExecMethods({ spawn: f_spawn, spawnSync: f_spawnSync, f_onDispose: (child, cleanup) => states.get(child)?.cleanups.add(cleanup) }),
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_dispose() {
            disposed = true;
            for (const child of children.values()) {
                const state = states.get(child);
                f_clearInterval(state.lifetime);
                state.lifetime = null;
                state.pending.length = 0;
                for (const cleanup of state.cleanups) cleanup(); // 同时回收执行适配层与命令的运行资源
            }
            children.clear();
        },
        // 自然退出和信号退出都除名，信号 0 仅检查进程是否存在。
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_signal(pid, sig = 'SIGTERM') {
            const name = f_signalName(sig);
            const child = children.get(Number(pid));
            return child ? f_deliverSignal(child, name) : false;
        },
    };
}

let f_memory = null; // 未设置 → 默认实现（原生 child_process）

const liteChildProcess = {
    // 统一执行入口：真实分支透传 child_process（生产行为不变）；内存分支见 f_createMemorySpawn
    // 外部方法：允许所有调用方使用，包括测试文件。
    spawn(...args) { return f_memory ? f_memory.spawn(...args) : realSpawn(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    spawnSync(...args) { return f_memory ? f_memory.spawnSync(...args) : realSpawnSync(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    exec(...args) { return f_memory ? f_memory.exec(...args) : realExec(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    execSync(...args) { return f_memory ? f_memory.execSync(...args) : realExecSync(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    execFile(...args) { return f_memory ? f_memory.execFile(...args) : realExecFile(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    execFileSync(...args) { return f_memory ? f_memory.execFileSync(...args) : realExecFileSync(...args); },
    // 设置内存实现；返回公共门面，不暴露私有运行态
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_mock() { f_memory ??= f_createMemorySpawn(); return liteChildProcess; },
    // 移除内存实现，回到真实 spawn；调用记录与在册子进程随实例一并丢弃
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_unmock() { f_memory?.f_dispose(); f_memory = null; },
    // 等待子进程 close 并取终态 { code, signal }——真实与内存子进程同口径（一次性事件 →
    // 可 await 的值的收敛包装，替代消费侧手写 new Promise + on('close')）；spawn 失败
    //（error 事件，如命令不存在）按拒绝收场。先取 Promise 再触发动作，监听时序才有保证
    // 外部方法：允许所有调用方使用，包括测试文件。
    waitForClose(child) {
        return new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
    },
    // pkg_signal(pid, sig)：内部信号投递——按 pid 向在册内存子进程发信号（能力上对应真实
    // world 的信号投递；kill 命令与 liteProcess.kill 经此投递，测试通过公共 kill 入口触发）。
    // 与替身子进程对象的 child.kill(sig)（ChildProcess#kill 对应面）共用投递原语。
    // 落在本门面是因为 pid 登记表随子进程创建在此（mgr/lite-process 反向导入会成环）；
    // 须先 t_mock()，返回是否送达
    // 内部方法：仅限同一 package 内模块协作，测试通过公共入口验证。
    pkg_signal(pid, sig = 'SIGTERM') {
        if (!f_memory)
            throw new Error('liteChildProcess.pkg_signal 需先 t_mock() 设置内存实现');
        return f_memory.f_signal(pid, sig);
    },
    // 调用历史（非执行历史）：spawn/spawnSync 调用按发生顺序入账——发生在边界，先于命令
    // 解析；派发失败（命令未装卷/未注册，未执行）的调用同样在列；须先 t_mock()
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_calls() {
        if (!f_memory)
            throw new Error('liteChildProcess.t_calls 需先 t_mock() 设置内存实现');
        return f_memory.calls.map(call => ({ ...call, args: [...call.args], options: { ...call.options } }));
    },
    // 统一清空所有命令的调用账本；命令配置、在册子进程与 PID 序列均保留
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_reset() {
        if (!f_memory)
            throw new Error('liteChildProcess.t_reset 需先 t_mock() 设置内存实现');
        f_memory.calls.length = 0;
    },
};

f_installExecPromisify(liteChildProcess.exec);
f_installExecPromisify(liteChildProcess.execFile);
export default liteChildProcess;
