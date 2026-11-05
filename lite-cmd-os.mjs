// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-os：OS 命令集——open/ls/pwd/cwd/kill + 常用文件命令（mkdir/rm/cp/mv/cat/touch/
// test，桥接 lite-fs）+ shell 内建 cd/exit，导入即向 lite-cmd-mgr 登记（/mock-cmd/ 命名空间：
// open/kill 在 usr/bin，其余基础命令与内建在 bin）。本模块不再依赖 lite-process：进程面能力
//（当前目录读取、cwd 切换落点、退出意图记录）经 ctx 传入——lite-child_process 派遣时由
// lite-process 侧构建，lite-process 的 chdir/exit/kill 转调本命令集对应命令实现。
// 命令集——open（含 /usr/bin/open 绝对路径形态，经 mgr 前缀映射）：Finder 打开等桌面动作，
// 内存世界一律成功（真实副作用本就不在测试断言面）；ls：桥接 lite-fs，读当前作用域（mock 即
// 内存卷、未 mock 即真实盘）的目标目录，回命令行形态的 stdout；pwd / cwd：回显当前工作目录
//（ctx.cwd()：假世界虚拟 cwd / 真实 process.cwd()）。cd（shell 内建）：沿用 process 替身的
// chdir 校验（目标须为存在的目录，相对路径按当前 cwd 解析），落点经 ctx.setCwd 回写进程环境
// 面——假世界外（liteProcess 未 mock）ctx.setCwd 缺席，按失败收场（真实子进程改不了父进程
// cwd，spawn 形态语义本就不成立）。exit（shell 内建）：沿用 pkg_ProcessExitError 语义——同步面
// 记录退出意图（ctx.recordExit）并上抛 pkg_ProcessExitError（退出意图可见可捕获，由调用方决定
// 收场；liteProcess.exit 转调口径），异步面按子进程以该码退出收场（真实子进程调 exit(n) 即
// 以 n 退出，不外抛）。
// kill：向内存子进程发信号（桥接 lite-child_process 的 pid 登记表与 signal 投递原语）；
// liteProcess.kill 假世界转调本命令实现。
import path from 'node:path';
import liteFs from './lite-fs.mjs';
import liteChildProcess from './lite-child_process.mjs';
import { pkg_ProcessExitError } from './lite-cmd-mgr.mjs';

const f_openImpl = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(_argv, _ctx, child) { f_emitCli(child, { status: 0 }); }, // 桌面动作：无输出，正常退出
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync() { return { status: 0, stdout: '', stderr: '' }; },
};
const f_osCommands = {};
f_osCommands['/mock-cmd/usr/bin/open'] = f_openImpl;

// ---------- 常用文件命令（桥接 lite-fs：作用域随其 mock 状态——内存卷或真实盘） ----------
// 参数口径对齐 POSIX 常用形态；错误按真实命令行风格 status 1 + stderr `<cmd>: <path>: <原因>`。
// 异步面统一微任务延迟回事件（对齐真实子进程时序：进程不可能在 spawn 返回前退出）

// 命令异步面的统一出口：stdout/stderr（可空）+ 退出码
// 私有方法：仅在本文件实现中使用，不导出。
function f_emitCli(child, { status, stdout = '', stderr = '' }) {
    queueMicrotask(() => {
        if (stdout) child.stdout.write(Buffer.from(stdout));
        if (stderr) child.stderr.write(Buffer.from(stderr));
        child.emit('exit', status, null);
        child.emit('close', status, null);
    });
}
// 私有方法：仅在本文件实现中使用，不导出。
const f_flagsOf = (argv) => argv.filter(a => String(a).startsWith('-') && a !== '-');
// 私有方法：仅在本文件实现中使用，不导出。
const f_operandsOf = (argv) => argv.filter(a => !String(a).startsWith('-'));

