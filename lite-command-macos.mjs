// lite-command-macos：macos 桌面/系统命令集（导入即向 lite-command 自注册）。
// open（含 /usr/bin/open 绝对路径形态）：Finder 打开等桌面动作——内存世界一律成功（真实
// 副作用本就不在测试断言面）。ls：桥接 lite-fs——读当前作用域（mock 即内存卷、未 mock 即
// 真实盘）的目标目录，回命令行形态的 stdout；lite-command 桥接其他 lite-xx 门面的样例
//（仅实现无参数/目录路径的名单形态，-l 等旗标口径按需再补）。
import liteFs from './lite-fs.mjs';
import liteCommand from './lite-command.mjs';

const openImpl = {
    run() {}, // 桌面动作：无输出即成功
    runSync() { return { status: 0, stdout: '', stderr: '' }; },
};
liteCommand.register('open', openImpl);
liteCommand.register('/usr/bin/open', openImpl);

liteCommand.register('ls', {
    run() {},
    runSync(argv) {
        const target = argv.find(a => typeof a === 'string' && !String(a).startsWith('-')) || '.';
        try {
            const names = liteFs.readdirSync(target);
            return { status: 0, stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
        } catch (error) {
            return { status: 1, stdout: '', stderr: `ls: ${target}: ${error.code || '错误'}\n` };
        }
    },
});

export default liteCommand;
