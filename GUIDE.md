# litenvi-node 使用指南

> 面向两类读者：在业务项目里用 litenvi-node 装配测试环境的工程师，以及辅助写测试的 AI Agent。
> 行为规格的唯一真源是 [README.md](README.md) 与各模块头注释；本文只讲「怎么用」。除标注「需真实浏览器」的例外，**每个演示代码块都可整块复制到文件里用 `node <文件>` 直接执行**（仓库自身有 `exports` 自引用，业务项目里经 npm 安装后同样可执行）。

## 1. 一句话模型

业务代码统一 import `litenvi-node/lite-*.mjs`（代替 `node:fs`、`node:child_process`、`node:http`、`process` 等）。**未 mock 时逐字透传原生实现，生产行为不变**；测试里 `t_mock()` 切入内存世界（内存文件系统、内存命令分派、虚拟服务、虚拟时钟），`t_unmock()` 回到真实。业务逻辑与路由跑的始终是完整生产源码，被切换的只有环境边界。

| 门面 | 代替的原生面 | 切换后世界 |
|---|---|---|
| `lite-fs` | `node:fs` | 黑名单制内存卷（exclude 外全部内存化，越界写不穿透真实磁盘） |
| `lite-child_process` | `node:child_process` | 内存命令分派（node/npm/git/系统命令），不启动 OS 子进程 |
| `lite-cmd-git` | —（命令集） | 内存 Git |
| `lite-cmd-mgr` | —（命令内核） | 命令登记表与故障注入，无开关 |
| `lite-process` | `process` | cwd/argv/env/pid 假世界，`exit()` 记录退出意图 |
| `lite-os` | `node:os` | homedir/tmpdir 等路径锚点与只读标识按键覆盖 |
| `lite-http` | `node:http` / `node:https` 客户端 | 内存传输：不外联，按注入规则应答 |
| `lite-server` | `http.createServer` 服务端 | 多服务内存 listen（含 virtual 域名端口） |
| `lite-timer` | 定时器与 `Date`（按模块遮蔽注入） | 冻结时钟，只在 `t_advanceMs` 推进时派发 |
| `lite-browser` / `lite-browser-timer` | Playwright 浏览器 / 页面定时 | 共享单例浏览器；页面超时信号与周期定时 gate |

## 2. 三条铁律（先记住再动手）

1. **`t_` 前缀只属于测试代码**。`t_mock/t_unmock/t_inject` 等测试专用接口只能出现在测试与测试夹具里，生产代码不得导入、读取或调用。
2. **每个用例 `try/finally` 归位所有 mock 过的门面**。门面状态是进程级单例，漏归位会泄漏到后续用例；用例起手先 `t_unmock()` 复位再 `t_mock()`，防上一轮遗留。
3. **单例经同一 specifier 导入才共享**。`'litenvi-node/lite-fs.mjs'` 与 `'../lite-fs.mjs'` 是两个实例；动态 `import()` 的 specifier 也必须一致。

方法前缀速记：无前缀 = 公共接口（生产与测试都可用）；`t_` = 仅测试；`i_` = 仅包内协作；`f_` = 文件私有。公开 API 签名速查见 [user-api.md](user-api.md)。

## 3. 快速上手：内存文件系统

`lite-fs` 是黑名单制：`t_mock({ exclude })` 登记留在真实磁盘的目录（业务源码、静态资源），**exclude 之外的一切路径都落内存卷**——测试世界的越界写不可能穿透真实磁盘。错误码与真实 fs 一致（ENOENT/EEXIST/EISDIR…）。

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from 'litenvi-node/lite-fs.mjs';

