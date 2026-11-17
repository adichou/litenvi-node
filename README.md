# litenvi-node

通过 `lite-*` 门面装配 Node 与浏览器测试环境。默认透传原生实现；显式 `t_mock()` 后使用内存文件系统、命令执行、Git、HTTP 或可控时钟。业务逻辑与路由仍来自完整生产源码。

旧 `environment.mjs`、VM/原生 worker 装配、快照与旧浏览器适配入口已退役。调用方应直接使用 lite 门面。

## lite-http 门面

客户端与服务端共用包内 `i-http-transport.mjs`，两个门面不互相导入。该内部模块只提供 `i_` 接口，负责传输层故障和已登记服务的路由分派，不提供公共入口或独立 mock 开关。使用方继续通过现有门面操作：`lite-http` 适配客户端事件与响应流，`lite-server` 处理监听、真实 handler、响应阶段故障、socket 回写和观测。客户端复位清除传输层故障，服务端复位撤销路由并清除服务端故障，两侧互不清理对方配置；已经命中的请求保留各自的故障配置。

`litenvi-node/lite-http.mjs` 是 node:http 与 node:https 客户端的可切换门面，供业务代码统一 import：默认（未设置内存实现）原样转发真实 `node:http` / `node:https`（`request/get` 走 http，`httpsRequest/httpsGet` 走 https，对象形态 options 缺省补 protocol `'https:'`，与原生语义一致），生产行为不变。`t_mock()` 设置内存 http 实现（幂等，复用当前实例）、`t_unmock()` 移除并回到真实实现（规则随实例丢弃）。错误注入是内存实现上的能力：`t_inject({ url?, method?, path?, query?, status?: 400..599, wait?, once?, error?/body? })` 增加规则并返回移除函数；至少指定错误状态或 Promise 闸门。命中传输层错误时不执行 handler；未命中则经 `lite-server` 执行真实 handler，无监听服务时按 `ECONNREFUSED` 拒连。`liteServer.t_inject()` 使用相同匹配条件，作用于 handler 执行后的响应阶段。回调式 `request/get/httpsRequest/httpsGet` 与真实 ClientRequest 消费面兼容（statusCode / data / end / error 事件）；https 面 mock 后走同一内存传输（协议标记进入匹配 URL 与 443 端口缺省，内存世界不真实外联）；状态为模块级单例，同进程内经同一 specifier 导入（含动态 `import()`）共享同一实例。

`liteServer.t_inject({ operation: 'close', wait, once: true })` 可使服务实际关闭后的 close 事件和回调等待 Promise 闸门，用于模拟关闭收尾挂起；该规则不影响请求响应。移除规则只阻止后续命中，已命中的闸门仍须由调用方释放。内存 Node 子进程注册了信号监听器时，`child.kill()` 将信号送入该进程的监听器；没有监听器时按信号终止，`SIGKILL` 始终直接终止。

`liteServer.createServer(handler)` 支持同时创建多个服务。普通 `listen(0)` 继续绑定回环端口，供浏览器访问；模拟外部服务可使用 `listen({ host: 'api.example.test', port: 443, virtual: true }, callback)`，只在内存中注册域名与端口，不绑定 socket。启用 `liteHttp.t_mock()` 和 `liteServer.t_mock()` 后，发往该域名端口的请求由对应 handler 处理，其他域名不会误入该服务，也不会外联。各服务可独立关闭；`liteServer.t_port()` 返回第一个仍在监听的回环服务端口。使用前可通过 `liteServer.isMocked()` 检查门面状态。


两个入口均支持按 URL 注入，例如 `liteHttp.t_inject({ url: 'http://localhost:8080/api/health?full=1', method: 'GET', status: 503, once: true })`，或 `liteServer.t_inject({ url: '/api/health?full=1', status: 503 })`。`url` 接受字符串或 `URL` 对象：绝对 HTTP/HTTPS URL 精确比较规范化后的 origin、pathname 和 search（主机名大小写、默认端口按 URL 标准规范化），以 `/` 开头的路径 URL 只比较 pathname 和 search；两者均忽略 fragment。查询串按完整顺序精确比较，额外参数、重复参数的顺序变化也不会命中；需要忽略查询串时继续使用 `path`，需要部分查询匹配时使用 `query`。`url/method/path/query` 同时提供时全部满足才命中；不指定 `method` 时适用于所有 HTTP 方法，不指定任何匹配条件时保持全局规则。请求 origin 优先采用请求的 `Host` 头，缺省使用请求配置的 hostname/host 和端口；真实 socket 回灌保留原始 Host，不会因为内部连接回环地址而改变匹配来源。`once` 仅在完整匹配时消耗，`wait` 也只挂起匹配的 URL。

