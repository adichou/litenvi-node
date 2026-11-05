# litenvi-node

通过 `lite-*` 门面装配 Node 与浏览器测试环境。默认透传原生实现；显式 `t_mock()` 后使用内存文件系统、命令执行、Git、HTTP 或可控时钟。业务逻辑与路由仍来自完整生产源码。

旧 `environment.mjs`、VM/原生 worker 装配、快照与旧浏览器适配入口已退役。调用方应直接使用 lite 门面；ATB 的 MEIT 本地库校验同步核验 lite 入口。

## lite-http 门面

`litenvi-node/lite-http.mjs` 是 node:http 客户端的可切换门面，供业务代码统一 import：默认（未设置内存实现）原样转发真实 `node:http`，生产行为不变。`t_mock()` 设置内存 http 实现（幂等，复用当前实例）、`t_unmock()` 移除并回到真实实现（规则随实例丢弃）。错误注入是内存实现上的能力：`t_inject({ url?, method?, path?, query?, status?: 400..599, wait?, once?, error?/body? })` 增加规则并返回移除函数；至少指定错误状态或 Promise 闸门。命中传输层错误时不执行 handler；未命中则经 `lite-server` 执行真实 handler，无监听服务时按 `ECONNREFUSED` 拒连。`liteServer.t_inject()` 使用相同匹配条件，作用于 handler 执行后的响应阶段。回调式 `request/get` 与真实 ClientRequest 消费面兼容（statusCode / data / end / error 事件）；状态为模块级单例，同进程内经同一 specifier 导入（含动态 `import()`）共享同一实例。

`liteServer.t_inject({ operation: 'close', wait, once: true })` 可使服务实际关闭后的 close 事件和回调等待 Promise 闸门，用于模拟关闭收尾挂起；该规则不影响请求响应。移除规则只阻止后续命中，已命中的闸门仍须由调用方释放。内存 Node 子进程注册了信号监听器时，`child.kill()` 将信号送入该进程的监听器；没有监听器时按信号终止，`SIGKILL` 始终直接终止。

`liteServer.createServer(handler)` 支持同时创建多个服务。普通 `listen(0)` 继续绑定回环端口，供浏览器访问；模拟外部服务可使用 `listen({ host: 'api.example.test', port: 443, virtual: true }, callback)`，只在内存中注册域名与端口，不绑定 socket。启用 `liteHttp.t_mock()` 和 `liteServer.t_mock()` 后，发往该域名端口的请求由对应 handler 处理，其他域名不会误入该服务，也不会外联。各服务可独立关闭；`liteServer.t_port()` 返回第一个仍在监听的回环服务端口。使用前可通过 `liteServer.isMocked()` 检查门面状态。


两个入口均支持按 URL 注入，例如 `liteHttp.t_inject({ url: 'http://localhost:8080/api/health?full=1', method: 'GET', status: 503, once: true })`，或 `liteServer.t_inject({ url: '/api/health?full=1', status: 503 })`。`url` 接受字符串或 `URL` 对象：绝对 HTTP/HTTPS URL 精确比较规范化后的 origin、pathname 和 search（主机名大小写、默认端口按 URL 标准规范化），以 `/` 开头的路径 URL 只比较 pathname 和 search；两者均忽略 fragment。查询串按完整顺序精确比较，额外参数、重复参数的顺序变化也不会命中；需要忽略查询串时继续使用 `path`，需要部分查询匹配时使用 `query`。`url/method/path/query` 同时提供时全部满足才命中；不指定 `method` 时适用于所有 HTTP 方法，不指定任何匹配条件时保持全局规则。请求 origin 优先采用请求的 `Host` 头，缺省使用请求配置的 hostname/host 和端口；真实 socket 回灌保留原始 Host，不会因为内部连接回环地址而改变匹配来源。`once` 仅在完整匹配时消耗，`wait` 也只挂起匹配的 URL。

## lite-process 门面

`litenvi-node/lite-process.mjs` 提供进程环境门面，默认透传真实 `process`。测试通过 `t_mock({ cwd, argv?, env?, pid? })` 设置模拟环境，通过 `t_exitCodes()` 读取退出意图，通过 `t_unmock()` 恢复原生环境。子进程执行由 `lite-child_process` 提供，命令脚本与故障通过命令句柄的 `t_onRun/t_inject` 配置。