// 起手先复位（门面状态是进程级单例，上一轮用例可能遗留）
liteFs.t_unmock();
// exclude 是黑名单：登记真实源码目录，其余路径全部落内存卷
liteFs.t_mock({ exclude: [path.dirname(fileURLToPath(import.meta.url))] });
try {
  liteFs.mkdirSync('/app/data', { recursive: true });
  liteFs.writeFileSync('/app/data/config.json', JSON.stringify({ env: 'test' }));

  // 业务代码照常用 fs 语义读写，错误码与真实 fs 一致
  const config = JSON.parse(liteFs.readFileSync('/app/data/config.json', 'utf8'));
  assert.equal(config.env, 'test', '内存卷应原样读回写入内容');
  assert.throws(() => liteFs.readFileSync('/app/missing.txt'), error => error.code === 'ENOENT', '缺失路径应按真实 fs 口径报 ENOENT');

  // 错误注入：模拟磁盘写失败，返回移除函数
  const remove = liteFs.t_inject({ op: 'writeFileSync', path: '/app/data/config.json', code: 'EACCES' });
  try {
    assert.throws(() => liteFs.writeFileSync('/app/data/config.json', '{}'), error => error.code === 'EACCES', '注入后写入应按 EACCES 失败');
  } finally {
    remove(); // 用完必须移除，避免影响其他用例
  }
  assert.doesNotThrow(() => liteFs.writeFileSync('/app/data/config.json', '{}'), '移除注入后应恢复正常写入');
} finally {
  liteFs.t_unmock(); // 归位：内存卷与注入规则随实例丢弃
}
```

## 4. 总装：业务脚本跑在内存世界

典型装配是「真实入口 + 内存数据」：被测脚本是真实磁盘上的业务源码（列入 `exclude`），脚本显式 import `lite-fs` 读写内存卷；`lite-child_process.t_mock()` 后 `spawn('node', …)` 经内存命令分派在进程内执行脚本，输出、argv、env、退出码都是子进程口径。

```js
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';

// 真实入口脚本放真实磁盘（本目录，稍后列入 exclude），业务数据留在内存卷
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'collector.mjs');
realFs.writeFileSync(script, `
  import liteFs from 'litenvi-node/lite-fs.mjs';
  const input = JSON.parse(liteFs.readFileSync('/mock/job/input.json', 'utf8'));
  liteFs.writeFileSync('/mock/job/output.json', JSON.stringify({ doubled: input.value * 2 }));
  console.log('saved');
`);

// 总装：exclude 登记真实入口目录，其余全部落内存卷；spawn 边界切到内存命令分派
liteFs.t_unmock();
liteChildProcess.t_unmock();
liteFs.t_mock({ exclude: [here] });
liteChildProcess.t_mock();
try {
  liteFs.mkdirSync('/mock/job', { recursive: true });
  liteFs.writeFileSync('/mock/job/input.json', '{"value":6}');

  const child = liteChildProcess.spawn('node', [script]);
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  assert.deepEqual(await liteChildProcess.waitForClose(child), { code: 0, signal: null }, '脚本应正常退出');
  assert.equal(stdout, 'saved\n', '入口成功写入后应报告 saved');

  // 脚本经 lite-fs 真实计算，结果落在内存卷
  assert.deepEqual(JSON.parse(liteFs.readFileSync('/mock/job/output.json', 'utf8')), { doubled: 12 }, '脚本应根据内存输入真实计算');

  // 全部调用统一入账，供测试断言执行轨迹
  const calls = liteChildProcess.t_calls();
  assert.equal(calls.length, 1, 'spawn 调用应入账');
  assert.equal(calls[0].args[0], script, '账本应记录执行的脚本路径');
} finally {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  realFs.rmSync(script, { force: true });
}
```

实际项目里入口就是已有业务源码，不必临时生成——把它所在目录列入 `exclude` 即可。要点：

- 原生 `fs` 不会被自动替换：脚本想看内存卷必须显式 import `lite-fs`；`spawn` 的 stdin 输入可用 `liteFs.readFileSync(0, 'utf8')` 同步读取。
- node 脚本**只有异步执行面**：`spawnSync('node', 脚本)` 仅支持版本探测，跑脚本一律 `spawn` + `waitForClose`。
- `t_calls()` 记账所有内存命令调用，`t_reset()` 只清账本。

## 5. 内存 Git 与故障注入

Git 命令集必须显式 `t_install()`——仅 import 模块不会登记，执行返回 `ENOENT`。调用方式与真实 Git 完全一致（公共子进程入口），支持 init/add/commit/status/show/log/branch/diff 等常用子命令。

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';
import mgr from 'litenvi-node/lite-cmd-mgr.mjs';
import { t_install } from 'litenvi-node/lite-cmd-git.mjs';

liteFs.t_unmock();
liteChildProcess.t_unmock();
liteFs.t_mock({ exclude: [path.dirname(fileURLToPath(import.meta.url))] });
liteChildProcess.t_mock();
t_install(); // Git 必须显式安装：仅 import 不会登记，执行会返回 ENOENT
try {
  liteFs.mkdirSync('/repo', { recursive: true });
  liteFs.writeFileSync('/repo/README.md', 'hello\n');

  // 走公共子进程入口执行，与真实 Git 的调用方式一致
  const git = (...args) => liteChildProcess.execFileSync('git', args, { cwd: '/repo', encoding: 'utf8' });
  git('init');
  git('add', '.');
  git('-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit', '-m', 'init');
  assert.equal(git('status', '--porcelain'), '', '提交后工作树应干净');
  assert.match(git('show', 'HEAD:README.md'), /^hello$/m, '提交内容应可核验');

  // 故障注入：模拟 index.lock 竞争，只命中 commit 子命令，once 命中即自毁
  const remove = mgr.command('git').t_inject({ subcommand: 'commit', exit: 128, stderr: 'fatal: Unable to create index.lock', once: true });
  try {
    assert.throws(
      () => git('commit', '-m', 'second'),
      error => error.status === 128 && error.stderr.includes('index.lock'),
      '注入后 commit 应按 128 失败并带 stderr',
    );
  } finally {
    remove();
  }
  // 注入已移除，恢复正常提交（先制造新变更，否则无事可提交）
  liteFs.writeFileSync('/repo/NOTES.md', 'note\n');
  git('add', '.');
  git('-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit', '-m', 'second');
} finally {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
}
```