## lite-process 门面

`litenvi-node/lite-process.mjs` 提供进程环境门面，默认透传真实 `process`。测试通过 `t_mock({ cwd, argv?, env?, pid? })` 设置模拟环境，通过 `t_exitCodes()` 读取退出意图，通过 `t_unmock()` 恢复原生环境。子进程执行由 `lite-child_process` 提供，命令脚本与故障通过命令句柄的 `t_onRun/t_inject` 配置。

模拟退出使用公开的 `ProcessExitError` 类型，携带 `exitCode`，供调用方识别和处理退出意图。所有使用方直接从 `litenvi-node/lite-process-exit-error.mjs` 导入该类型，命令实现与执行层共用同一个类。该模块不依赖其他门面；`lite-process` 负责进程环境，`lite-cmd-mgr` 负责命令管理，均不转出退出异常。

## lite-os 门面

`litenvi-node/lite-os.mjs` 是 node:os 路径锚点与只读标识的可切换门面：默认原样转发真实 `node:os`，生产行为不变。`t_mock({ homedir?, tmpdir?, platform?, arch?, hostname? })` 按键覆盖（已覆盖时按键合并），`t_unmock()` 移除。给出的键替换为指定值，未给出的键与本机同源（只读合理缺省）。`homedir/tmpdir` 是内存世界的路径锚点——注册表、用户级配置等 `<home>/.…` 路径的落点，覆盖后所有经本门面的路径解析随之落入调用方装配的世界；`EOL` 为静态常量原样透传。状态为模块级单例，同进程内经同一 specifier 导入共享同一实例。

## lite-fs 门面

`litenvi-node/lite-fs.mjs` 是 `node:fs` 的可切换门面。`t_mock({ exclude: [...] })` 声明保留真实访问的源码或静态资源目录，排除目录之外的路径全部使用内存卷；未 mock 时透传真实文件系统。内存卷覆盖常用同步文件操作，并支持 `readdirSync(..., { withFileTypes: true })` 的文件、目录和符号链接类型；`statSync` 逐段解析符号链接（跟随链接链，循环 ELOOP；`lstatSync` 保留链接条目且 size 为目标字符串字节长），rename 覆盖既有目标按 rename(2) 口径报 EISDIR/ENOTDIR/ENOTEMPTY，错误码与 syscall 标签（如 `rm` 缺失的 `lstat`、`utimes` 缺失的 `utime`、`copyfile`）对齐原生。`copyFileSync` 从排除目录复制到内存路径时读取真实源、只写入内存目标，可用 `COPYFILE_EXCL` 防止覆盖（卷内复制同样支持 EXCL 与 copyfile 口径错误）；其他多路径操作仍按首个路径选择作用域。`t_inject({ op?, path?, code })` 可向内存操作注入错误，返回移除函数；内存范围内未实现的操作会明确报错。

## lite-child_process 执行接口

`lite-cmd-node` 在进程内执行完整脚本，提供命令参数、输入输出、退出、信号和资源生命周期；不再自动包装原生 `node:fs` 方法或改写其 ESM 具名导出。自研脚本须显式导入 `litenvi-node/lite-fs.mjs` 访问内存卷；`spawn` 的 `input` 仍可通过 `liteFs.readFileSync(0, 'utf8')` 同步读取。原生 `fs` 调用保持原生行为，第三方业务能力通过消费项目自己的代理控制，不能依赖虚拟 Node 自动隔离任意文件访问。

