// lite-process：process 替身门面（有 mock/unmock）——cwd/chdir/argv/env/pid/execPath/exit/
// kill 的可切换门面。默认（未 mock）原样转发真实 process 对应能力，生产行为不变；
// mock({ cwd?, argv?, env?, pid? }) 进入假世界，unmock() 回真实透传（原生 argv 恢复）。
// chdir/exit/kill 转调对应命令实现（经 lite-cmd-mgr 动态查询，命令集须由使用方导入
// lite-cmd-os）：chdir → cd 命令（沿用目录校验，落点回写假世界 cwd）；exit → exit 命令
//（ProcessExitError 语义：退出码记录在案、向上抛出，由调用方决定收场——不静默吞掉）；
// kill → kill 命令（最终到 lite-child_process 的 signal 投递原语）。execPath 为固定字段：
// 假世界取 node 命令实现路径（lite-cmd-node 常量 '/mock-cmd/usr/local/bin/node'），真实世界
// 为 process.execPath。pid/platform/version 只读合理缺省（进程内执行：未显式给 pid 时与宿主
// 同 pid，platform/version 与本机同源）。
// 无 on/inject（事件与故障注入归命令模块——mgr.inject）。installArgv 子进程口径安装保留：
// 门面视图与原生 process.argv 同步替换、unmock 恢复原值；未 mock 场景 no-op（真实进程的
// argv 不可伪造）。
// 依赖方向（无环）：lite-process → lite-cmd-mgr（kill/exit/chdir 命令动态查询）+ lite-cmd-node
//（execPath 常量）；命令注册表与模拟执行统一在 lite-cmd-mgr——lite-child_process 派遣命令
// 实现时经 commandContext 把进程面能力（cwd/env/argv 安装/退出记录）以 ctx 传入，命令集
// 不再依赖本模块。
import path from 'node:path';
import { constants } from 'node:os';
import liteFs from './lite-fs.mjs';
import mgr, { ProcessExitError } from './lite-cmd-mgr.mjs';
import { NODE_COMMAND_PATH } from './lite-cmd-node.mjs';

export { ProcessExitError };

let world = null; // 未设置 → 默认实现（真实 process 透传）；{ cwd, argv, argvOriginal?, env, pid, exitCodes }

// 命令执行上下文（ctx）：lite-child_process 派遣命令实现时传入——进程面能力经 ctx 下发，
// 命令集（lite-cmd-node/-git/-os）不依赖 lite-process。env 单轨：假世界未显式给 env 时直接
// 引用真实 process.env（spawn options.env 的合并对入口模块加载期可见——与真实 spawn 子进程
// 继承环境同口径）；显式给 env 才形成隔离对象。setCwd 仅假世界提供（真实进程 cwd 不经命令
// 面改写——真实子进程改不了父进程 cwd）
export function commandContext(options = {}) {
    return {
        options,
        cwd: () => options.cwd === undefined ? liteProcess.cwd() : path.resolve(liteProcess.cwd(), options.cwd),
        setCwd: world ? (dir) => { world.cwd = dir; } : undefined,
        env: world ? world.env : process.env,
        execPath: world ? NODE_COMMAND_PATH : process.execPath,
        installArgv: (argv) => liteProcess.installArgv(argv), // 真实世界 no-op（原生 argv 不可伪造）
        recordExit: (code) => { if (world) world.exitCodes.push(code); },
    };
}