## lite-fs 门面

`litenvi-node/lite-fs.mjs` 是 `node:fs` 的可切换门面。`t_mock({ exclude: [...] })` 声明保留真实访问的源码或静态资源目录，排除目录之外的路径全部使用内存卷；未 mock 时透传真实文件系统。内存卷覆盖常用同步文件操作，并支持 `readdirSync(..., { withFileTypes: true })` 的文件、目录和符号链接类型。`copyFileSync` 从排除目录复制到内存路径时读取真实源、只写入内存目标，可用 `COPYFILE_EXCL` 防止覆盖；其他多路径操作仍按首个路径选择作用域。`t_inject({ op?, path?, code })` 可向内存操作注入错误，返回移除函数；内存范围内未实现的操作会明确报错。

## lite-child_process 执行接口

`lite-child_process` 提供 `spawn/spawnSync`、`exec/execSync`、`execFile/execFileSync`。默认转发原生 Node；`t_mock()` 后全部经内存命令分派并统一记入 `t_calls()`，`t_reset()` 仅清账本。

`execFile(file, args?, options?, callback?)` 按字面 argv 执行，默认以 UTF-8 字符串回调 `(error, stdout, stderr)`；异步接口返回子进程，支持超时、AbortSignal、maxBuffer 和 `promisify`（Promise 上有 `child`，成功值为 `{ stdout, stderr }`）。同步接口默认返回 Buffer，非零退出或启动失败时抛出携带执行结果的错误。

`exec(command, ...)` 使用内存 `/bin/sh -c`；exec 适配和 shell 实现均为 `lite-child_process.mjs` 的私有方法，解析复用 `shell-quote@1.12.0`（MIT）。当前支持普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1` 和局部 `cd`。命令替换、通配符、循环等完整 shell 语法尚未实现；mock 不启动真实 shell。Node 脚本的同步执行限制保持现状；`fork/IPC` 尚未提供。

`mgr.command(nameOrPath)` 查询已登记的命令句柄；Git 须先调用 `t_install()`，之后可在内存卷建立前配置 `t_onRun/t_inject`；`mgr.pkg_resolve(nameOrPath)` 是包内执行寻址接口，要求命令文件存在，首次可惰性安装系统命令。命令对象的 `t_onRun/t_inject` 为测试专用配置接口，不再提供 `mgr.inject`；`pkg_takeFault/pkg_runSync` 供包内执行层协作；测试通过上述 child_process 公共接口触发执行。

Git 命令需要显式安装：`import { t_install } from 'litenvi-node/lite-cmd-git.mjs'; t_install();`。仅导入模块不会登记 Git，也不会创建 Git 命令文件；未安装时内存子进程执行 Git 返回 `ENOENT`。`t_install()` 可在建立内存卷之前或之后调用：卷尚未建立时先登记，执行命令时由管理器安装命令文件；系统卷已存在时立即补齐 Git 文件。重复调用保持幂等，保留已配置的脚本钩子和故障规则。

Git 的故障注入可指定子命令，例如 `mgr.command('git').t_inject({ subcommand: 'add', exit: 128, stderr: 'index.lock', once: true })`。规则只对指定子命令生效；支持跳过 `-c <配置>`、`-C <目录>`、`--no-optional-locks`、`--no-pager` 和 `--literal-pathspecs` 全局选项。规则按注入顺序选取首个匹配项，`once` 仅在命中时消费；未指定 `subcommand` 时仍匹配该命令的所有调用。同步与异步执行均遵循此规则，返回的函数可解除故障。

内存 Git 为 `add`、`rm`、`commit` 模拟独占索引锁；锁已存在时返回冲突并保留原锁。`status` 采用简化的可选锁模型：默认尝试持锁，锁已被占用时继续读取；`--no-optional-locks` 不尝试持锁。真实 Git 是否执行可选索引刷新取决于仓库状态，这里默认尝试持锁是为了提供可控的竞争场景，不代表真实 Git 每次扫描均会加锁。其他 Git 写命令的锁语义尚未模拟。

需要在同步扫描期间测试并发写入时，可通过命令注入框架注册同步检查点；回调在扫描尚未完成时执行，可重入内存 Git 命令。用完必须调用返回的移除函数，避免影响其他用例：

```js
import { t_install } from 'litenvi-node/lite-cmd-git.mjs';
import mgr from 'litenvi-node/lite-cmd-mgr.mjs';

