# litenvi-node

在独立 VM 中加载完整生产源码，以内存文件系统、时钟、Git 沙盒和 HTTP 流隔离外部环境。业务逻辑、路由和成功回包来自生产源码，HTTP 请求本身始终经内存 mock。成功、失败、重试和超时均不会发出真实网络请求。

## 服务器模式

`buildMockEnvironment({ srcRoot, projectRoot, initialData, sideEntries })` 的主入口必须调用 `http.createServer(...).listen(...)`。没有监听服务时装配失败；不提供无服务器模式或成功回包脚本。此处 listen 只建立内存服务器状态，不绑定任何 TCP 端口。

- `initialData(fs)`：装配期播种项目文件；业务运行后的文件观测面只读。
- `sideEntries`：在服务器的同一依赖图中加载完整客户端/action 模块，通过 `environment.exports` 调用。
- `initialStorage: { local, session }`：播种浏览器存储；传 `local: null` 可模拟本地存储不可用。
- `environment.expose(values)`：装配组件/界面输入；禁止覆盖 fetch、process、时钟、存储等环境通道。
- `environment.clock`、`until(predicate)`：推进虚拟时钟、等待微任务和异步结果收敛。
- `environment.git.run(argv)`：准备内存 Git 世界；`git.log()` 返回实际沙盒提交。
- Node 子进程在独立 VM 执行真实 `.mjs` 入口，独立 argv/输出，共享隔离文件系统与 Git。源码加载仍限制在主入口所在目录内，不拉起真实子进程。

## HTTP 故障

```js
const remove = environment.http.injectFault({
  method: 'GET',
  path: '/api/items',
  query: { page: '2' },
  phase: 'response',
  delayMs: 30,
  once: true,
});
// 正常调用真实客户端；推进时钟后交付真实服务器响应。
await environment.clock.tickAsync(30);
remove();
```

匹配字段是可选的 `method`、`path`（字符串或正则）和 `query`。`phase` 为 `request` 或 `response`：请求阶段故障可阻止路由执行；响应阶段先执行真实路由，再延迟/破坏响应。

故障能力包括 `delayMs`、`wait`（手动控制的 Promise）、`disconnect`、`error`（传输异常），以及 `status: 400..599` 搭配 `body`/`error`（HTTP 错误）。禁止 2xx 成功替换和无错误状态的固定正文。调用返回移除函数，`once` 可限定一次请求。

`http.requests` 保留 method/path/query/body、客户端来源、是否已派发，以及 `serverResponse` 和实际交付的 `response`；响应后故障不会抹去真实服务器的执行证据。fetch 支持标准响应头读取/迭代及 AbortSignal；释放环境会取消悬挂请求、关闭服务并清理计时器。

世界内的回调式 `http.request`/`http.get`（如 CLI 对守护进程的探活）只放行 loopback 同端口：经内存传输路由真实路由、故障注入同口径生效（可注入 500 等错误状态模拟心跳接口不可达）、流水账记 `source: client`；端口不符或未监听按 `ECONNREFUSED` 拒连（探活冷启动语义），非 loopback 地址仍按未声明调用记账。

文件写入故障通过 `failWrite(path)` 或 `setFileWriteError()` 注入，不修改业务方法。

## lite-http 门面

`litenvi-node/lite-http.mjs` 是 node:http 客户端的可切换门面，供业务代码统一 import：默认（未设置内存实现）原样转发真实 `node:http`，生产行为不变。`mock()` 设置内存 http 实现（幂等，复用当前实例）、`unmock()` 移除并回到真实实现（规则随实例丢弃）。错误注入是内存实现上的能力：`inject({ url?, method?, path?, query?, status?: 400..599, wait?, once?, error?/body? })` 增加规则并返回移除函数；至少指定错误状态或 Promise 闸门。命中传输层错误时不执行 handler；未命中则经 `lite-server` 执行真实 handler，无监听服务时按 `ECONNREFUSED` 拒连。`liteServer.inject()` 使用相同匹配条件，作用于 handler 执行后的响应阶段。回调式 `request/get` 与真实 ClientRequest 消费面兼容（statusCode / data / end / error 事件）；状态为模块级单例，同进程内经同一 specifier 导入（含动态 `import()`）共享同一实例。


