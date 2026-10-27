// 工具链与 Git 路由矩阵：child_process 替身的 spawnSync / spawn 组合分支全覆盖
//（git 的 cwd / -C / 工作树路由、.git 目录 rev-parse 分支、版本查询、npm test 出口开关、
// 原生虚拟子进程的 kill 与裸 process.exit 口径）——这些分支历史上从未被任何套件走过。
import assert from 'node:assert/strict';
import { buildMockEnvironment } from '../environment.mjs';
import { runCases } from './run-cases.mjs';

const srcRoot = new URL('./fixtures/entry.mjs', import.meta.url).pathname;
const client = new URL('./fixtures/toolchain-client.mjs', import.meta.url).pathname;
const childEntry = new URL('./fixtures/native-child.mjs', import.meta.url).pathname;

const boot = () => buildMockEnvironment({
    srcRoot, projectRoot: '/mock/project',
    sideEntries: [{ key: 'client', file: client }],
    initialData(fs) {
        fs.mkdirSync('/mock/project', { recursive: true });
        fs.mkdirSync('/mock/other', { recursive: true });
        fs.writeFileSync('/mock/project/input.txt', 'seed');
    },
});

await runCases([
    /** 场景：spawnSync git 各路由形态；输入：cwd=项目根、-C 形式、worktree cwd、.git 目录 rev-parse。
     * 预期：各分支按语义返回（cwd 精确匹配走沙盒；-C 剥前缀；worktree 归属；.git 存在时 toplevel/verify 生效）。 */
    async function spawnSyncGitRoutingMatrix() {
        const env = await boot();
        try {
            const c = env.exports.client;
            // cwd=projectRoot 直连沙盒
            assert.equal(c.probe('git', ['status', '--porcelain'], { cwd: '/mock/project' }).status, 0);
            // -C 前缀形态
            assert.equal(c.probe('git', ['-C', '/mock/project', 'status', '--porcelain']).status, 0);
            // 建工作树后以 worktree cwd 走沙盒
            assert.equal(c.probe('git', ['worktree', 'add', '/mock/wt', '-b', 'wt-branch']).status, 0);
            assert.equal(c.probe('git', ['status', '--porcelain'], { cwd: '/mock/wt' }).status, 0);
            assert.equal(c.probe('git', ['worktree', 'remove', '/mock/wt']).status, 0);
            // 非 git cwd + 无 .git：未声明调用记账（有意 deny——收口按记账红收场）
            assert.throws(() => c.probe('git', ['status', '--porcelain'], { cwd: '/mock/other' }), /未声明/);
            // .git 目录存在时的 rev-parse 特例分支（存在 / 缺失引用两种口径）
            c.writeMarker('/mock/repo/.git/HEAD', 'ref: refs/heads/main\n');
            assert.equal(c.probe('git', ['rev-parse', '--show-toplevel'], { cwd: '/mock/repo' }).stdout, '/mock/repo\n');
            assert.equal(c.probe('git', ['rev-parse', '--verify', 'HEAD'], { cwd: '/mock/repo' }).status, 0);
            assert.equal(c.probe('git', ['rev-parse', '--verify', 'missing'], { cwd: '/mock/repo' }).status, 128);
            // .git 分支的非 rev-parse 命令：不属特例，按未声明记账
            assert.throws(() => c.probe('git', ['status', '--porcelain'], { cwd: '/mock/repo' }), /未声明/);
            // spawn 通道的 git 路由同口径（异步事件面）：cwd 直连 / worktree cwd / -C 且 cwd 不匹配 /
            // 完全不匹配（deny）——四种形态各走一遍
            assert.equal((await c.spawnProbe('git', ['status', '--porcelain'])).code, 0, 'cwd=项目根的异步 git');
            assert.equal(c.probe('git', ['worktree', 'add', '/mock/wt2', '-b', 'wt-2']).status, 0);
            assert.equal((await c.spawnProbe('git', ['status', '--porcelain'], { cwd: '/mock/wt2' })).code, 0, 'worktree cwd 的异步 git');
            assert.equal((await c.spawnProbe('git', ['-C', '/mock/project', 'status', '--porcelain'], { cwd: '/mock/other' })).code, 0, '-C 且 cwd 不匹配走前缀剥离');
            await assert.rejects(c.spawnProbe('git', ['status', '--porcelain'], { cwd: '/mock/other' }), /未声明/);
        }
        finally {
            await assert.rejects(() => env.dispose(), /不得有未声明的环境调用/, '有意 deny 应令收口红');
        }
    },
    /** 场景：版本查询与 npm test 出口；输入：node -v / npm -v / npm test（含出口开关）。预期：固定版本串、出口码开关生效。 */
    async function versionAndNpmTestMatrix() {
        const env = await boot();
        try {
            const c = env.exports.client;
            assert.equal(c.probe('node', ['-v']).stdout, 'v22.0.0\n');
            assert.equal(c.probe('npm', ['-v']).stdout, '10.0.0\n');
            assert.equal(c.probe('npm', ['test']).status, 0, '未设置出口码缺省 0');
            env.setCommandExitCode('npm test', 7);
            assert.equal(c.probe('npm', ['test']).status, 7, '出口码开关应生效');
            assert.equal((await c.spawnProbe('npm', ['test'])).code, 7, 'spawn 通道出口码开关同口径');
            env.setCommandExitCode('npm test', null);
            // spawn 通道同口径：sh -c 包装、npm test、未知命令记账
            assert.equal((await c.spawnProbe('sh', ['-c', 'npm test'])).code, 0);
            assert.equal((await c.spawnProbe('npm', ['test'])).code, 0);
        }
        finally { await env.dispose(); }
    },
    /** 场景：spawn '/mock/node' 空 args；输入：无参 spawn。预期：不落 .mjs 路由，未声明调用记账。 */
    async function spawnNodeEmptyArgsIsUndeclared() {
        const env = await boot();
        try {
            const c = env.exports.client;
            await assert.rejects(c.spawnProbe('/mock/node', []), /未声明.*spawn/);
        }
        finally {
            await assert.rejects(() => env.dispose(), /不得有未声明的环境调用/, '有意 deny 应令收口红');
        }
    },
]);