t_install();
const remove = mgr.command('git').t_inject({
  checkpoint: 'status-scan',
  onHit({ root, lockPath, lockAcquired, optionalLocks }) {
    // 在此观察锁状态，或触发另一条内存 Git 命令。
  },
});
try {
  // 从页面或 Agent 入口触发实际扫描。
} finally {
  remove();
}
```

检查点只接受同步回调；它通过同步重入模拟确定的重叠次序，不创建真实并行进程或模拟操作系统调度。可设置 `once: true`，使规则在首次到达检查点时移除；该规则与命令失败或等待故障分别生效，不与它们写在同一次注入中。

内存 Git 支持 `git rm [-q] [-r] -- <路径>`：删除已跟踪文件并暂存删除；有未提交修改时拒绝删除，目录须指定 `-r`，其他选项明确报错。`git add` 对工作树和暂存区均无匹配项的路径返回错误；已暂存删除可由 `git commit --only -- <路径>` 收录。提交内容可经 `git show HEAD:<路径>` 等命令核验。

## 验证

运行 `npm test`。通用环境测试与项目的业务测试互补；内存 Git、工具链和浏览器组件模拟不代表真实网络、真实浏览器或平台验收。


## lite-browser 浏览器门面

`lite-browser.mjs` 是独立的共享浏览器门面，直接使用 `playwright` 浏览器 API，不加载 `@playwright/test` 测试框架。通过本地软链接引用 litenvi-node 时，即使调用方与库各有一份 Playwright 安装，也不会重复初始化测试框架；调用方仍可使用自己的 `@playwright/test` 断言。

浏览器默认无头。`open({ headless: false })` 显式启用有头模式，供特定排查场景在调用处按需开启（模式只由显式参数决定，不提供全局开关）。单例在既有实例上收到异模式请求时关停重建（控制台告警提示），同模式保持幂等复用；实例对象携带生效模式（`shared.headless`）。

浏览器超时信号由 `lite-browser-timer.mjs` 提供显式门面：业务导入 `AbortSignal` 或使用默认对象的 `AbortSignal`；默认透传原生超时、abort/any 与原型，页面全局不被替换。`t_mock()`（或 `{ mode: 'gate' }`）挂起之后经门面创建的 timeout 信号，`t_triggerSignalTimeout()` 以原生 `TimeoutError` 触发当前批次；`t_unmock()` 以 `AbortError` 清理仍挂起的信号并恢复默认行为。缓存过的门面 timeout 函数同样跟随开关。浏览器应通过正常 ESM URL/import map 加载同一个模块；测试控制也必须在该页面内导入同一个 URL，Node 端状态不会跨进程传入页面。页面导航自然创建新实例，不使用 addInitScript 或 AbortSignal 全局改写。旧的浏览器信号控制入口已移除。

```js
import timer, { AbortSignal } from 'litenvi-node/lite-browser-timer.mjs';

// 业务：默认走原生；同一页面模块被 mock 后走 gate。
const signal = AbortSignal.timeout(5000);

// 测试：在页面内控制同一模块实例。
timer.t_mock();
const pending = timer.AbortSignal.timeout(5000);
timer.t_triggerSignalTimeout();
timer.t_unmock();
```

配合调用方已经启动的本地服务使用：

```js
import browser from 'litenvi-node/lite-browser.mjs';