故障口径：`exit` 须为 ≥1 整数（不允许「成功回包替换」），或 `wait` Promise 闸门（命中后挂起、放行再回失败包）；`once` 完整命中才消耗；Git 可按 `subcommand` 匹配。`t_inject` 返回移除函数，用完必须调用。

## 6. 自定义命令

用户级临时命令落 `/mock/bin`（PATH 序在系统命令之前，可遮蔽系统命令），卷复位即清；实现对象声明 `i_run`（异步 spawn）／`i_runSync`（spawnSync）。

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';
import mgr from 'litenvi-node/lite-cmd-mgr.mjs';

liteFs.t_unmock();
liteChildProcess.t_unmock();
liteFs.t_mock({ exclude: [path.dirname(fileURLToPath(import.meta.url))] });
liteChildProcess.t_mock();

// 用户级临时命令：落 /mock/bin（PATH 序在系统命令之前，可遮蔽系统命令），卷复位即清
mgr.t_defineUserCommand('backup', {
  i_runSync(argv, ctx) {
    const target = argv[0];
    const data = liteFs.readFileSync(target);
    liteFs.writeFileSync(`${target}.bak`, data);
    return { status: 0, stdout: `backed up ${target}\n`, stderr: '' };
  },
});
try {
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.writeFileSync('/app/data.txt', 'payload');
  const result = liteChildProcess.spawnSync('backup', ['/app/data.txt'], { encoding: 'utf8' });
  assert.equal(result.status, 0, '用户命令应成功执行');
  assert.equal(result.stdout, 'backed up /app/data.txt\n', '输出应来自命令实现');
  assert.equal(liteFs.readFileSync('/app/data.txt.bak', 'utf8'), 'payload', '备份应写入内存卷');
} finally {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
}
```

也可以给已登记的命令配行为钩子：`mgr.command('git').t_onRun(handler)`（`(call, runBuiltin) => result`，传 `null` 移除），在真实命令实现外包裹一段测试脚本。

## 7. HTTP 虚拟服务与注入

`lite-http`（客户端）+ `lite-server`（服务端）配合后进程内不触网。两个门面自动连接包内 HTTP 传输管线，使用方无需导入或配置 `i-http-transport.mjs`。模拟外部服务用 `listen({ host, port, virtual: true })` 只在内存登记域名端口，不绑定 socket；绑定真实回环端口的服务（`listen(0)`）可供浏览器访问，`liteServer.t_port()` 取端口。

注入分两层：`liteHttp.t_inject` 在**传输层**拦截（请求未达 handler）；`liteServer.t_inject` 在**响应阶段**（handler 已执行）。匹配条件一致：`url/method/path/query`，同时给出须全部满足。

```js
import assert from 'node:assert/strict';
import liteHttp from 'litenvi-node/lite-http.mjs';
import liteServer from 'litenvi-node/lite-server.mjs';