`lite-cmd-node` 的入口检查通过 lite-fs，真实入口及其代码资源须由调用方在 `exclude` 中明确登记。`node --test <文件…>` 的 Worker 启动逻辑内置于 `lite-cmd-node.mjs` 的私有方法，无独立入口文件；在独立 Worker 中调用原生 `node:test`（`isolation: 'none'`），支持 `--test-name-pattern <表达式>`／`--test-name-pattern=<表达式>`、`--experimental-test-coverage`、覆盖率范围旗标 `--test-coverage-include`／`--test-coverage-exclude`（空格与等号取值均可、可重复，经 `run()` 的 `coverageIncludeGlobs`／`coverageExcludeGlobs` 透传，语义与原生命令一致——显式 include 会覆盖 node_modules 默认排除）及 `--` 后的字面文件路径。输出为真实 TAP 与实际 V8 覆盖率，失败退出 1，每次运行独立模块缓存，不启动 OS 子进程；终止或取消同步回收 Worker。测试 Worker 的 lite 模块单例与父世界独立，测试文件需自行装配自己的数据环境。测试文件只存在于内存卷时不能由原生模块加载器执行；没有显式文件或未知测试选项明确失败，不回放结果、不静默退回普通 import。

模拟 `npm -v`／`npm --version` 固定返回 `10.9.0`，`npm --versions`／`npm --versions --json` 返回 2026-11-09 本机采集并固化的工具链信息（Node `22.12.0`、V8 `12.4.254.21-node.21` 等；仅工具链字段，不包含按当前目录变化的项目版本）。不扫描宿主 PATH、不读取本机 npm 安装信息。`npm run <script> [-- args]` 在内存世界执行：自 cwd 逐级向上读最近 `package.json` 的 `scripts[name]`，经 shell-quote 解析为单命令 argv 后经内存分派执行（操作符／管道／重定向等 shell 语法明确报错），banner（`> name@version script` 与命令行，模拟口径统一记 stdout）、嵌套输出与退出码透传，未登记命令报 127，`--` 之后的参数原样追加；同步面要求嵌套命令提供同步实现，仅异步的命令（如 node 脚本）按其自身限制或 127 明确失败。pre/post 生命周期钩子、`npm test`／`start` 等别名、`node_modules/.bin` PATH 前缀与 `npm_*` 环境变量未实现，调用即明确报错；其他 npm 子命令仍明确未实现。未开启 mock 时继续透传真实命令。

`lite-child_process` 提供 `spawn/spawnSync`、`exec/execSync`、`execFile/execFileSync`。默认转发原生 Node；`t_mock()` 后全部经内存命令分派并统一记入 `t_calls()`，`t_reset()` 仅清账本。内存 `spawn` 支持 `options.timeout`：到期以 `killSignal`（缺省 `SIGTERM`）终止，`exit`/`close` 带信号、不发 `error` 事件，提前退出时撤销定时器（对齐原生）。

`execFile(file, args?, options?, callback?)` 按字面 argv 执行，默认以 UTF-8 字符串回调 `(error, stdout, stderr)`；异步接口返回子进程，支持超时、AbortSignal、maxBuffer 和 `promisify`（Promise 上有 `child`，成功值为 `{ stdout, stderr }`）。同步接口默认返回 Buffer，非零退出或启动失败时抛出携带执行结果的错误。