// 命令实现统一入口：pkg_runSync(argv) → { status, stdout?, stderr? }
// 私有方法：仅在本文件实现中使用，不导出。
function f_errorReason(error) {
    return { ENOENT: 'No such file or directory', EEXIST: 'File exists', ENOTDIR: 'Not a directory',
        EISDIR: 'Is a directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted',
        ENOTEMPTY: 'Directory not empty' }[error.code] || error.code || '错误';
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_failCli(cmd, target, reason) {
    return { status: 1, stderr: `${cmd}: ${target}: ${reason}\n` };
}
// 多路径命令遇到单个失败仍处理后续路径，保留全部诊断与最终失败状态。
// 私有方法：仅在本文件实现中使用，不导出。
function f_eachOperand(cmd, targets, action) {
    const result = { status: 0, stderr: '' };
    for (const target of targets) {
        let failure;
        try { failure = action(target); }
        catch (error) { failure = f_failCli(cmd, target, f_errorReason(error)); }
        if (failure?.status) { result.status = 1; result.stderr += failure.stderr; }
    }
    return result;
}
const f_fileCommands = {
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    echo(argv) {
        // POSIX echo：参数按空格拼接 + 换行收尾（-n 抑制尾换行的常用形态支持）
        const noNewline = argv[0] === '-n';
        const text = (noNewline ? argv.slice(1) : argv).join(' ');
        return { status: 0, stdout: noNewline ? text : `${text}\n` };
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    mkdir(argv, ctx) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const recursive = argv.some(a => /^-[pm]*p/.test(String(a)));
        const dirs = f_operandsOf(argv);
        if (!dirs.length) return { status: 1, stderr: 'usage: mkdir [-p] directory ...\n' };
        return f_eachOperand('mkdir', dirs, dir => {
            liteFs.mkdirSync(path.resolve(ctx.cwd(), dir), { recursive });
        });
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    rm(argv, ctx) {
        const flags = f_flagsOf(argv).join('');
        const recursive = /r/i.test(flags), force = /f/i.test(flags);
        const paths = f_operandsOf(argv);
        if (!paths.length) return force ? { status: 0 } : { status: 1, stderr: 'usage: rm [-rf] file ...\n' };
        return f_eachOperand('rm', paths, target => {
            const filename = path.resolve(ctx.cwd(), target);
            // 非递归 rm 不删除目录，包括空目录。
            if (!recursive && liteFs.existsSync(filename) && liteFs.statSync(filename).isDirectory())
                return f_failCli('rm', target, 'is a directory');
            liteFs.rmSync(filename, { recursive, force });
        });
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    cp(argv, ctx) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const recursive = argv.some(a => /^-[rR]/.test(String(a)));
        const [src, dst, ...extra] = f_operandsOf(argv);
        if (!src || !dst || extra.length) return { status: 1, stderr: 'usage: cp [-r] source target\n' };
        const from = path.resolve(ctx.cwd(), src);
        let source;
        try { source = liteFs.statSync(from); }
        catch (error) { return f_failCli('cp', src, f_errorReason(error)); }
        if (source.isDirectory() && !recursive)
            return { status: 1, stderr: `cp: ${src} is a directory (not copied).\n` };
        let target = dst;
        try {
            const to = path.resolve(ctx.cwd(), dst);
            if (liteFs.existsSync(to) && liteFs.statSync(to).isDirectory()) target = path.join(dst, path.basename(src));
            const filename = path.resolve(ctx.cwd(), target);
            // cpSync 的递归实现可创建祖先；命令行 cp 要求目标父目录已经存在。
            liteFs.statSync(path.dirname(filename));
            if (recursive) liteFs.cpSync(from, filename, { recursive: true });
            else liteFs.copyFileSync(from, filename);
        } catch (error) { return f_failCli('cp', target, f_errorReason(error)); }
        return { status: 0 };
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    mv(argv, ctx) {
        const [src, dst, ...extra] = f_operandsOf(argv);
        if (!src || !dst || extra.length) return { status: 1, stderr: 'usage: mv source target\n' };
        let target = dst;
        try {
            const to = path.resolve(ctx.cwd(), dst);
            if (liteFs.existsSync(to) && liteFs.statSync(to).isDirectory()) target = path.join(dst, path.basename(src));
            liteFs.renameSync(path.resolve(ctx.cwd(), src), path.resolve(ctx.cwd(), target));
        } catch (error) { return f_failCli('mv', `rename ${src} to ${target}`, f_errorReason(error)); }
        return { status: 0 };
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    cat(argv, ctx) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const files = argv.filter(a => a === '-' || !String(a).startsWith('-'));
        if (!files.length) files.push('-');
        const chunks = [];
        let consumed = false;
        let stderr = '';
        for (const f of files) {
            if (f === '-') {
                if (!consumed) chunks.push(ctx.input || Buffer.alloc(0));
                consumed = true;
                continue;
            }
            try { chunks.push(liteFs.readFileSync(path.resolve(ctx.cwd(), f))); }
            catch (error) { stderr += f_failCli('cat', f, f_errorReason(error)).stderr; }
        }
        return { status: stderr ? 1 : 0, stdout: Buffer.concat(chunks), stderr };
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    touch(argv, ctx) {
        const files = f_operandsOf(argv);
        if (!files.length) return { status: 1, stderr: 'usage: touch file ...\n' };
        return f_eachOperand('touch', files, f => {
            const filename = path.resolve(ctx.cwd(), f);
            if (!liteFs.existsSync(filename)) liteFs.writeFileSync(filename, '');
        });
    },
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    test(argv, ctx) {
        // 单条件口径：test -f|-d|-e path（退出码即判定，无输出）
        if (!argv.length) return { status: 1 };
        const flag = f_flagsOf(argv)[0];
        const target = f_operandsOf(argv)[0];
        if (! ['-f', '-d', '-e'].includes(String(flag)) || !target) return { status: 1, stderr: 'usage: test -f|-d|-e path\n' };
        let st = null;
        try { st = liteFs.statSync(path.resolve(ctx.cwd(), target)); } catch { /* 不存在 */ }
        const ok = flag === '-e' ? st !== null : flag === '-f' ? st?.isFile() === true : st?.isDirectory() === true;
        return { status: ok ? 0 : 1 };
    },
};

// 异步 cat 直接消费 stdin；EOF 到达后才处理后续文件并退出，保留输入的原始字节。
// 私有方法：仅在本文件实现中使用，不导出。
function f_runCat(argv, ctx, child) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const files = argv.filter(a => a === '-' || !String(a).startsWith('-'));
    if (!files.length) files.push('-');
    let index = 0;
    let consumed = false;
    let status = 0;
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_next = () => {
        while (index < files.length) {
            const file = files[index++];
            if (file === '-') {
                if (consumed || !child.stdin) continue;
                consumed = true;
                child.stdin.on('data', chunk => child.stdout.write(chunk));
                child.stdin.once('end', f_next);
                return;
            }
            try { child.stdout.write(liteFs.readFileSync(path.resolve(ctx.cwd(), file))); }
            catch (error) { status = 1; child.stderr.write(f_failCli('cat', file, f_errorReason(error)).stderr); }
        }
        f_emitCli(child, { status });
    };
    f_next();
}

for (const [name, impl] of Object.entries(f_fileCommands)) {
    f_osCommands[`/mock-cmd/bin/${name}`] = {
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        pkg_run(argv, ctx, child) {
            if (name === 'cat') f_runCat(argv, ctx, child);
            else f_emitCli(child, impl(argv, ctx));
        },
        // 回包统一补全 spawnSync utf8 形状（实现可只回部分字段）
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        pkg_runSync(argv, ctx) { return { status: 0, stdout: '', stderr: '', ...impl(argv, ctx) }; },
    };
}

// kill：向内存子进程发信号（桥接 lite-child_process 的 pid 登记表）——支持 `kill pid`（默认
// SIGTERM）、`kill -<SIGNAME> pid`、`kill -<num> pid`（常见号位映射）、`kill -s <SIGNAME> pid`；
// 无此进程按真实 kill 口径 status 1 + stderr 提示
// 私有方法：仅在本文件实现中使用，不导出。
function f_killRunImpl(argv) {
    let sig = 'SIGTERM';
    const rest = [...argv];
    const head = String(rest[0] ?? '');
    if (head.startsWith('-')) {
        rest.shift();
        if (head === '-s') sig = String(rest.shift() ?? '');
        else if (/^-\d+$/.test(head)) sig = Number(head.slice(1));
        else sig = head.slice(1);
    }
    if (/^\d+$/.test(String(sig))) sig = Number(sig);
    else if (typeof sig === 'string' && !sig.startsWith('SIG')) sig = `SIG${sig.toUpperCase()}`;
    const pid = Number(rest[0]);
    if (!Number.isInteger(pid) || pid <= 0)
        return { status: 1, stdout: '', stderr: 'usage: kill [-s sigspec | -signum] pid\n' };
    if (!liteChildProcess.pkg_signal(pid, sig))
        return { status: 1, stdout: '', stderr: `kill: ${pid}: No such process\n` };
    return { status: 0, stdout: '', stderr: '' };
}
f_osCommands['/mock-cmd/usr/bin/kill'] = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(argv, _ctx, child) {
        // 微任务延迟对齐真实子进程事件时序（同步 emit 会在调用方挂上监听前丢事件）；
        // 成功静默、失败回 stderr 与非零退出码（真实 kill 口径）
        queueMicrotask(() => {
            const r = f_killRunImpl(argv);
            if (r.stderr) child.stderr.write(Buffer.from(r.stderr));
            child.emit('exit', r.status, null);
            child.emit('close', r.status, null);
        });
    },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync(argv) { return f_killRunImpl(argv); },
};

f_osCommands['/mock-cmd/bin/ls'] = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(argv, ctx, child) { f_emitCli(child, this.pkg_runSync(argv, ctx)); },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync(argv, ctx) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const target = argv.find(a => typeof a === 'string' && !String(a).startsWith('-')) || '.';
        try {
            const filename = path.resolve(ctx.cwd(), target);
            if (!liteFs.statSync(filename).isDirectory()) return { status: 0, stdout: `${target}\n`, stderr: '' };
            const flags = f_flagsOf(argv).join('');
            // 私有方法：仅在本文件实现中使用，不导出。
            const names = liteFs.readdirSync(filename).filter(name => /[aA]/.test(flags) || !name.startsWith('.'));
            if (flags.includes('a')) names.push('.', '..');
            names.sort(); // C 语言环境下按名称排序，管道输出为逐行名单
            return { status: 0, stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
        } catch (error) {
            const reason = f_errorReason(error);
            return { status: 1, stdout: '', stderr: `ls: ${target}: ${reason}\n` };
        }
    },
};

const f_pwdImpl = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(_argv, ctx, child) {
        // 异步面回显同 pkg_runSync：微任务延迟对齐真实子进程事件时序（同步 emit 会在调用方挂上监听前丢事件）
        queueMicrotask(() => {
            child.stdout.write(Buffer.from(`${ctx.cwd()}\n`));
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        });
    },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync(_argv, ctx) { return { status: 0, stdout: `${ctx.cwd()}\n`, stderr: '' }; },
};
f_osCommands['/mock-cmd/bin/pwd'] = f_pwdImpl;
f_osCommands['/mock-cmd/bin/cwd'] = f_pwdImpl;