await browser.open();
try {
  await browser.page().goto('http://127.0.0.1:8888/');
} finally {
  await browser.close();
}
```

## lite-timer 门面

`litenvi-node/lite-timer.mjs` 是 Node 侧定时器与时钟替身门面，面向「按模块遮蔽注入」的用法：测试装配（`node:module` register hook）向被测模块源码头部注入 `import { setTimeout, clearTimeout, setInterval, clearInterval, Date } from 'litenvi-node/lite-timer.mjs'`，ESM import 绑定遮蔽全局，仅被注入模块的定时器与 Date 运行在虚拟时钟上，宿主进程不受影响。未 mock 时五个绑定原样转发原生实现，生产行为不变。

`t_mock({ now? })` 从给定纪元（数值毫秒或可解析时间字符串，缺省当前真实时刻）进入冻结世界：定时器只在 `t_advanceMs(ms)` 推进时到期派发（tickAsync 口径，回调间微任务沉淀），`Date.now()` / `new Date()` / `Date()` 返回虚拟当前时刻，`new Date(x)` 与 `parse`/`UTC` 等静态面透传原生。重复 `t_mock` 幂等保留既有纪元与在途定时器；`t_unmock()` 丢弃时钟与未触发定时器并恢复原生。`now()` 返回当前（虚拟或真实）时刻。时钟本体复用 `@sinonjs/fake-timers` 的 `createClock`（不 `install`，不触碰宿主全局）。`process.hrtime`、`performance`、`queueMicrotask` 与真实 I/O 到达时刻不经本门面。与 `lite-browser-timer` 的分工：那是页面端 `AbortSignal.timeout` 的 gate 门面，本模块面向 Node 侧普通定时器，两端互不感知。

```js
// 测试装配：向被测模块注入遮蔽绑定（示意）。
import { setTimeout, Date } from 'litenvi-node/lite-timer.mjs';
import timer from 'litenvi-node/lite-timer.mjs';

timer.t_mock({ now: '2026-10-08T04:00:00.000Z' });
Date.now(); // → 虚拟纪元
await timer.t_advanceMs(5 * 60_000); // 推过单项时限，到期回调派发
timer.t_unmock();
```


## 方法隔离

方法按用途分为四类：

- `f_`：文件私有，不导出。
- `pkg_`：仅供同一包内模块协作。
- `t_`：测试专用，只允许测试代码及其夹具引用或调用；生产代码不得导入、读取、转存或调用。
- 无前缀：公共运行接口，生产代码与测试均可使用。

测试专用接口包括 `t_mock/t_unmock/t_inject`、子进程的 `t_calls/t_reset`、服务端的 `t_port/t_requests/t_resetRequests`、进程的 `t_exitCodes`、Node 时钟的 `t_advanceMs`、浏览器时钟的 `t_triggerSignalTimeout`、命令管理器的 `t_defineUserCommand/t_defined`，以及命令句柄的 `t_inject/t_onRun`。不保留旧的无前缀别名；时钟具名导出也使用新名称。原生 API 和请求/响应数据字段保持原名。

当前通过命名和方法注释表达访问约定，暂未增加 ESLint 或运行时访问限制。

`mgr.pkg_defineCommand/pkg_resolve`、命令条目的 `pkg_takeFault/pkg_runSync`、`liteProcess` 模块的 `pkg_commandContext`、`liteChildProcess.pkg_signal`、`liteServer.pkg_handle` 为内部接口。`lite-cmd-node/-os` 的命令表和 Node 路径常量以 `pkg_` 导出；`lite-cmd-git` 导出测试专用的 `t_install()`，仅显式调用后安装命令，不导出原始命令条目。`f_installArgv`、`f_liveRequests` 与 exec/shell 辅助方法保持文件内私有。

`t_mock()` 返回公共门面，私有运行态不作为返回值暴露。`isMocked()` 是公开的状态查询；`liteFs.markPersistent()` 是公开的持久目录配置，均允许测试使用。命令实现（含 `t_defineUserCommand` 的实现对象）统一声明 `pkg_run/pkg_runSync`，仅供包内执行层分派，不保留 `run/runSync` 别名。外部调用方应使用 `child_process` 的 `spawn/spawnSync`、`exec/execSync` 或 `execFile/execFileSync` 执行命令；`mgr.command(...)` 同时供包内执行层查询命令；测试通过该句柄配置 `t_inject/t_onRun`。

`lite-cmd-mgr` 的 `f_install()` 仅在本文件内使用，不挂到默认导出对象；命令文件由公共执行入口触发惰性安装，测试不直接调用安装方法。
