import assert from 'node:assert/strict';
import { buildMockEnvironment } from '../environment.mjs';
import { runCases } from './run-cases.mjs';
const srcRoot = new URL('./fixtures/entry.mjs', import.meta.url).pathname;
const client = new URL('./fixtures/http-client.mjs', import.meta.url).pathname;
const boot = () => buildMockEnvironment({ srcRoot, projectRoot: '/mock/project', sideEntries: [{ key: 'client', file: client }] });
await runCases([
    /** 场景：必须启动服务器；输入：不启动监听的主程序入口，没有 listen 端口；预期：装配失败，不提供无服务器模式。 */
    async function requireListeningServer() {
        await assert.rejects(buildMockEnvironment({ srcRoot: new URL('./fixtures/no-server.mjs', import.meta.url).pathname, projectRoot: '/mock/project' }), /必须.*HTTP.*服务/);
    },
    /** 场景：默认内存 mock 请求；输入：两次客户端调用；预期：生产路由在隔离环境生成递增结果、响应头支持读取。 */
    async function realResponsesAndHeaders() {
        const env = await boot();
        try {
            const a = await env.exports.client.request('/counter'), b = await env.exports.client.request('/counter');
            assert.equal((await a.json()).count, 1);
            assert.equal((await b.json()).count, 2);
            assert.equal(a.headers.get('CONTENT-TYPE'), 'application/json');
            assert.equal(a.headers.get('missing'), null);
            assert.equal(env.http.requests.filter(r => r.dispatched).length, 2);
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：响应延迟；输入：真实路由后阻断响应；预期：服务执行一次，释放后回包仍由真实路由生成。 */
    async function delayKeepsRealResponse() {
        const env = await boot();
        try {
            let release;
            const wait = new Promise(r => { release = r; });
            const remove = env.http.injectFault({ path: '/counter', phase: 'response', wait });
            let done = false;
            const pending = env.exports.client.request('/counter').then(r => { done = true; return r; });
            await env.until(() => env.http.requests[0]?.dispatched);
            assert.equal(done, false);
            assert.equal(env.exports.entry.requestCount(), 1);
            release();
            assert.equal((await (await pending).json()).count, 1);
            remove();
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：断连和错误；输入：请求前断连、响应后 503；预期：断连不执行路由，响应错误仍保留真实服务执行证据。 */
    async function disconnectAndStatusFault() {
        const env = await boot();
        try {
            let remove = env.http.injectFault({ path: '/counter', disconnect: true });
            await assert.rejects(env.exports.client.request('/counter'), /断连/);
            assert.equal(env.exports.entry.requestCount(), 0);
            remove();
            remove = env.http.injectFault({ path: '/counter', phase: 'response', status: 503, error: '离线' });
            const r = await env.exports.client.request('/counter');
            assert.equal(r.status, 503);
            assert.equal((await r.json()).error, '离线');
            assert.equal(env.exports.entry.requestCount(), 1);
            assert.equal(env.http.requests[1].serverResponse.status, 200);
            remove();
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：取消；输入：响应延迟且 signal 取消；预期：请求拒绝，取消监听释放，不能重新完成响应。 */
    async function abortPendingDelivery() {
        const env = await boot();
        try {
            const controller = new AbortController();
            const remove = env.http.injectFault({ path: '/counter', phase: 'response', wait: new Promise(() => { }) });
            const pending = env.exports.client.request('/counter', { signal: controller.signal });
            await env.until(() => env.http.requests[0]?.dispatched);
            controller.abort();
            await assert.rejects(pending, e => e.name === 'AbortError');
            assert.equal(env.http.pendingCount(), 0);
            remove();
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：故障解除；输入：单次 500 和非法成功替换配置；预期：后续恢复内存 mock 请求，拒绝成功回包替换。 */
    async function oneShotAndNoSuccessOverrides() {
        const env = await boot();
        try {
            assert.throws(() => env.http.injectFault({ path: '/counter', status: 200, body: { count: 99 } }), /错误.*状态/);
            env.http.injectFault({ path: '/counter', status: 500, error: '失败', once: true });
            assert.equal((await env.exports.client.request('/counter')).status, 500);
            assert.equal((await (await env.exports.client.request('/counter')).json()).count, 1);
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：子进程执行真实入口；输入：虚拟 Node、参数和内存文件；预期：源码读取共享文件系统并输出实际结果。 */
    async function nodeChildRunsRealSource() {
        const env = await buildMockEnvironment({ srcRoot, projectRoot: '/mock/project', initialData: fs => { fs.mkdirSync('/mock/project', { recursive: true }); fs.writeFileSync('/mock/project/input.txt', '真实文件'); }, sideEntries: [{ key: 'client', file: client }] });
        try {
            const result = await env.exports.client.runChild(new URL('./fixtures/child.mjs', import.meta.url).pathname, ['参数']);
            assert.equal(result.code, 0);
            assert.equal(result.stdout, '参数:真实文件\n');
            assert.equal(result.stderr, '');
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：请求查询参数限定故障；输入：同一路径两个参数值；预期：仅目标请求断连，其余仍由真实路由响应。 */
    async function queryScopedFaultAndTransportError() {
        const env = await boot();
        try {
            env.http.injectFault({ path: '/counter', query: { key: 'bad' }, error: new Error('指定传输错误') });
            await assert.rejects(env.exports.client.request('/counter?key=bad'), /指定传输错误/);
            assert.equal(env.exports.entry.requestCount(), 0);
            assert.equal((await (await env.exports.client.request('/counter?key=good')).json()).count, 1);
        }
        finally {
            await env.dispose();
        }
    },
    /** 场景：浏览器初始数据与通道保护；输入：存储种子、覆盖 fetch、混合大小写响应头；预期：种子可读、覆盖被拒、头可迭代且去重。 */
    async function storageSeedAndProtectedChannels() {
        const env = await buildMockEnvironment({ srcRoot, projectRoot: '/mock/project', initialStorage: { local: { key: '本地' }, session: { key: '会话' } } });
        try {
            assert.equal(env.evaluate("localStorage.getItem('key')"), '本地');
            assert.equal(env.evaluate("sessionStorage.getItem('key')"), '会话');
            assert.throws(() => env.expose({ fetch: () => { } }), /不能覆盖/);
            const Headers = env.global('Headers'), headers = new Headers([['CONTENT-Type', 'text/plain'], ['Content-Type', 'application/json']]);
            assert.equal(headers.get('content-type'), 'application/json');
            assert.deepEqual([...headers], [['content-type', 'application/json']]);
        }
        finally {
            await env.dispose();
        }
        const unavailable = await buildMockEnvironment({ srcRoot, projectRoot: '/mock/project', initialStorage: { local: null } });
        try {
            assert.equal(unavailable.global('localStorage'), null);
        }
        finally {
            await unavailable.dispose();
        }
    },
    /** 场景：释放悬挂请求；输入：延迟中的内存 mock 请求和 dispose；预期：拒绝未完成请求、清空计时器与待处理记录、关闭服务器。 */
    async function disposalCancelsPendingRequest() {
        const env = await boot();
        env.http.injectFault({ path: '/counter', phase: 'response', wait: new Promise(() => { }) });
        const pending = env.exports.client.request('/counter');
        const rejected = assert.rejects(pending, e => e.name === 'AbortError');
        await env.until(() => env.http.requests[0]?.serverResponse);
        await env.dispose();
        await rejected;
        assert.equal(env.http.pendingCount(), 0);
        assert.equal(env.http.isListening(), false);
        assert.equal(env.clock.countTimers(), 0);
    },
    /** 场景：Git 标准调用通道；输入：真实入口通过 -C、同步及异步文件执行读取 Git 沙盒；预期：返回同一分支、项目根和实际模型提交号。 */
    async function gitExecutionChannelsShareRepository() {
        const env = await boot();
        try {
            env.git.run(['commit', '--only', '-m', '测试提交', '--', 'input.txt']);
            const result = await env.exports.client.gitChannels();
            assert.equal(result.direct.status, 0);
            assert.equal(result.direct.stdout, 'main\n');
            assert.equal(result.file, '/mock/project\n');
            assert.equal(result.async.stdout, env.git.log()[0].hash + '\n');
            assert.equal(result.async.stderr, '');
        } finally { await env.dispose(); }
    },
    /** 场景：隔离工作树；输入：已播种项目和 Git worktree add/remove；预期：副本读回相同文件，移除后不残留目录。 */
    async function worktreeCopiesAndCleansVirtualFiles() {
        const env = await buildMockEnvironment({ srcRoot, projectRoot: '/mock/project', initialData: fs => { fs.mkdirSync('/mock/project', { recursive: true }); fs.writeFileSync('/mock/project/input.txt', '工作树输入'); } });
        try {
            assert.equal(env.git.run(['worktree', 'add', '--detach', '/mock/tmp/work', 'HEAD']).status, 0);
            assert.equal(env.fs.readTextFile('/mock/tmp/work/input.txt'), '工作树输入');
            assert.equal(env.git.run(['worktree', 'remove', '--force', '/mock/tmp/work']).status, 0);
            assert.equal(env.fs.exists('/mock/tmp/work'), false);
        } finally { await env.dispose(); }
    },
]);