`exec(command, ...)` 使用内存 `/bin/sh -c`；exec 适配和 shell 实现均为 `lite-child_process.mjs` 的私有方法，解析复用 `shell-quote@1.12.0`（MIT）。当前支持普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1` 和局部 `cd`。命令替换、通配符、循环等完整 shell 语法尚未实现；mock 不启动真实 shell。Node 脚本的同步执行限制保持现状；`fork/IPC` 尚未提供。

`mgr.command(nameOrPath)` 查询已登记的命令句柄；Git 须先调用 `t_install()`，之后可在内存卷建立前配置 `t_onRun/t_inject`；`mgr.i_resolve(nameOrPath)` 是包内执行寻址接口，要求命令文件存在，首次可惰性安装系统命令。命令对象的 `t_onRun/t_inject` 为测试专用配置接口，不再提供 `mgr.inject`；`i_takeFault/i_runSync` 供包内执行层协作；测试通过上述 child_process 公共接口触发执行。

`command.t_onRun((call, runBuiltin) => result)` 同时拦截同步和异步执行。`call` 包含 `argv` 与 `options`；返回 `{ status, stdout, stderr, signal? }` 替换命令结果，返回 `undefined` 回落内置实现。异步入口允许钩子返回 Promise，可用显式闸门控制完成时机；同步入口遇到 Promise 明确失败。`runBuiltin()` 惰性且同次执行只运行一次：同步实现返回结果对象，异步实现返回聚合输出的 Promise，钩子可等待后改写结果。只有存在钩子时才聚合异步内置输出，无钩子时保留流式执行。故障注入先于钩子；取消或卸载世界后不会再投递迟到结果。用完须 `t_onRun(null)` 清理。

例如，页面只验证如何处理外部 Node 测试结果时，可以对 `node --test` 设置钩子返回 TAP 和退出码，无须给模块加载器提供真实测试源码。此时只验证消费命令输出的业务行为，不代表实际执行了 Node 测试或测得覆盖率；命令自身的执行能力仍由库的独立测试验证。

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

ESLint 规则与配置直接使用官方 API 测试：单条规则使用 `RuleTester`，配置工厂的实际效果使用 `Linter.verify()` 或 `ESLint.lintText()`，需要验证真实配置加载与命令行行为时运行真实 ESLint。规则需要扫描项目数据时，继续显式使用 lite-fs 准备内存文件；无需模拟 ESLint 命令或生成临时配置模块。

仓库自身的 `npm run lint` 仍使用真实 ESLint 开发依赖。内存子进程只执行已登记的命令；不会把未登记命令自动转交给宿主。

## 验证

运行 `npm test`。通用环境测试与项目的业务测试互补；内存 Git、工具链和浏览器组件模拟不代表真实网络、真实浏览器或平台验收。

文档与实现的对齐由 AI 按语义校验，不由测试守护；测试守护模块行为口径（每个模块测试文件含包自引用单例检查）。示例代码块均可真实执行（需真实浏览器/外部服务的示例除外）：块内只用包自引用 specifier、自带归位。


## lite-browser 浏览器门面

`lite-browser.mjs` 是独立的共享浏览器门面，直接使用 `playwright` 浏览器 API，不加载 `@playwright/test` 测试框架。通过本地软链接引用 litenvi-node 时，即使调用方与库各有一份 Playwright 安装，也不会重复初始化测试框架；调用方仍可使用自己的 `@playwright/test` 断言。

浏览器默认无头。`open({ headless: false })` 显式启用有头模式，供特定排查场景在调用处按需开启（模式只由显式参数决定，不提供全局开关）。单例在既有实例上收到异模式请求时关停重建（控制台告警提示），同模式保持幂等复用；实例对象携带生效模式（`shared.headless`）。

浏览器超时信号由 `lite-browser-timer.mjs` 提供显式门面：业务导入 `AbortSignal` 或使用默认对象的 `AbortSignal`；默认透传原生超时、abort/any 与原型，页面全局不被替换。`t_mock()`（或 `{ mode: 'gate' }`）统一启用信号和周期 Mock，挂起之后经门面创建的 timeout 信号，`t_fireSingalTimeout()` 以原生 `TimeoutError` 触发当前批次；`t_unmock()` 以 `AbortError` 清理仍挂起的信号并恢复默认行为。缓存过的门面 timeout 函数同样跟随开关。浏览器应通过正常 ESM URL/import map 加载同一个模块；测试控制也必须在该页面内导入同一个 URL，Node 端状态不会跨进程传入页面。页面导航自然创建新实例，不使用 addInitScript 或 AbortSignal 全局改写。旧的浏览器信号控制入口已移除。

周期定时通过同一模块的 `setInterval/clearInterval` 门面控制。默认返回原生句柄；`t_mock()` 同时启用周期 gate，清除门面已登记的原生周期并保留回调，后续周期注册也挂起。`await t_tickIntervals()` 手动推进当前周期一轮并等待全部异步回调完成，保留参数和浏览器全局接收者；某个回调失败时，待本轮全部结束后向测试传播错误。已清除周期不执行，回调中新建周期留给下一轮。不支持 `signals`、`intervals` 选择性参数，传入这些旧参数会报错。gate 支持函数回调；`t_unmock()` 丢弃挂起周期，之后的新调用恢复原生，不自动重启旧周期。页面导航会获得新模块实例，测试须在新页面重新启用 gate；不依赖全局标记或自动启用。

```js
import timer, { AbortSignal } from 'litenvi-node/lite-browser-timer.mjs';

// 业务：默认走原生；同一页面模块被 mock 后走 gate。
const signal = AbortSignal.timeout(5000);

