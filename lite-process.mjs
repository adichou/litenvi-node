// lite-process：node:child_process spawn 的可切换门面，机制与 lite-http 一致。业务代码统一
// 经本模块 spawn——默认（未设置内存实现）原样转发真实 spawn，生产行为不变。mock() 设置内存
// 实现（幂等：已设置时复用当前实例）、unmock() 移除回到真实实现（调用记录与钩子随实例丢弃）。
// 内存实现不真实起进程：调用入账（spawns() 供断言 command/args/options），返回替身子进程
//（pid/stdout/stderr/unref/kill，消费面对齐真实 ChildProcess）；.mjs 入口在本进程内执行
//（lite-server 能力：内存路由到对应代码，配合 lite-http 内存实现提供正确回包）；onSpawn
//（handler) 脚本化每次返回的子进程事件（输出、退出码），kill 触发 exit/close。状态为模块级
// 单例：同进程内经同一 specifier 导入（含动态 import）共享同一实例。
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function createMemoryProcess() {
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
        // 内存执行（lite-server 能力）：.mjs 入口在本进程动态 import——真实源码、真实依赖图；
        // 入口自建的 http 服务经 lite-http 门面落内存路由（loopback 请求即得真实路由回包）。
        // options.env 先落 process.env（子进程环境近似，入口模块加载期可读 ATB_PORT 等）；
        // cwd 不仿真。入口加载失败按子进程异常退出收场（stderr + exit 1）。
        const entry = args.find(a => typeof a === 'string' && a.endsWith('.mjs'));
        if (entry) {
            Object.assign(process.env, options.env ?? {});
            import(pathToFileURL(path.resolve(entry)).href)
                .catch(error => {
                child.stderr.emit('data', Buffer.from(String(error?.message || error)));
                child.emit('exit', 1, null);
                child.emit('close', 1, null);
            });
        }
        // 脚本化钩子延迟到微任务：真实子进程事件总是异步到达——同步触发会在调用方挂上监听前丢事件
        queueMicrotask(() => script?.(child, call));
        return child;
    }
    return {
        spawn,
        calls,
        // 脚本化钩子：每次 spawn 构造替身子进程后调用，测试可注入 stdout/stderr/exit/close 事件
        onSpawn(handler) { script = handler; },
    };
}

let memory = null; // 未设置 → 默认实现（真实 spawn）

const liteProcess = {
    spawn(...args) { return memory ? memory.spawn(...args) : realSpawn(...args); },
    // 设置内存实现；返回该实现（spawns/onSpawn 已在门面上代理，一般无须直接持有）
    mock() { return memory ?? (memory = createMemoryProcess()); },
    // 移除内存实现，回到真实 spawn；调用记录与钩子随实例一并丢弃
    unmock() { memory = null; },
    // 已记录的 spawn 调用快照；须先 mock()
    spawns() {
        if (!memory)
            throw new Error('lite-process.spawns 需先 mock() 设置内存实现');
        return memory.calls.map(call => ({ ...call, options: { ...call.options } }));
    },
    // 设置子进程脚本化钩子；须先 mock()
    onSpawn(handler) {
        if (!memory)
            throw new Error('lite-process.onSpawn 需先 mock() 设置内存实现');
        memory.onSpawn(handler);
    },
};

export default liteProcess;