export const liteProcess = {
    cwd() { return world ? world.cwd : process.cwd(); },
    // 目录校验与切换在 cd 命令实现（lite-cmd-os）：本门面转调并按其回包还原 ENOENT 错误口径
    //（假世界内 path.resolve 解析、目标须为目录——真实 chdir 同语义）
    chdir(dir) {
        if (!world) return process.chdir(dir);
        const cd = mgr.command('cd');
        if (!cd || typeof cd.impl.runSync !== 'function')
            throw new Error('liteProcess.chdir 假世界需要 cd 命令（导入 lite-cmd-os）');
        const result = cd.runSync([String(dir)], commandContext());
        if (result.status !== 0) {
            const target = path.resolve(world.cwd, String(dir));
            let code = 'ENOENT';
            try { if (!liteFs.statSync(target).isDirectory()) code = 'ENOTDIR'; }
            catch (cause) { code = cause.code || code; }
            const reason = code === 'ENOTDIR' ? 'not a directory' : 'no such file or directory';
            const error = new Error(`${code}: ${reason}, chdir '${world.cwd}' -> '${dir}'`);
            error.code = code;
            error.errno = -(constants.errno[code] || constants.errno.ENOENT);
            error.syscall = 'chdir';
            error.path = world.cwd;
            error.dest = dir;
            throw error;
        }
    },
    get argv() { return world ? world.argv : process.argv; },
    // 环境面（假世界可写对象：构造时给、运行中改；未显式给时与真实 process.env 单轨同源）
    get env() { return world ? world.env : process.env; },
    get pid() { return world ? world.pid : process.pid; },
    get platform() { return process.platform; }, // 只读合理缺省：进程内执行，与本机同源
    get version() { return process.version; },
    // 固定字段：假世界为 node 命令实现路径（lite-cmd-node），真实世界透传
    get execPath() { return world ? NODE_COMMAND_PATH : process.execPath; },
    // 虚拟 argv 覆盖（仅假世界生效）：门面视图与原生 process.argv 同步替换——入口的主模块
    // 守卫与命令解析读的是原生 process.argv，只换门面视图入口看不到；unmock 恢复原值。
    // 未 mock 场景为 no-op（真实进程的 argv 不可伪造）
    installArgv(argv) {
        if (!world) return;
        world.argv = [...argv];
        if (!world.argvOriginal) world.argvOriginal = process.argv;
        process.argv = [...argv];
    },
    // 退出意图经 exit 命令实现（lite-cmd-os）：记录退出码并上抛 ProcessExitError——保守口径：
    // 退出意图可见可捕获（进程内执行场景下真实 process.exit 会杀死宿主测试进程；不选静默吞掉，
    // 失败必须暴露）
    exit(code = 0) {
        if (!world) return process.exit(code);
        const exitCommand = mgr.command('exit');
        if (!exitCommand || typeof exitCommand.impl.runSync !== 'function')
            throw new Error('liteProcess.exit 假世界需要 exit 命令（导入 lite-cmd-os）');
        exitCommand.runSync([String(code)], commandContext()); // 上抛 ProcessExitError
    },
    exitCodes() { return world ? [...world.exitCodes] : []; },
    // 信号投递经 kill 命令实现（lite-cmd-os → lite-child_process 的 signal 原语）：成功 true、
    // 无此进程按真实 process.kill 口径抛 ESRCH
    kill(pid, signal = 'SIGTERM') {
        if (!world) return process.kill(pid, signal);
        const killCommand = mgr.command('kill');
        if (!killCommand || typeof killCommand.impl.runSync !== 'function')
            throw new Error('liteProcess.kill 假世界需要 kill 命令（导入 lite-cmd-os）');
        const argv = typeof signal === 'number'
            ? [`-${signal}`, String(pid)]
            : ['-s', String(signal), String(pid)];
        const result = killCommand.runSync(argv, commandContext());
        if (result.status !== 0) {
            const error = new Error('kill ESRCH');
            error.code = 'ESRCH';
            error.errno = -constants.errno.ESRCH;
            error.syscall = 'kill';
            throw error;
        }
        return true;
    },
    // 进入假世界：cwd 为初始当前目录（当前目录语义，chdir 后变化）；argv/env/pid 可选（缺省
    // argv 取原生 argv、env 与真实 process.env 单轨同源、pid 与宿主同值）。不建目录、不依赖
    // lite-fs。重复调用返回既有世界（同 lite 家族 mock 口径）
    mock({ cwd, argv, env, pid } = {}) {
        if (world) return world;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
            throw new Error('liteProcess.mock 需要 cwd（初始当前目录的绝对路径）');
        world = {
            cwd: path.resolve(cwd),
            argv: [...(argv || process.argv)],
            env: env ?? process.env,
            pid: Number.isInteger(pid) ? pid : process.pid,
            exitCodes: [],
        };
        return world;
    },
    unmock() {
        if (world?.argvOriginal) process.argv = world.argvOriginal; // 恢复原生 argv
        world = null;
    },
};