// 测试：在页面内控制同一模块实例。
timer.t_mock();
const pending = timer.AbortSignal.timeout(5000);
timer.t_fireSingalTimeout();
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

`t_mock({ now? })` 从给定纪元（数值毫秒或可解析时间字符串，缺省当前真实时刻）进入冻结世界：定时器只在 `t_advanceMs(ms)` 推进时到期派发（tickAsync 口径，回调间微任务沉淀），`Date.now()` / `new Date()` / `Date()` 返回虚拟当前时刻，`new Date(x)` 与 `parse`/`UTC` 等静态面透传原生。重复 `t_mock` 幂等保留既有纪元与在途定时器；`t_unmock()` 丢弃时钟与未触发定时器并恢复原生。`now()` 返回当前（虚拟或真实）时刻。时钟本体复用 `@sinonjs/fake-timers` 的 `createClock`（不 `install`，不触碰宿主全局）。`process.hrtime`、`performance`、`queueMicrotask` 与真实 I/O 到达时刻不经本门面。与 `lite-browser-timer` 的分工：那是页面端超时信号与周期定时的 gate 门面，本模块面向 Node 侧普通定时器，两端互不感知。

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
- `i_`：仅供同一包内模块协作。
- `t_`：测试专用，只允许测试代码及其夹具引用或调用；生产代码不得导入、读取、转存或调用。
- 无前缀：公共运行接口，生产代码与测试均可使用。

测试专用接口包括 `t_mock/t_unmock/t_inject`、子进程的 `t_calls/t_reset`、服务端的 `t_port/t_requests/t_resetRequests`、进程的 `t_exitCodes`、Node 时钟的 `t_advanceMs`、浏览器时钟的 `t_fireSingalTimeout/t_tickIntervals`、命令管理器的 `t_defineUserCommand/t_defined`，以及命令句柄的 `t_inject/t_onRun`。不保留旧的无前缀别名；时钟具名导出也使用新名称。原生 API 和请求/响应数据字段保持原名。

当前通过命名和方法注释表达访问约定，暂未增加 ESLint 或运行时访问限制。

`mgr.i_defineCommand/i_resolve`、命令条目的 `i_takeFault/i_runSync`、`liteProcess` 模块的 `i_commandContext`、`liteChildProcess.i_signal` 与 `i-http-transport.mjs` 的所有 `i_` 接口为内部接口。HTTP 服务路由由服务端向 transport 登记，客户端和 socket 前端通过同一管线分派。`lite-cmd-node/-os` 的命令表和 Node 路径常量以 `i_` 导出；`lite-cmd-git` 导出测试专用的 `t_install()`，仅显式调用后安装命令，不导出原始命令条目。`f_installArgv`、`f_liveRequests` 与 exec/shell 辅助方法保持文件内私有。

`t_mock()` 返回公共门面，私有运行态不作为返回值暴露。`isMocked()` 是公开的状态查询；`liteFs.markPersistent()` 是公开的持久目录配置，均允许测试使用。命令实现（含 `t_defineUserCommand` 的实现对象）统一声明 `i_run/i_runSync`，仅供包内执行层分派，不保留 `run/runSync` 别名。外部调用方应使用 `child_process` 的 `spawn/spawnSync`、`exec/execSync` 或 `execFile/execFileSync` 执行命令；`mgr.command(...)` 同时供包内执行层查询命令；测试通过该句柄配置 `t_inject/t_onRun`。

`lite-cmd-mgr` 的 `f_install()` 仅在本文件内使用，不挂到默认导出对象；命令文件由公共执行入口触发惰性安装，测试不直接调用安装方法。


测试可通过 `liteChildProcess.t_mock({ timers: liteTimer })` 给命令 timeout 注入独立时钟。仅 setTimeout/clearTimeout 控制的超时边界使用该时钟，I/O 与进程引用仍使用原生调度；先卸载旧世界再切换，t_unmock 清理在途超时后恢复原生。用于验证取消超时与卸载时，不需要用真实毫秒数抢先后顺序。

内存服务的公共请求账本补充 `aborted`（弃连已传播）和 `finished`（管线已结算）观测字段。客户端弃连时，服务端闸门放行后仍结算内部 Promise，不补发响应。t_unmock 关停实际 socket 后发出 close，测试可等待真实关闭事件，再独立检查端口拒连。
