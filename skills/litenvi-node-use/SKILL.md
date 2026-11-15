---
name: litenvi-node-use
description: 在业务项目中使用 litenvi-node 编写测试或装配测试环境时使用。涉及 import 'litenvi-node/…' 门面、t_mock/t_unmock/t_inject、内存文件系统、内存命令与内存 Git、内存 ESLint、故障注入、虚拟时钟（lite-timer / lite-browser-timer）、lite-browser Playwright 页面承载时触发。修改 litenvi-node 仓库本身时用 litenvi-node-dev。
---

# litenvi-node 使用指南

litenvi-node 是可切换门面库：业务代码统一 import `litenvi-node/lite-*.mjs`（代替 `node:fs`、`node:child_process`、`node:http`、`process` 等），默认原样透传原生实现，生产行为不变；测试里 `t_mock()` 打开内存世界、`t_unmock()` 关闭。各门面行为规格以仓库 README 与模块头注释为准；带可执行演示的入门教程见仓库 GUIDE.md。

## 自研代码、第三方代理与测试范围

- **能维护的代码主动适配**：自研脚本、插件和业务模块显式使用 lite 组件，测试执行完整业务逻辑，只切换环境门面。不要依赖框架自动把原生 `fs` 调用改写为 `lite-fs`；门面的 `t_mock()` 不代表 Node 原生模块加载器和任意原生 API 都已被替换。
- **不能控制的依赖经项目代理调用**：在消费项目中提供薄代理，生产默认透传第三方公共接口；测试通过代理自己的 `t_mock/t_unmock` 等接口，按场景控制成功响应、失败或等待等公共行为。业务模块应导入该代理，测试结束恢复；不要把业务专用代理或假响应搬进 litenvi-node。
- **第三方只验证引用与集成**：检查真实包能加载、配置正确及接口接线符合预期；业务测试覆盖自研逻辑对代理响应的处理。无需复刻第三方内部实现，也不为测试其内部原生 I/O 而强制转换整条 `import/require` 依赖链。自研插件的内部逻辑则通过显式 lite 组件验证。
- **控制接口只由测试调用**：代理的公共运行接口可供生产使用，`t_` 切换接口只由测试装配调用；Mock 应符合被代理接口的同步／异步及错误契约，不用替换自研业务函数来跳过被测流程。
- **保留已承诺的环境契约**：上述范围不免除 lite 门面、命令执行或配置加载自身的正确性验证。`lite-cmd-node` 的参数、输入输出、退出和信号按命令契约使用；虚拟 Node 不自动包装原生 fs，自研脚本须显式使用 lite-fs，`spawn` 的输入可通过 `liteFs.readFileSync(0)` 同步读取。

## 总装模式

```js
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';

// 总装模式：起手先复位（状态是进程级单例），try/finally 归位。
liteFs.t_unmock();
liteChildProcess.t_unmock();
liteFs.t_mock({ exclude: [sourceDir] }); // exclude 须非空：登记留在真实磁盘的源码目录，其余全部落内存卷
liteChildProcess.t_mock();
try {
  // 业务代码照常 import 门面，这里跑在内存世界
} finally {
  liteChildProcess.t_unmock();  // 必须归位，否则泄漏到后续用例
  liteFs.t_unmock();
}
```

铁律：

- **生产代码不得调用任何 `t_*` 接口**；`t_` 前缀仅测试代码可用。
- 单例经同一 specifier 导入共享（含动态 `import()` 的 specifier 也要一致）。
- 每个用例 `try/finally` 归位所有 mock 过的门面。

## 各门面速查

### lite-fs：内存文件系统

- `t_mock({ exclude: [...] })` 声明保留真实访问的目录（模块源码、静态资源），排除目录外**全部**落内存卷——黑名单制，防越界写穿透真实磁盘；`exclude` 须非空，不传直接报错。
- 内存卷覆盖常用同步操作，含 `readdirSync(..., { withFileTypes: true })`；错误语义与真实 fs 一致（ENOENT/EEXIST/EISDIR…）。
- `t_inject({ op?, path?, code })` 注入 fs 错误（如 EACCES），返回移除函数。
- `markPersistent(dir)` 登记持久根：跨 `t_unmock/t_mock` 复位存活（一般由库内部使用，如命令系统卷）。

### lite-child_process：内存命令执行

