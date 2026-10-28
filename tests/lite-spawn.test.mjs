// lite-spawn 门面用例（原 lite-process 更名）：默认转发真实 node:child_process 的
// spawn/spawnSync；mock() 设置内存实现——不真实起进程，(command, args) 分派给 lite-command
// 注册的命令集（node → .mjs 进程内执行 / git → lite-command-git 账本 / ls → lite-fs 桥接），
// 未注册命令 spawn 返回不执行的替身子进程、spawnSync 按失败收场；调用入账（spawns() 断言），
// 子进程事件可经 onSpawn 脚本化，kill 触发 exit/close；unmock() 回到真实实现。
import assert from 'node:assert/strict';
import liteSpawn from '../lite-spawn.mjs';
import liteCommandGit from '../lite-command-git.mjs';
import '../lite-command-node.mjs'; // 导入即注册
import '../lite-command-macos.mjs'; // 导入即注册
import { runCases } from './run-cases.mjs';

await runCases([
    /** 场景：默认真实实现；输入：未 mock 时 spawn 真实 node 空脚本；预期：真实子进程 close 退出码 0。 */
    async function defaultDelegatesToRealSpawn() {
        const code = await new Promise((resolve, reject) => {
            const child = liteSpawn.spawn(process.execPath, ['-e', '']);
            child.on('error', reject);
            child.on('close', status => resolve(status));
        });
        assert.equal(code, 0, '真实 spawn 应执行真实子进程并以 0 退出');
    },
    /** 场景：内存实现记录调用；输入：mock 后 spawn 守护进程形状参数；预期：调用入账、child 有 pid/unref，不起真实进程。 */
    async function mockRecordsCallsWithoutRealProcess() {
        liteSpawn.mock();
        try {
            const child = liteSpawn.spawn('/mock/node', ['/app/server.mjs'], { cwd: '/app', env: { ATB_PORT: '18888' }, detached: true });
            child.unref(); // detached 守护进程消费面应为 no-op 而非 TypeError
            assert.equal(typeof child.pid, 'number', '替身子进程应带 pid');
            assert.equal(liteSpawn.spawns().length, 1, 'spawn 调用应入账');
            const call = liteSpawn.spawns()[0];
            assert.equal(call.command, '/mock/node', 'command 应如实记录');
            assert.deepEqual(call.args, ['/app/server.mjs'], 'args 应如实记录');
            assert.equal(call.options.env.ATB_PORT, '18888', 'options 应如实记录');
        }
        finally {
            liteSpawn.unmock();
        }
    },
    /** 场景：脚本化钩子；输入：onSpawn 注入 stdout 输出与退出事件；预期：消费面按事件序收到输出与退出码。 */
    async function onSpawnScriptsChildEvents() {
        liteSpawn.mock();
        try {
            liteSpawn.onSpawn((child) => {
                child.stdout.emit('data', Buffer.from('board up\n'));
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
            });
            const result = await new Promise((resolve) => {
                let output = '';
                const child = liteSpawn.spawn('/mock/node', ['/app/server.mjs']);
                child.stdout.on('data', c => { output += c; });
                child.on('close', code => resolve({ code, output }));
            });
            assert.equal(result.code, 0, '退出码应来自脚本化事件');
            assert.equal(result.output, 'board up\n', 'stdout 输出应来自脚本化事件');
        }
        finally {
            liteSpawn.unmock();
        }
    },
    /** 场景：kill 语义；输入：内存子进程调用 kill；预期：以 SIGTERM 触发 exit/close。 */
    async function killEmitsExitAndClose() {
        liteSpawn.mock();
        try {
            const child = liteSpawn.spawn('/mock/node', []);
            const result = await new Promise((resolve) => {
                child.on('close', (code, signal) => resolve({ code, signal }));
                child.kill();
            });
            assert.equal(result.code, null, '信号终止的退出码应为 null（真实语义）');
            assert.equal(result.signal, 'SIGTERM', '默认信号应为 SIGTERM');
        }
        finally {
            liteSpawn.unmock();
        }
    },
    /** 场景：spawnSync 命令集分派；输入：git（lite-command-git 账本+钩子）、node -v（命令集回包）、未注册命令；预期：各自按命令集口径回包。 */
    async function spawnSyncDispatchesToCommandSets() {
        liteSpawn.mock();
        try {
            liteCommandGit.reset();
            liteCommandGit.onRun(() => ({ status: 0, stdout: 'memory-git\n' }));
            const git = liteSpawn.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: '/mock/project', encoding: 'utf8' });
            assert.equal(git.status, 0, 'git 应经 lite-command-git 回包');
            assert.equal(git.stdout, 'memory-git\n', 'git 回包应来自 onRun 钩子');
            assert.deepEqual(liteCommandGit.runs()[0].argv, ['rev-parse', 'HEAD'], 'git 调用应在命令集账本入账');
            const nodeV = liteSpawn.spawnSync('node', ['-v'], { encoding: 'utf8' });
            assert.equal(nodeV.status, 0, 'node -v 应由命令集成功回包');
            assert.equal(nodeV.stdout.trim(), process.version, 'node 版本应与本机同源');
            const unknown = liteSpawn.spawnSync('whatever', ['--flag']);
            assert.equal(unknown.status, 1, '未注册命令应按失败收场');
            assert.match(unknown.stderr, /未注册命令/, '失败信息应指引注册命令集');
        }
        finally {
            liteCommandGit.onRun(null);
            liteCommandGit.reset();
            liteSpawn.unmock();
        }
    },
    /** 场景：命令集桥接 lite-fs；输入：mock lite-fs 建卷后 spawnSync('ls', [目录])；预期：回命令行形态的目录名单。 */
    async function lsBridgesLiteFsVolume() {
        liteSpawn.mock();
        try {
            const liteFs = (await import('../lite-fs.mjs')).default;
            liteFs.mock({ exclude: ['/System'] });
            liteFs.mkdirSync('/mock/project/a/b', { recursive: true });
            liteFs.writeFileSync('/mock/project/a/b/x.txt', '1');
            liteFs.writeFileSync('/mock/project/a/b/y.md', '2');
            const ls = liteSpawn.spawnSync('ls', ['/mock/project/a/b'], { encoding: 'utf8' });
            assert.equal(ls.status, 0, 'ls 应成功');
            assert.equal(ls.stdout, 'x.txt\ny.md\n', 'stdout 应为命令行形态的目录名单');
            const missing = liteSpawn.spawnSync('ls', ['/mock/project/none']);
            assert.equal(missing.status, 1, '卷内不存在的目录应按 ls 失败收场');
            liteFs.unmock();
        }
        finally {
            liteSpawn.unmock();
        }
    },
    /** 场景：前置约束；输入：未 mock 即 spawns()/onSpawn()；预期：拒绝。 */
    async function apisRequireMockFirst() {
        assert.throws(() => liteSpawn.spawns(), /先 mock/, '未设置内存实现时查询调用应拒绝');
        assert.throws(() => liteSpawn.onSpawn(() => {}), /先 mock/, '未设置内存实现时设置钩子应拒绝');
    },
    /** 场景：恢复默认；输入：unmock 后再次 spawn 与 spawnSync；预期：回到真实子进程语义。 */
    async function unmockRestoresRealImplementations() {
        liteSpawn.mock();
        liteSpawn.unmock();
        const code = await new Promise((resolve, reject) => {
            const child = liteSpawn.spawn(process.execPath, ['-e', '']);
            child.on('error', reject);
            child.on('close', status => resolve(status));
        });
        assert.equal(code, 0, 'unmock 后应回到真实 spawn');
        const ver = liteSpawn.spawnSync(process.execPath, ['-v'], { encoding: 'utf8' });
        assert.equal(ver.status, 0, 'unmock 后 spawnSync 应回真实执行');
        assert.equal(ver.stdout.trim(), process.version, '真实 node -v 应与 process.version 一致');
    },
]);
