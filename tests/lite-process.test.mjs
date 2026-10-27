// lite-process 门面用例：默认转发真实 node:child_process 的 spawn；mock() 设置内存实现——
// 不再真实起进程，调用被记录（command/args/options 供断言），子进程事件可经 onSpawn 脚本化，
// kill 触发 exit/close；unmock() 回到真实 spawn。
import assert from 'node:assert/strict';
import liteProcess from '../lite-process.mjs';
import { runCases } from './run-cases.mjs';

await runCases([
    /** 场景：默认真实实现；输入：未 mock 时 spawn 真实 node 空脚本；预期：真实子进程 close 退出码 0。 */
    async function defaultDelegatesToRealSpawn() {
        const code = await new Promise((resolve, reject) => {
            const child = liteProcess.spawn(process.execPath, ['-e', '']);
            child.on('error', reject);
            child.on('close', status => resolve(status));
        });
        assert.equal(code, 0, '真实 spawn 应执行真实子进程并以 0 退出');
    },
    /** 场景：内存实现记录调用；输入：mock 后 spawn 守护进程形状参数；预期：调用入账、child 有 pid/unref，不起真实进程。 */
    async function mockRecordsCallsWithoutRealProcess() {
        liteProcess.mock();
        try {
            const child = liteProcess.spawn('/mock/node', ['/app/server.mjs'], { cwd: '/app', env: { ATB_PORT: '18888' }, detached: true });
            child.unref(); // detached 守护进程消费面应为 no-op 而非 TypeError
            assert.equal(typeof child.pid, 'number', '替身子进程应带 pid');
            assert.equal(liteProcess.spawns().length, 1, 'spawn 调用应入账');
            const call = liteProcess.spawns()[0];
            assert.equal(call.command, '/mock/node', 'command 应如实记录');
            assert.deepEqual(call.args, ['/app/server.mjs'], 'args 应如实记录');
            assert.equal(call.options.env.ATB_PORT, '18888', 'options 应如实记录');
        }
        finally {
            liteProcess.unmock();
        }
    },
    /** 场景：脚本化钩子；输入：onSpawn 注入 stdout 输出与退出事件；预期：消费面按事件序收到输出与退出码。 */
    async function onSpawnScriptsChildEvents() {
        liteProcess.mock();
        try {
            liteProcess.onSpawn((child) => {
                child.stdout.emit('data', Buffer.from('board up\n'));
                child.emit('exit', 0, null);
                child.emit('close', 0, null);
            });
            const result = await new Promise((resolve) => {
                let output = '';
                const child = liteProcess.spawn('/mock/node', ['/app/server.mjs']);
                child.stdout.on('data', c => { output += c; });
                child.on('close', code => resolve({ code, output }));
            });
            assert.equal(result.code, 0, '退出码应来自脚本化事件');
            assert.equal(result.output, 'board up\n', 'stdout 输出应来自脚本化事件');
        }
        finally {
            liteProcess.unmock();
        }
    },
    /** 场景：kill 语义；输入：内存子进程调用 kill；预期：以 SIGTERM 触发 exit/close。 */
    async function killEmitsExitAndClose() {
        liteProcess.mock();
        try {
            const child = liteProcess.spawn('/mock/node', []);
            const result = await new Promise((resolve) => {
                child.on('close', (code, signal) => resolve({ code, signal }));
                child.kill();
            });
            assert.equal(result.code, null, '信号终止的退出码应为 null（真实语义）');
            assert.equal(result.signal, 'SIGTERM', '默认信号应为 SIGTERM');
        }
        finally {
            liteProcess.unmock();
        }
    },
    /** 场景：前置约束；输入：未 mock 即 spawns()/onSpawn()；预期：拒绝。 */
    async function apisRequireMockFirst() {
        assert.throws(() => liteProcess.spawns(), /先 mock/, '未设置内存实现时查询调用应拒绝');
        assert.throws(() => liteProcess.onSpawn(() => {}), /先 mock/, '未设置内存实现时设置钩子应拒绝');
    },
    /** 场景：恢复默认；输入：unmock 后再次 spawn；预期：回到真实子进程语义。 */
    async function unmockRestoresRealSpawn() {
        liteProcess.mock();
        liteProcess.unmock();
        const code = await new Promise((resolve, reject) => {
            const child = liteProcess.spawn(process.execPath, ['-e', '']);
            child.on('error', reject);
            child.on('close', status => resolve(status));
        });
        assert.equal(code, 0, 'unmock 后应回到真实 spawn');
    },
]);
