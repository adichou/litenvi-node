// lite-command-git：git 命令集（导入即向 lite-command 自注册）——spawnSync('git', argv)
// 的内存实现。调用入账（runs() 供断言 argv/options），回包经 onRun 钩子注入（返回
// { status, stdout, stderr } 覆盖默认值）；未命中按 { status: 0, stdout: '', stderr: '' }
// 收场（对齐 spawnSync utf8 结果形状）。reset() 清账本保留钩子（进程级共享下按用例隔离
// 观测基线）。本命令集只提供机制；世界级 git 语义（分支账本、log 合成、porcelain 口径等）
// 由测试世界经 onRun 安装。状态为模块级单例：同进程内经同一 specifier 导入共享。
import liteCommand from './lite-command.mjs';

const runs = [];
let script = null;

liteCommand.register('git', {
    runSync(argv, options) {
        const call = { argv: [...argv], options: { ...options } };
        runs.push(call);
        const injected = script?.(call);
        return { status: 0, stdout: '', stderr: '', ...(injected || {}) };
    },
});

const liteCommandGit = {
    // 已记录的 git 调用快照（argv/options 拷贝）
    runs() { return runs.map(r => ({ ...r })); },
    // 脚本化钩子：每次 run 入账后同步调用；按 argv 返回 { status, stdout, stderr } 注入回包
    onRun(handler) { script = handler; },
    // 清空调用账本（保留 onRun 钩子）
    reset() { runs.length = 0; },
};

export default liteCommandGit;
