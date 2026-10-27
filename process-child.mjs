// 原生试点虚拟 Node 子进程运行器：父世界（environment.mjs 的 spawnNativeNodeChild）fork 本
// 进程并经 IPC 发来一次装配消息——以 fork 时快照（fs / Git / 时钟）重建世界，在全新模块缓存
// 中执行真实入口源码，stdout / stderr 逐块回流，退出码与最终世界快照随 done 消息回流。
// 本进程只做协议搬运，世界语义全部在 environment.mjs（runChildWorld）内，两端口径不复制。
import { runChildWorld } from './environment.mjs';

const host = process;
const send = (message) => new Promise((resolve, reject) => host.send(message, (error) => (error ? reject(error) : resolve())));
let finished = false;

async function run(init) {
    const result = await runChildWorld({
        ...init,
        // 参数规范化在此完成：runChildWorld 形参无默认值（契约文件分支最小化）
        env: init.env ?? {}, files: init.files ?? {}, git: init.git ?? null, args: init.args ?? [], cwd: init.cwd ?? init.projectRoot,
        // 输出流：子世界写 stdout / stderr 即时回流父世界（父侧再按子进程事件面转发）。
        onStream: (channel, text) => { host.send({ stream: channel, chunk: text }); },
    });
    finished = true;
    await send({ done: true, ...result });
}

host.on('message', async (init) => {
    try {
        await run(init);
    }
    catch (error) {
        // 装配层失败（世界都没建起来）：如实回流，不伪装成功。
        finished = true;
        await send({ done: true, exitCode: 1, files: {}, git: null,
            unexpected: [`子进程装配失败：${error.message}`] }).catch(() => {});
    }
    host.disconnect();
});

// 世界之外的意外崩溃（未被 runChildWorld 捕获的宿主层异常）：尽力回报后按非零退出收场。
host.on('uncaughtException', (error) => {
    const report = () => (finished ? Promise.resolve() : send({ done: true, exitCode: 1, files: {}, git: null,
        unexpected: [`子进程未捕获异常：${error.message}`] }));
    report().catch(() => {}).finally(() => host.exit(1));
});
