// 原生试点虚拟 Node 子进程用例：loadModules 世界内 spawn('/mock/node', [entry, ...args])
// 经 fork 出的独立子进程世界执行真实入口源码——验证进程边界下的世界共享与回流语义
//（fs 快照进出含删除、Git 状态回流、退出码口径、stdout/stderr 流、依赖图新鲜度与记账传播）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProcessEnvironment } from '../environment.mjs';

const server = new URL('./fixtures/process-server.mjs', import.meta.url).pathname;
const child = new URL('./fixtures/native-child.mjs', import.meta.url).pathname;
const stdinChild = new URL('./fixtures/stdin-child.mjs', import.meta.url).pathname;

function boot() {
  return buildProcessEnvironment({ srcRoot: server, projectRoot: '/app', initialData(fs) {
    fs.mkdirSync('/app', { recursive: true });
    fs.writeFileSync('/app/value', 'initial');
    fs.writeFileSync('/app/input.txt', '父世界文件');
    fs.writeFileSync('/app/remove.txt', '待删除');
  } });
}

async function runChild(env, file, args = [], extra = {}) {
  const query = new URLSearchParams({ file, args: JSON.stringify(args), ...(extra.stdin == null ? {} : { stdin: extra.stdin }) });
  return (await env.http.request('GET', `/child?${query}`)).json.result;
}

async function runKilledChild(env, file, args = []) {
  const query = new URLSearchParams({ file, args: JSON.stringify(args), kill: '1' });
  return (await env.http.request('GET', `/child?${query}`)).json.result;
}

test('native node child shares world state and flows it back', async () => {
  const env = await boot();
  try {
    const result = await runChild(env, child);
    assert.equal(result.code, 0, `子进程应成功退出：${result.stderr}`);
    assert.match(result.stdout, /echo:默认:父世界文件:count=1/, '应回显 argv、父世界文件与新鲜依赖计数');
    assert.equal(result.stderr, '', '成功执行不应有 stderr');
    assert.equal(env.fs.readTextFile('/app/out.txt'), 'child-write:父世界文件', '子世界写入应回流父世界');
    assert.equal(env.fs.exists('/app/remove.txt'), false, '子世界删除应回流父世界');
    assert.equal(env.git.log().length, 1, '子世界 Git 提交应回流父世界');
    assert.equal(env.git.log()[0].subject, 'child commit', '回流提交应保留主题');
    assert.equal(env.git.isCommitted('out.txt'), true, '子世界入库标记应回流父进程观测');
    assert.equal(env.git.isCommitted('input.txt'), false, '未入库路径不得误报');
    assert.deepEqual(await env.git.run(['ls-files', '--', 'out.txt']), { status: 0, stdout: 'out.txt\n', stderr: '' }, 'ls-files 应列出已入库路径');
    assert.deepEqual(await env.git.run(['ls-files', '--', 'input.txt']), { status: 0, stdout: '', stderr: '' }, '未跟踪路径 ls-files 输出为空且退出 0');
    assert.deepEqual(env.unexpected, [], '成功执行不得有未声明调用');
  }
  finally { await env.dispose(); }
});

test('each spawn gets a fresh module graph', async () => {
  const env = await boot();
  try {
    const first = await runChild(env, child), second = await runChild(env, child);
    assert.match(first.stdout, /count=1/);
    assert.match(second.stdout, /count=1/, '第二次 spawn 必须重新加载依赖图（计数不得累计）');
  }
  finally { await env.dispose(); }
});

test('exit codes follow process.exit and process.exitCode', async () => {
  const env = await boot();
  try {
    assert.equal((await runChild(env, child, ['exit3'])).code, 3, 'process.exit 应折算为退出码');
    assert.equal((await runChild(env, child, ['exitcode2'])).code, 2, 'process.exitCode 应折算为退出码');
  }
  finally { await env.dispose(); }
});

test('stdin payload reaches fd 0 of the child', async () => {
  const env = await boot();
  try {
    const result = await runChild(env, stdinChild, [], { stdin: '标准输入载荷' });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'stdin:标准输入载荷\n');
    // 默认模式同时携带 stdin：businessFs 代理的 fd≠0 侧（正常文件读取）与 fd 0 通道共存
    const mixed = await runChild(env, child, [], { stdin: '载荷' });
    assert.equal(mixed.code, 0, 'stdin 选项不影响默认链路');
    assert.match(mixed.stdout, /echo:默认:父世界文件:count=1/, '文件读取仍走真实 fs');
  }
  finally { await env.dispose(); }
});

test('missing entry and failing entry surface as nonzero exit with stderr', async () => {
  const env = await boot();
  try {
    const missing = await runChild(env, '/app/missing.mjs');
    assert.equal(missing.code, 1, '缺失入口应非零退出');
    assert.ok(missing.stderr.length > 0, '缺失入口应有 stderr 说明');
    const failing = await runChild(env, child, ['fail']);
    assert.equal(failing.code, 1, '入口抛错应非零退出');
    assert.match(failing.stderr, /入口执行失败/);
    const noisy = await runChild(env, child, ['stderr']);
    assert.equal(noisy.code, 0, 'stderr 输出本身不改变退出码');
    assert.equal(noisy.stderr, 'stderr 输出 cwd=/app\n', 'console.error 应经子世界 stderr 通道回流并带 cwd 口径');
    assert.equal(noisy.stdout, '', 'stderr 模式不应有 stdout');
  }
  finally { await env.dispose(); }
});

test('killed native child reports abnormal exit and bare exit() maps to zero', async () => {
  const env = await boot();
  try {
    const killed = await runKilledChild(env, child, ['hang']);
    assert.equal(killed.code, 1, '未收 done 的强杀按异常退出收场');
    assert.ok(env.unexpected.some((item) => item.includes('原生子进程异常退出')), '强杀应落父世界记账');
  }
  finally {
    await assert.rejects(env.dispose(), /原生子进程/, '强杀记账应令收口报红');
  }
  // 裸 process.exit() 无参：childExit 缺省折算 0
  const quiet = await boot();
  try {
    const bare = await (async () => {
      const query = new URLSearchParams({ file: child, args: JSON.stringify(['exit-bare']) });
      return (await quiet.http.request('GET', `/child?${query}`)).json.result;
    })();
    assert.equal(bare.code, 0, '无参 process.exit() 应折算退出码 0');
  }
  finally { await quiet.dispose(); }
});

test('undeclared calls inside the child propagate to parent accounting', async () => {
  const env = await boot();
  try {
    const result = await runChild(env, child, ['deny']);
    assert.equal(result.code, 0, 'fixture 吞掉异常本身不改变退出码');
    assert.ok(env.unexpected.some(item => item.includes('原生子进程') && item.includes('execFileSync')), '子世界未声明调用应并入父世界记账');
  }
  finally {
    await assert.rejects(env.dispose(), /原生子进程/, '收口断言应因记账非空而红');
  }
});