// cd（shell 内建）：校验沿用 process 替身的 chdir 口径——目标按当前 cwd 解析且须为存在的目录；
// 落点经 ctx.setCwd 回写进程环境面（假世界）。假世界外 ctx.setCwd 缺席按失败收场（真实子进程
// 改不了父进程 cwd）
// 私有方法：仅在本文件实现中使用，不导出。
function f_cdRunImpl(argv, ctx) {
    const dir = f_operandsOf(argv)[0];
    if (!dir) return { status: 1, stdout: '', stderr: 'usage: cd directory\n' };
    if (typeof ctx.setCwd !== 'function')
        return { status: 1, stdout: '', stderr: `cd: ${dir}: 假世界外不可切换（liteProcess.t_mock 后生效）\n` };
    const target = path.resolve(ctx.cwd(), String(dir));
    let st = null;
    try { st = liteFs.statSync(target); } catch { /* 不存在：按 No such file or directory 收场 */ }
    if (!st || !st.isDirectory())
        return { status: 1, stdout: '', stderr: `cd: ${dir}: No such file or directory\n` };
    ctx.setCwd(target);
    return { status: 0, stdout: '', stderr: '' };
}
f_osCommands['/mock-cmd/bin/cd'] = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(argv, ctx, child) { f_emitCli(child, f_cdRunImpl(argv, ctx)); },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync(argv, ctx) { return f_cdRunImpl(argv, ctx); },
};