两个入口均支持按 URL 注入，例如 `liteHttp.inject({ url: 'http://localhost:8080/api/health?full=1', method: 'GET', status: 503, once: true })`，或 `liteServer.inject({ url: '/api/health?full=1', status: 503 })`。`url` 接受字符串或 `URL` 对象：绝对 HTTP/HTTPS URL 精确比较规范化后的 origin、pathname 和 search（主机名大小写、默认端口按 URL 标准规范化），以 `/` 开头的路径 URL 只比较 pathname 和 search；两者均忽略 fragment。查询串按完整顺序精确比较，额外参数、重复参数的顺序变化也不会命中；需要忽略查询串时继续使用 `path`，需要部分查询匹配时使用 `query`。`url/method/path/query` 同时提供时全部满足才命中；不指定 `method` 时适用于所有 HTTP 方法，不指定任何匹配条件时保持全局规则。请求 origin 优先采用请求的 `Host` 头，缺省使用请求配置的 hostname/host 和端口；真实 socket 回灌保留原始 Host，不会因为内部连接回环地址而改变匹配来源。`once` 仅在完整匹配时消耗，`wait` 也只挂起匹配的 URL。

## lite-process 门面

`litenvi-node/lite-process.mjs` 与 lite-http 同机制，面向 `node:child_process` 的 `spawn`：默认原样转发真实 spawn；`mock()` 设置内存实现（不真实起进程）、`unmock()` 移除。内存实现把调用入账（`spawns()` 断言 command/args/options），返回替身子进程（pid/stdout/stderr/unref/kill，事件消费面对齐真实 ChildProcess，kill 触发 exit/close）；`onSpawn(handler)` 脚本化每次返回的子进程事件（延迟到微任务触发，与真实事件异步到达一致）。

## lite-fs 门面

`litenvi-node/lite-fs.mjs` 与 lite-http/lite-process 同机制，面向 `node:fs`，但**按作用域收窄——只接管系统运行数据**：`mock({ roots })` 声明运行数据根（看板数据目录/注册表/日志，文件或目录均可，必填）；根内操作走内存卷（同步面 existsSync/readFileSync/writeFileSync/mkdirSync/readdirSync/statSync/lstatSync/realpathSync/rmSync/unlinkSync/rmdirSync/renameSync/copyFileSync/cpSync/appendFileSync/accessSync/openSync/closeSync/createReadStream/chmodSync/symlinkSync，按真实 fs 错误语义抛 ENOENT/EEXIST/EISDIR/ENOTDIR/ENOTEMPTY/EBADF）；**根外一律原样走真实 fs**——模块源码、静态资源、代码 mtime 等系统本体文件不依赖 lite-fs（Node 模块加载器本身也不经门面）。默认（未 mock）全量转发真实 fs。`inject({ op?, path?, code })` 对根内命中操作抛指定 code 的 fs 错误（如 EACCES 模拟写入失败），返回移除函数；根内触到未实现面明确报错，不静默落真实磁盘；无路径参数的操作（fd 类）落在内存卷；多路径操作任一端在根内即按内存卷处理。

## lite-child_process 执行接口

`lite-child_process` 提供 `spawn/spawnSync`、`exec/execSync`、`execFile/execFileSync`。默认转发原生 Node；`mock()` 后全部经内存命令分派并统一记入 `calls()`，`reset()` 仅清账本。

`execFile(file, args?, options?, callback?)` 按字面 argv 执行，默认以 UTF-8 字符串回调 `(error, stdout, stderr)`；异步接口返回子进程，支持超时、AbortSignal、maxBuffer 和 `promisify`（Promise 上有 `child`，成功值为 `{ stdout, stderr }`）。同步接口默认返回 Buffer，非零退出或启动失败时抛出携带执行结果的错误。