- `t_mock()` 后 spawn/spawnSync/exec/execFile 及同步版全部经内存命令分派，调用统一记入 `t_calls()`；`t_reset()` 只清账本。
- `exec(command)` 走内存 `/bin/sh -c`：支持普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1`、局部 `cd`；**不支持**命令替换、通配符、循环。不启动真实 shell。
- 未登记的命令按真实 Node 语义返回 `ENOENT`。
- 异步接口返回子进程，支持超时、AbortSignal、maxBuffer 与 `promisify`；同步接口非零退出时抛携带执行结果的错误。

### lite-cmd-*：命令集

- **node/os 系统命令须显式安装**（同 Git 口径）：`import { t_install } from 'litenvi-node/lite-cmd-node.mjs'; t_install();`（node/npm）与 `import { t_install } from 'litenvi-node/lite-cmd-os.mjs'; t_install();`（open/ls/pwd/cwd/kill、mkdir/rm/cp/mv/cat/touch/test、cd/exit 内建）——仅导入不登记，执行返回 `ENOENT`；幂等。
- **Git 须显式安装**：`import { t_install } from 'litenvi-node/lite-cmd-git.mjs'; t_install();`——仅导入不会登记，执行返回 `ENOENT`。`t_install()` 在内存卷建立前后调用皆可，幂等。
- **ESLint 显式安装与异步加载**：调用 `t_install()` 后经 `spawn`／`execFile` 执行。`eslint.config.mjs` 与规则位于 exclude 真实源码目录，Node 原生 await import；受检文件留在内存卷。配置/自研规则需要内存数据时显式使用 lite-fs，原生 fs 不被自动替换。`spawnSync` 明确失败；真实 ESM 支持顶层 await、多行 import 和再导出，覆盖率直接归属原文件。
- 配置入口 `mgr.command(nameOrPath)`：`t_onRun(handler)` 配置行为钩子（`(call, runBuiltin) => result`，`null` 移除）；`t_inject(fault)` 注入故障 `{ exit?, stderr?, wait?, once?, subcommand? }`，git 可按 `subcommand` 匹配（如 `{ subcommand: 'add', exit: 128, stderr: 'index.lock', once: true }`）。
- 用户级临时命令：`mgr.t_defineUserCommand(name, impl)`（impl 含 `i_run/i_runSync`），落 `/mock/bin` 可遮蔽系统命令，须先 mock lite-fs，卷复位即清。

### lite-process：进程环境

- `t_mock({ cwd, argv?, env?, pid? })` 进入假世界；`t_exitCodes()` 读取 `exit()` 退出意图（`ProcessExitError` 语义：记录在案并上抛，由调用方收场）；`t_unmock()` 恢复原生。捕获退出异常时，从 `litenvi-node/lite-process-exit-error.mjs` 直接导入 `ProcessExitError`。

### lite-http / lite-server：HTTP 客户端与服务端

两个门面共用包内 `i-http-transport.mjs` 处理传输故障与服务路由。使用方不导入或装配 transport，仍通过门面的 `t_mock/t_unmock/t_inject` 操作；两侧复位只清理各自配置。

- `liteHttp.t_mock()` + `liteServer.t_mock()` 后进程内不触网；无监听服务按 `ECONNREFUSED` 拒连。
- 服务端：`liteServer.createServer(handler)` 可创建多个服务；`listen(0)` 绑真实回环端口（供浏览器访问）；模拟外部服务用 `listen({ host: 'api.example.test', port: 443, virtual: true }, cb)` 只注册域名端口不绑 socket，其他域名不会误入。`liteServer.t_port()` 返回第一个仍在监听的回环端口。
- **注入分层**：
  - `liteHttp.t_inject({ url?, method?, path?, query?, status?, wait?, once?, error?/body? })`——传输层，请求未达 handler 即被拦截。
  - `liteServer.t_inject({...同匹配条件})`——响应阶段，handler 已执行；`{ operation: 'close', wait, once: true }` 模拟关闭收尾挂起。
- 匹配口径：`url` 接受字符串或 URL（绝对 URL 比较规范化 origin+pathname+search；`/` 开头只比 pathname+search）；查询串按完整顺序精确比较，要忽略查询用 `path`；`url/method/path/query` 同时给出须全部满足；不指定 method 适用于所有方法；`once` 完整命中才消耗。
- 回调式 `request/get` 与真实 ClientRequest 消费面兼容（statusCode/data/end/error 事件）。

### lite-timer：Node 侧虚拟时钟

- 面向「按模块遮蔽注入」：测试装配（`node:module` register hook）向被测模块源码头部注入 `import { setTimeout, clearTimeout, setInterval, clearInterval, Date } from 'litenvi-node/lite-timer.mjs'`，仅被注入模块走虚拟时钟，宿主不受影响。
- `timer.t_mock({ now? })` 冻结世界：定时器只在 `await timer.t_advanceMs(ms)` 推进时到期派发；`Date.now()/new Date()` 返回虚拟时刻。重复 `t_mock` 幂等；`t_unmock()` 丢弃在途定时器恢复原生。
- 未覆盖面（勿依赖）：`process.hrtime`、`performance`、`queueMicrotask`、真实 I/O 到达时刻。

### lite-browser：Playwright 页面承载

- `await browser.open()` 启动/复用共享单例（默认无头；`{ headless: false }` 显式有头，异模式请求会关停重建）；`browser.page().goto(url)` 导航；`await browser.close()` 关停。
- 每例断言前先导航回首页，DOM 从已知起点出发。直接用 playwright 浏览器 API，不加载 `@playwright/test` 框架——调用方仍可用自己的 `@playwright/test` 断言。

### lite-browser-timer：页面信号与周期 gate

- 页面通过正常 ESM URL / import map 加载同一模块；**测试控制也必须在页面内导入同一 URL**，Node 端状态不跨进程传入页面。
- `timer.t_mock()` 同时启用信号与周期 Mock；挂起后 `t_fireSingalTimeout()` 以原生 `TimeoutError` 触发当前批次超时信号；`await t_tickIntervals()` 手动推进周期定时一轮；`t_unmock()` 以 `AbortError` 清理挂起信号并恢复原生。
- 页面导航会得到新模块实例，测试须在新页面重新启用 gate。

## 典型片段

内存世界 + Git 故障注入：

```js
import { t_install } from 'litenvi-node/lite-cmd-git.mjs';
import mgr from 'litenvi-node/lite-cmd-mgr.mjs';
import liteFs from 'litenvi-node/lite-fs.mjs';
import liteChildProcess from 'litenvi-node/lite-child_process.mjs';

