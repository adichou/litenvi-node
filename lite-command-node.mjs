// lite-command-node：node / npm 命令集（导入即向 lite-command 自注册）。
// node run（异步面）：.mjs 入口在本进程内执行（lite-server 能力由来）——动态 import 真实
// 入口源码与依赖图，入口自建的 http 服务经 lite-server 落内存路由（loopback 请求即得真实
// 路由回包）。options.env 先落 process.env（子进程环境近似，入口模块加载期可读 ATB_PORT
// 等）；cwd 不仿真。入口加载失败按子进程异常退出收场（stderr + exit 1）。node 的同步面
//（spawnSync('node', ...)）仅支持 `-v` 探测；入口执行是异步 import，同步等待不适用——
// 同步执行 CLI 的调用方应改用 spawn。
// npm runSync：`-v` 版本探测按本机 process.version 同源回包，其余参数未实现按失败收场。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import liteCommand from './lite-command.mjs';

liteCommand.register('node', {
    run(args, options, child) {
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
    },
    runSync(args) {
        if (args.includes('-v')) return { status: 0, stdout: `${process.version}\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: 'lite-command-node：node 入口的同步执行未实现（import 是异步的），请改用 spawn\n' };
    },
});

liteCommand.register('npm', {
    runSync(args) {
        if (args.includes('-v')) return { status: 0, stdout: `${process.version.replace('v', '')}.0.0\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: 'lite-command-node：npm 该参数未实现内存语义\n' };
    },
});

export default liteCommand;