`exec(command, ...)` 使用内存 `/bin/sh -c`；exec 适配和 shell 实现均为 `lite-child_process.mjs` 的私有方法，解析复用 `shell-quote@1.12.0`（MIT）。当前支持普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1` 和局部 `cd`。命令替换、通配符、循环等完整 shell 语法尚未实现；mock 不启动真实 shell。Node 脚本的同步执行限制保持现状；`fork/IPC` 尚未提供。

`mgr.command(nameOrPath)` 查询已登记的配置句柄，可在安装前配置 `onRun/inject`；`mgr.pkg_resolve(nameOrPath)` 是产品内部执行寻址接口，要求命令文件存在，首次可惰性安装系统命令。命令对象的 `inject/onRun` 为公开配置接口，不再提供 `mgr.inject`；`pkg_takeFault/pkg_runSync` 供内部执行层协作，pkg_ 前缀表示仅限同一 package 内的模块调用；测试通过上述 child_process 公共接口触发执行。

## 验证

运行 `npm test`。通用环境测试与项目的业务测试互补；内存 Git、工具链和浏览器组件模拟不代表真实网络、真实浏览器或平台验收。


## 测试进程禁止原生网络

隔离的 action 测试进程可用 `node --require litenvi-node/network-guard.cjs ...` 预加载网络 mock；单独运行 action 用例时，测试装配助手也须导入该模块。它封锁宿主原生 fetch、HTTP/HTTPS request/get、TCP connect 与 listen，ESM 具名导出同步到同一 mock。默认 `buildMockEnvironment` 的 VM 装配本身不修改宿主函数。

封锁发生在任何连接/监听之前。即使业务捕获了错误，退出审计仍以非零状态报告原生入口尝试，防止失败回退绕开 mock。`NETWORK_MOCK_SUMMARY` 记录尝试数和通道名称，聚合器须检查每个文件的审计结果为零。该模块只在专用测试进程使用；HTTP 场景和故障仍通过内存传输与 `injectFault` 声明，不通过原生请求制造失败。

## 可选 Playwright 适配层

浏览器装配与内存环境统一从 `environment.mjs` 导入。`playwright.mjs` 承载浏览器实现，资源复制和路由安装均由装配入口内部完成；独立 `files.mjs` 已移除。库不导入或强制安装 Playwright，由调用方注入自己的 `browserType`。

```js
import { chromium } from '@playwright/test';
import { buildMockEnvironment, openBrowserEnvironment } from 'litenvi-node/environment.mjs';

const fixture = await openBrowserEnvironment({
  browserType: chromium,
  origin: 'http://example.test',
  url: 'http://example.test/',
  resources: [{ source: new URL('./web/', import.meta.url), target: '/site' }],
  initialData(fs) {
    fs.mkdirSync('/app/data', { recursive: true });
  },
  createEnvironment: initialData => buildMockEnvironment({
    srcRoot, projectRoot, initialData,
  }),
});
try {
  await fixture.page.getByRole('button', { name: 'Save' }).click();
  console.log(fixture.requests('POST', '/save'));
} finally {
  await fixture.dispose();
}
```

`resources` 为可选的 `{source, target}` 数组。源支持路径或 file URL，目标为内存中的 POSIX 绝对路径。全部目录原样复制（保留二进制）后，执行调用方可选的同步 `initialData(fs)`；用例数据可覆盖已复制的资源。目录中的符号链接等非普通条目会被拒绝，没有运行期宿主文件回退。

`createEnvironment` 接收库组合好的初始化回调，需交给环境装配期的 `initialData`（项目包装环境可传给自己的 seed）。有资源或用例数据配置时，工厂若没有执行该回调会报错并清理已返回的环境，避免静默缺资源。没有这两项配置时，仍兼容原来的零参数环境工厂。

返回 `environment/browser/context/page/dispose/requests`。`setup(environment)` 在环境创建后、浏览器启动前执行，可准备 Git 或注入故障；`launchOptions` 与 `contextOptions` 传给浏览器，默认无头，Service Worker 始终禁用。项目 URL、初始数据、选择器和业务断言仍由调用方提供。

路由只接受声明的源，通过内存 HTTP 执行真实服务端，保留方法、路径、查询、正文、状态和响应头；失败记录原始异常并中止，绝不放行到宿主网络。

适配器接管自己创建的环境和浏览器，装配失败自动清理；释放按上下文、浏览器、内存环境的逆序执行，一个关闭失败也继续尝试其余资源。释放幂等，页面、弹窗、路由和清理错误通过 AggregateError 留痕，原始启动错误保留。环境自身检查未声明调用与监听状态，适配器额外检查残留内存请求。

## 原生模块 Mock 进程试点

Node.js 22.12.0 起可通过统一入口选择独立进程后端；默认的 `buildMockEnvironment` 仍使用 VM。

```js
import { buildProcessEnvironment, openBrowserEnvironment } from 'litenvi-node/environment.mjs';