liteFs.t_mock({ exclude: [sourceDir] }); // exclude 须非空：登记真实源码目录，其余全落内存卷
liteChildProcess.t_mock();
t_install(); // 幂等；卷建立前后皆可
const removeFault = mgr.command('git').t_inject({ subcommand: 'commit', exit: 128, stderr: 'index.lock', once: true });
try {
  // 业务代码执行 git commit → status 128, stderr 'index.lock'
} finally {
  removeFault();
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
}
```

虚拟服务 + URL 注入：

```js
import liteHttp from 'litenvi-node/lite-http.mjs';
import liteServer from 'litenvi-node/lite-server.mjs';

liteHttp.t_mock();
liteServer.t_mock();
try {
  await new Promise(resolve => liteServer.createServer((req, res) => res.end('ok'))
    .listen({ host: 'api.example.test', port: 443, virtual: true }, resolve));
  liteHttp.t_inject({ url: 'https://api.example.test/api/health?full=1', status: 503, once: true });
  // 业务请求该 URL → 503；其他 URL 走真实 handler，且绝不外联
} finally { liteServer.t_unmock(); liteHttp.t_unmock(); }
```

## 常见坑

- 忘了 `t_install()` → Git / ESLint 返回 ENOENT；忘 `try/finally` 归位 → 泄漏到后续用例。
- `lite-fs` 黑名单制：想读真实磁盘上的 fixtures，必须放进 `t_mock({ exclude })`；exclude 目录外的写永远落内存卷。
- 故障 `exit` 不允许为 0（不允许成功回包替换）；要"命中后放行再失败"用 `wait` Promise 闸门。
- URL 注入查询串是精确序匹配：参数顺序不同、多一个参数都不命中——要宽松匹配改用 `path` 或 `query`。
- `exec` 不支持通配符/命令替换，脚本迁入内存世界前先核 shell 语法支持面。
- 浏览器侧 gate 的测试控制代码必须运行在页面内（同一 URL 的模块实例），写在 Node 端控制不到页面。
- `lite-timer` 只遮蔽被注入模块：宿主与未被注入模块的真实定时器不受 `t_advanceMs` 影响。
