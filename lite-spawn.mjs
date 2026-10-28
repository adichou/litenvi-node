// lite-spawn：node:child_process spawn/spawnSync 的可切换门面（原 lite-process，按其替代的
// 原生方法更名）。默认（未设置内存实现）原样转发真实 spawn/spawnSync，生产行为不变。
// mock() 换内存实现：不真实起进程——(command, args) 分派给 lite-command 注册的命令集
//（lite-command-node：.mjs 进程内执行；lite-command-git：账本 + 脚本化回包；
// lite-command-macos：open/ls 等——未注册命令的 spawn 返回不执行的替身子进程、spawnSync
// 按失败收场并指引注册命令集）。调用入账（spawns() 供断言 command/args/options），返回
// 替身子进程（pid/stdout/stderr/unref/kill，消费面对齐真实 ChildProcess）；onSpawn(handler)
// 脚本化每次返回的子进程事件（输出、退出码），kill 触发 exit/close。命令集须由使用方显式
// 导入（导入即注册）。状态为模块级单例：同进程内经同一 specifier 导入（含动态 import）共享。
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import liteCommand from './lite-command.mjs';

function createMemorySpawn() {
    const calls = [];
    let script = null;
    function spawn(command, args = [], options = {}) {
        const call = { command, args: [...args], options: { ...options } };
        calls.push(call);
        const child = new EventEmitter();
        child.pid = 4200 + calls.length;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.unref = () => {}; // detached 守护进程消费面：no-op 而非 TypeError
        child.kill = (signal = 'SIGTERM') => {
            child.emit('exit', null, signal);
            child.emit('close', null, signal);
            return true;
        };
        // 命令集分派：注册了 run 的命令集接管子进程生命周期（node 的 .mjs 进程内执行等）
        const impl = liteCommand.implOf(command);
        if (typeof impl?.run === 'function')
            impl.run([...args], options, child, call);
        // 脚本化钩子延迟到微任务：真实子进程事件总是异步到达——同步触发会在调用方挂上监听前丢事件
        queueMicrotask(() => script?.(child, call));
        return child;
    }
    function spawnSync(command, args = [], options = {}) {
        const call = { command, args: [...args], options: { ...options } };
        calls.push(call);
        const impl = liteCommand.implOf(command);
        if (typeof impl?.runSync === 'function')
            return impl.runSync([...args], options, call);
        return { status: 1, stdout: '', stderr: `lite-spawn 内存实现未注册命令：${command}（导入对应 lite-command-xx 命令集）\n` };
    }
    return {
        spawn,
        spawnSync,
        calls,
        // 脚本化钩子：每次 spawn 构造替身子进程后调用，测试可注入 stdout/stderr/exit/close 事件
        onSpawn(handler) { script = handler; },
    };
}

let memory = null; // 未设置 → 默认实现（真实 spawn/spawnSync）

const liteSpawn = {
    // 统一执行入口：真实分支透传 child_process（生产行为不变）；内存分支见 createMemorySpawn
    spawn(...args) { return memory ? memory.spawn(...args) : realSpawn(...args); },
    spawnSync(...args) { return memory ? memory.spawnSync(...args) : realSpawnSync(...args); },
    // 设置内存实现；返回该实现（spawns/onSpawn 已在门面上代理，一般无须直接持有）
    mock() { return memory ?? (memory = createMemorySpawn()); },
    // 移除内存实现，回到真实 spawn；调用记录与钩子随实例一并丢弃
    unmock() { memory = null; },
    // 已记录的 spawn/spawnSync 调用快照；须先 mock()
    spawns() {
        if (!memory)
            throw new Error('lite-spawn.spawns 需先 mock() 设置内存实现');
        return memory.calls.map(call => ({ ...call, options: { ...call.options } }));
    },
    // 脚本化钩子（测试注入子进程事件）；须先 mock()
    onSpawn(handler) {
        if (!memory)
            throw new Error('lite-spawn.onSpawn 需先 mock() 设置内存实现');
        memory.onSpawn(handler);
    },
};

export default liteSpawn;