// exit（shell 内建）：同步面记录退出意图并上抛 pkg_ProcessExitError（liteProcess.exit 转调口径——
// 退出意图可见可捕获，由调用方决定收场）；异步面按子进程以该码退出收场（spawn 派遣层把
// pkg_ProcessExitError 转换为子进程退出码——真实子进程调 exit(n) 即以 n 退出）
// 私有方法：仅在本文件实现中使用，不导出。
const f_exitCodeOf = (argv) => {
    const n = Number.parseInt(String(argv[0] ?? '0'), 10);
    return Number.isInteger(n) ? n : 0;
};
f_osCommands['/mock-cmd/bin/exit'] = {
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_run(argv, ctx, child) {
        const code = f_exitCodeOf(argv);
        ctx.recordExit(code);
        f_emitCli(child, { status: code & 255 });
    },
    // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
    pkg_runSync(argv, ctx) {
        const code = f_exitCodeOf(argv);
        ctx.recordExit(code);
        throw new pkg_ProcessExitError(code & 255);
    },
};

// 命令表导出（纯定义、零副作用）：系统级命令集由 lite-cmd-mgr 导入时自动协同加载注册。
// 显式 import 本模块无副作用（kill 需要的 signal 在 lite-child_process，模块内已 import）。
// 内部导出：仅供 mgr 登记命令实现，测试通过 child_process 的公共入口验证。
export const pkg_COMMANDS = f_osCommands;