liteHttp.t_unmock();
liteServer.t_unmock();
liteHttp.t_mock();
liteServer.t_mock();
try {
  // 虚拟外部服务：只在内存登记域名与端口，不绑定 socket，绝不外联
  await new Promise(resolve => liteServer.createServer((req, res) => {
    if (req.url.split('?')[0] === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }).listen({ host: 'api.example.test', port: 443, virtual: true }, resolve));

  const ask = url => new Promise((resolve, reject) => liteHttp.get(url, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));

  // 传输层注入：请求未达 handler 即按 503 应答，once 命中即自毁
  liteHttp.t_inject({ url: 'https://api.example.test/api/health?full=1', status: 503, once: true });
  const first = await ask('https://api.example.test/api/health?full=1');
  assert.equal(first.status, 503, '命中注入应按 503 应答');

  // 注入已消耗，第二次到达真实 handler，拿到业务回包
  const second = await ask('https://api.example.test/api/health?full=1');
  assert.deepEqual({ status: second.status, body: second.body }, { status: 200, body: '{"ok":true}' }, '未命中应走真实 handler');

  // 未监听的域名按 ECONNREFUSED 拒连，不会真实外联
  await assert.rejects(ask('https://other.example.test/'), error => error.code === 'ECONNREFUSED', '无服务域名应拒连');
} finally {
  liteServer.t_unmock();
  liteHttp.t_unmock();
}
```

URL 匹配口径要记牢：`url` 接受字符串或 `URL` 对象，查询串按**完整顺序精确比较**——参数顺序不同、多一个参数都不命中；要忽略查询串用 `path`，部分匹配用 `query`。回调式 `request/get` 与真实 `ClientRequest` 消费面兼容（statusCode/data/end/error 事件）。

## 8. 虚拟时钟（lite-timer）

面向「按模块遮蔽注入」：测试装配（`node:module` register hook）向被测模块源码头部注入 `import { setTimeout, clearTimeout, setInterval, clearInterval, Date } from 'litenvi-node/lite-timer.mjs'`，只有被注入模块运行在虚拟时钟上，宿主进程不受影响。本例直接演示门面本身：

```js
import assert from 'node:assert/strict';
// 业务模块经遮蔽注入（node:module register hook）导入这些绑定；本例直接演示门面本身
import { setTimeout, Date } from 'litenvi-node/lite-timer.mjs';
import timer from 'litenvi-node/lite-timer.mjs';

timer.t_unmock();
timer.t_mock({ now: '2026-01-01T00:00:00.000Z' }); // 冻结世界：定时器只随 t_advanceMs 推进
try {
  assert.equal(Date.now(), Date.parse('2026-01-01T00:00:00.000Z'), 'mock 后 Date 应返回虚拟纪元');

  let fired = 0;
  setTimeout(() => { fired += 1; }, 60_000);

  // 真实时间流逝不触发；推进到位才派发
  await timer.t_advanceMs(59_999);
  assert.equal(fired, 0, '未推进到位不得派发');
  await timer.t_advanceMs(1);
  assert.equal(fired, 1, '推进过时限应派发回调');
  assert.equal(Date.now(), Date.parse('2026-01-01T00:01:00.000Z'), '虚拟时刻应随推进累计');
} finally {
  timer.t_unmock(); // 丢弃在途定时器，恢复原生
}
```

未覆盖面（勿依赖）：`process.hrtime`、`performance`、`queueMicrotask` 与真实 I/O 到达时刻不经本门面；`setInterval` 同样只随 `t_advanceMs` 推进。

## 9. 进程环境与 os 锚点

`lite-process` 管 cwd/argv/env/pid/exit，`lite-os` 管 homedir/tmpdir 等路径锚点——两者叠加即可让「`<home>/.…` 配置路径」整体落进测试世界。注意 `chdir/exit/kill` 转调 os 命令实现，须由使用方导入 `lite-cmd-os`。

```js
import assert from 'node:assert/strict';
import { liteProcess } from 'litenvi-node/lite-process.mjs';
import { ProcessExitError } from 'litenvi-node/lite-process-exit-error.mjs';
import 'litenvi-node/lite-cmd-os.mjs'; // chdir/exit/kill 转调 os 命令实现，须由使用方导入
import liteOs from 'litenvi-node/lite-os.mjs';

liteProcess.t_unmock();
liteOs.t_unmock();
liteOs.t_mock({ homedir: '/home/alice' });
liteProcess.t_mock({ cwd: '/app', env: { APP_MODE: 'test' }, pid: 4242 });
try {
  assert.equal(liteProcess.cwd(), '/app', 'cwd 应来自假世界');
  assert.equal(liteProcess.env.APP_MODE, 'test', 'env 应来自假世界');
  assert.equal(liteProcess.pid, 4242, 'pid 应为装配值');
  // 用户目录锚点随 lite-os 落入测试世界：`<home>/.…` 路径整体可预期
  assert.equal(`${liteOs.homedir()}/.myapp`, '/home/alice/.myapp', 'homedir 锚点应落入装配的世界');

  // exit() 不结束宿主进程：退出意图记录在案并抛出，由调用方收场
  assert.throws(() => liteProcess.exit(3), ProcessExitError, '假世界 exit 应抛 ProcessExitError');
  assert.deepEqual(liteProcess.t_exitCodes(), [3], '退出意图应记录在案');
} finally {
  liteProcess.t_unmock();
  liteOs.t_unmock();
}
```

## 10. ESLint 规则与配置测试

单条自研规则使用 ESLint 官方 `RuleTester` 验证合法与违规代码；配置工厂则将真实产出的配置传给 `Linter.verify()` 或 `ESLint.lintText()`，检查文件范围、选项与规则是否实际生效。受检文本可以直接传字符串，不必创建配置夹具或模拟命令。

下面的示例使用仓库已有的 ESLint 开发依赖，直接检查字符串：

```js
import assert from 'node:assert/strict';
import path from 'node:path';
import { Linter } from 'eslint';

const linter = new Linter();
const config = [{ rules: { 'no-debugger': 'error' } }];
const filename = path.resolve('scripts/example.mjs');
const messages = linter.verify('debugger;\n', config, { filename });
assert.equal(messages.length, 1, '违规样例应产生一条诊断');
assert.equal(messages[0].ruleId, 'no-debugger', '应执行真实 ESLint 规则');
assert.deepEqual(linter.verify('console.log(1);\n', config, { filename }), [], '合法样例应放行');
```

规则需要读取项目文件时，用 lite-fs 装配数据并在测试结束后复位。配置文件加载与 CLI 退出码使用少量真实集成测试验证；项目的 `npm run lint` 仍直接运行真实 ESLint。

## 11. 完整测试用例模板

把上面的装配纪律放进 `node:test`：场景注释、中文断言、起手复位、`try/finally` 收尾。被测入口 `report.mjs` 是真实业务源码：

```js
// report.mjs —— 业务源码示例：经 lite-fs 读取任务列表并输出汇总
import liteFs from 'litenvi-node/lite-fs.mjs';

try {
  const tasks = JSON.parse(liteFs.readFileSync('/mock/task/list.json', 'utf8'));
  console.log(`done ${tasks.filter(task => task.done).length}/${tasks.length}`);
} catch (error) {
  if (error.code === 'EACCES') {
    console.error('cannot read task list');
    process.exitCode = 3;
  } else {
    throw error;
  }
}
```

```js
// report.test.mjs —— 用 node --test 运行
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';

// 被测入口是真实业务源码（本目录），须在 exclude 中登记
const report = fileURLToPath(new URL('./report.mjs', import.meta.url));

/** 场景：报告器从内存卷读取任务列表，输出完成数汇总。 */
test('报告器：读取内存任务并输出汇总', async () => {
  liteFs.t_unmock();
  liteChildProcess.t_unmock();
  liteFs.t_mock({ exclude: [new URL('.', import.meta.url).pathname] });
  liteChildProcess.t_mock();
  let remove;
  try {
    // 输入：内存卷预置业务数据
    liteFs.mkdirSync('/mock/task', { recursive: true });
    liteFs.writeFileSync('/mock/task/list.json', JSON.stringify([
      { title: 'a', done: true },
      { title: 'b', done: false },
    ]));

    // node 脚本只有异步执行面：spawn + waitForClose 收集输出与退出码
    const run = async () => {
      const child = liteChildProcess.spawn('node', [report], { cwd: '/mock/task' });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const { code } = await liteChildProcess.waitForClose(child);
      return { code, stdout, stderr };
    };

    // 注入读失败故障，验证业务容错路径
    remove = liteFs.t_inject({ op: 'readFileSync', path: '/mock/task/list.json', code: 'EACCES' });
    const damaged = await run();
    remove();
    remove = undefined;
    // 预期 1：读失败按业务约定退出 3，不伪造成功
    assert.equal(damaged.code, 3, '读失败应按业务约定退出 3');
    assert.equal(damaged.stderr, 'cannot read task list\n', '应向 stderr 报告业务诊断');

    // 预期 2：移除注入后同一入口真实计算并输出汇总
    const good = await run();
    assert.equal(good.code, 0, '正常路径应成功退出');
    assert.equal(good.stdout, 'done 1/2\n', '汇总应来自真实计算');
  } finally {
    remove?.();
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});
```

## 12. 浏览器面（需真实浏览器——示例例外）

`lite-browser` 直接用 Playwright 浏览器 API（共享单例，默认无头），本节示例需真实浏览器执行，是「示例块可执行」约定的唯一例外：

```js
import browser from 'litenvi-node/lite-browser.mjs';

await browser.open(); // 启动或复用共享浏览器；{ headless: false } 显式有头
try {
  await browser.page().goto('http://127.0.0.1:8888/'); // 配合 lite-server.t_port() 的回环端口
} finally {
  await browser.close();
}
```

页面侧定时控制走 `lite-browser-timer`：页面经正常 ESM URL / import map 加载该模块，**测试控制代码也必须在页面内导入同一 URL**（Node 端状态不跨进程传入页面）；`timer.t_mock()` 后用 `t_fireSingalTimeout()` 触发挂起的超时信号、`await t_tickIntervals()` 手动推进周期定时一轮。页面导航会得到新模块实例，须在新页面重新启用 gate。

## 13. Agent 须知

为业务项目写测试的 Agent，按以下顺序建立口径，不要凭直觉猜 API：

1. **读规格**：目标模块头注释（行为规格）→ [README.md](README.md) 对应章节 → [user-api.md](user-api.md) 签名速查 → `scripts/tests/` 既有用例（写法范本）。
2. **黑盒口径**：只走公共接口与 `t_` 接口。配置行为用 `mgr.command(...).t_onRun/t_inject`，执行轨迹用 `t_calls()`，不要绕到 `i_` 内部协作面。
3. **范围纪律**：能维护的代码显式用 lite 组件；不能控制的第三方依赖经消费项目自己的代理调用，不要把业务专用代理或假响应搬进 litenvi-node。
4. **示例块纪律**：js 示例块按可真实执行的标准写——块内只用 `'litenvi-node/…'` 包自引用 specifier、自带归位（try/finally + `t_unmock`）；需真实浏览器/外部服务的示例明确标注例外。
5. **修改本仓库本身**（lite-* 源码、命令集、scripts/tests/ 用例、README 规格）时，改用 **`litenvi-node-dev`** skill；业务项目里装配测试环境见 **`litenvi-node-use`** skill。

## 14. 常见坑速查

- **Git 忘了 `t_install()`** → 执行返回 `ENOENT`。
- **`liteFs.t_mock()` 不传 `exclude`** → 直接报错：必须声明非空黑名单（系统本体留在真实 fs）。
- **`spawnSync('node', 脚本)`** → 明确失败：node 脚本只有异步执行面，用 `spawn` + `waitForClose`。
- **漏了 `try/finally` 归位** → 门面单例状态泄漏到后续用例；起手 `t_unmock()` 复位。
- **故障 `exit: 0`** → 校验拒绝：`exit` 须 ≥1，要「命中后放行再失败」用 `wait` 闸门。
- **URL 注入查询串** → 完整顺序精确匹配，参数顺序或数量变化即不命中；宽松匹配改用 `path` / `query`。
- **`exec` 的 shell 语法** → 内存 `/bin/sh -c` 只支持引号、`;`/`&&`/`||`、管道、重定向、局部 `cd`；命令替换、通配符、循环明确报错。
- **`lite-timer` 遮蔽范围** → 只有被注入模块走虚拟时钟；`process.hrtime`、`performance`、真实 I/O 时刻不经门面。
- **浏览器 gate 控制写在了 Node 端** → 控制不到页面；控制代码必须运行在页面内同一 URL 的模块实例上。
- **npm run 同步面** → 仅异步实现的命令按 127 失败；pre/post 钩子、`npm test` 别名等明确报错而非静默跳过。

## 15. 延伸阅读

- [README.md](README.md)：各门面行为规格（含未覆盖面的如实声明）。
- [user-api.md](user-api.md)：公开与测试专用接口签名速查（生成自源码扫描）。
- [AGENTS.md](AGENTS.md)：本仓库的模块地图、方法隔离契约与开发流程。
- `skills/litenvi-node-use/` 与 `skills/litenvi-node-dev/`：使用侧 / 开发侧 Agent 指南。