const fixture = await openBrowserEnvironment({
  browserType: chromium, origin: 'http://example.test', url: 'http://example.test/',
  resources: [{ source: new URL('./web/', import.meta.url), target: '/site' }],
  createEnvironment: initialData => buildProcessEnvironment({ srcRoot, projectRoot, initialData }),
});
try {
  await fixture.page.getByRole('button', { name: 'Save' }).click();
  console.log(fixture.environment.fs.readTextFile('/app/config.json'));
} finally { await fixture.dispose(); }
```

每个环境启动一个业务子进程，由库内部添加 `--experimental-test-module-mocks`。整个业务依赖图使用普通 ESM 加载；`mock.module()` 替换 fs（包括 fs/promises）、process、child_process、HTTP 等边界，复用现有 memfs、Git 和 FakeTimers。业务进程的全局 Date、timer、process 和 fetch 指向隔离环境；`import ... from 'node:process'` 与全局 process 拿到同一替身（cwd 返回 projectRoot，VM 后端同口径）；Playwright 与测试父进程保留真实时间。父进程不需要 `--experimental-vm-modules`，也不依赖 `registerHooks`。

输入支持 `srcRoot/projectRoot/env/now/initialStorage/initialData`，`timeoutMs` 是真实时间下的 IPC 预算（默认 10 秒）。返回 `runtime: 'process'`、真实子进程 `pid`、`http.request/requests/pendingCount/injectFault`、只读 `fs`、`git.log()`、`logs/unexpected`、`clock.now/countTimers/tickAsync()`、`refresh()` 和 `dispose()`。请求、推进、刷新和故障注入均需 await。

父进程的文件、Git 和请求观测来自 IPC 快照，在操作完成后更新；要观测尚未完成的业务动作，先 `await environment.refresh()`。文件快照只传变化内容，保留 Buffer；试点不传递权限、符号链接或时间戳语义。父进程没有写文件、调用业务导出、VM evaluate 或 Git 装配的运行期接口。

跨进程不能发送函数、Promise 或 AbortSignal。HTTP 故障只支持可序列化参数；`injectFault()` 返回 `Promise<移除函数>`（撤销经 removeFault 消息调子进程侧句柄，幂等），`wait` 为真 Promise 时注册为 gateId 闸门、落定后自动放行——60 秒级长挂起用例需抬高 `timeoutMs`（IPC 预算默认 10 秒）。`failWrite`、`sideEntries` 尚未接入原生后端。Git 观测含 `log()` / `isCommitted(pathspec)`（committed 清单随快照回传）。

### 原生虚拟 Node 子进程

业务代码 `spawn('/mock/node', [entry, ...args])` 在原生后端同样可用：fork 出独立进程以同一套世界装配（`runChildWorld`）执行真实入口源码——进程边界即模块缓存边界，每次 spawn 都重新加载依赖图；子进程拥有独立 argv / stdout / stderr / exit 语义（`process.exit` 与 `process.exitCode` 都折算为退出码）。世界共享按「fork 时快照进入、退出快照回流」实现：入口可见父世界 fs / Git / 时钟现值，结束后写入、删除（含按 fork 快照判定的删除）与 Git 状态整体回流父世界；子世界内的未声明调用逐条并入父世界记账，收口不放过。失败路径同样回流部分写入的世界事实。`stdin` 选项沿用 VM 口径（子世界以 fd 0 `readFileSync` 读到预置载荷）。子世界独立 FakeTimers 无人推进：入口若等待自身定时器会挂起，适用于 CLI 型同步入口。

清理会取消在途内存请求、恢复业务全局、清空快照并等待子进程退出；重复清理复用同一结果。未声明调用、异常退出、通信超时或需要强制终止的进程都不能误报通过。模块白名单用于测试边界检查；普通 Node 子进程与 module Mock 不提供运行不可信代码的安全沙箱。

## 方法隔离

模块级私有变量、常量与文件内辅助方法统一使用 `f_` 前缀，不导出。包内共享的变量与方法使用 `pkg_` 前缀，其余公共接口不加前缀。函数参数与临时局部数据变量保留语义名称；原生 API、命令实现协议和请求/响应数据字段保留原名。导出方法以 `pkg_` 开头时属于包内协作接口，测试应通过公共入口验证；其余导出方法允许所有调用方使用。此约定通过名称和方法注释表达。

`mgr.pkg_defineCommand/pkg_resolve`、命令条目的 `pkg_takeFault/pkg_runSync`、`liteProcess` 模块的 `pkg_commandContext`、`liteChildProcess.pkg_signal`、`liteServer.pkg_handle` 为内部接口。`lite-cmd-node/-os` 的命令表和 Node 路径常量以 `pkg_` 导出；`lite-cmd-git` 仅通过导入完成登记，不再导出原始命令条目。`f_installArgv`、`f_liveRequests` 与 exec/shell 辅助方法保持文件内私有。

`mock()` 返回公共门面，私有运行态不作为返回值暴露。`isMocked()` 是公开的状态查询；`liteFs.markPersistent()` 是公开的持久目录配置，均允许测试使用。命令实现的 `run/runSync` 是登记实现时的协议名，保持原名。

`lite-cmd-mgr` 的 `f_install()` 仅在本文件内使用，不挂到默认导出对象；命令文件由公共执行入口触发惰性安装，测试不直接调用安装方法。
