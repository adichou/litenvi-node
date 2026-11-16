---
name: litenvi-node-dev
description: 开发 litenvi-node 仓库本身时使用。修改 lite-* 门面源码、新增内存命令或故障注入能力、编写或调整 scripts/tests/ 黑盒用例、演进模块头注释与 README 规格、排查本仓库测试失败时触发。仅在业务项目里 import 'litenvi-node/…' 写测试时用 litenvi-node-use，不用本 skill。
---

# litenvi-node 开发指南

本仓库是可切换的 Node 与浏览器测试环境门面库。开发前先读目标模块的**头注释**（它就是该模块的行为规格，含未覆盖面声明）和 README 对应章节，再动代码；不要凭直觉猜 API。仓库根 `AGENTS.md` 有模块地图与契约摘要，本 skill 是开发侧的完整操作指南。

## 测试所有权与显式边界

先确定代码是否由当前项目维护、是否允许修改，再决定测试范围；仅能查看第三方源码不代表要承担其内部实现测试。

- **自研代码执行完整逻辑**：业务脚本、自研插件及其辅助模块应显式导入对应 lite 组件。生产默认透传，测试仅通过 `t_mock/t_unmock/t_inject` 等公开测试接口控制环境；不替换自研业务函数、不截断源码，也不预置业务流程的最终结果。
- **第三方依赖由消费项目提供薄代理**：代理默认调用真实依赖，暴露与业务需要相符的公共接口，以及测试专用的 `t_mock/t_unmock` 等切换接口。测试按依赖的实际公共契约设置返回值、错误或异步等待等场景，验证自研代码如何消费这些响应；不在代理中复制第三方算法或实现完整第三方环境。
- **第三方本体只做消费侧集成验证**：核对依赖加载、配置、接口调用和必要的真实接线。无需为其内部逻辑建立自研插件式黑盒套件，也不要求把其内部 `import/require`、`node:fs` 或依赖链全部接管到内存。自研插件需要测试内部 I/O 时，修改插件显式使用 `lite-fs` 等组件。
- **不通过原生 API 自动接管替代适配**：不为让未适配的自研代码或第三方包自动进入假世界，替换共享 `node:fs` 方法、同步改写 ESM 导出、重写第三方加载链或扩展通用沙箱。`liteFs.t_mock()` 的契约是切换显式门面，不是自动接管任意原生调用。
- **命令模拟与业务依赖分别定界**：`lite-cmd-node` 的启动、参数、输入输出、退出、信号和资源生命周期按命令契约验证；它不承担自动改造脚本内部文件访问的职责。业务代码的第三方代理留在消费项目，litenvi-node 仅提供通用环境门面。
- **评审与迁移如实区分**：存量自动转发机制属于现状，不是上述边界的豁免。迁移时先让自研调用方显式使用 lite，保留命令自身必要的行为测试；不能整块删除命令运行时或仅改文档就宣称迁移完成。第三方内部原生 I/O 未被接管，不单独构成本项目缺陷；门面已声明的行为、配置匹配和命令结果仍须正常验收。

## 架构分层与依赖方向

- **叶子模块**（不依赖其他 lite-*）：`lite-fs`（仅 node:fs/path）、`lite-timer`（仅 @sinonjs/fake-timers，不 install、不触碰宿主全局）、`lite-browser`（仅 playwright）、`lite-browser-timer`（零依赖）。
- **HTTP 管线**：`lite-http` 与 `lite-server` 均依赖包内 `i-http-transport.mjs`，不互相导入。transport 只提供 `i_` 接口，处理请求上下文、传输层故障与服务路由分派，不依赖两个门面。客户端事件与流归 `lite-http`，监听、handler、响应阶段故障和 socket 回写归 `lite-server`。客户端配置与服务路由各自随所属门面开闭，不能互相清除；测试经门面验证，不直接调用 transport。
- **命令体系**：`lite-cmd-mgr` 维护「完整路径 → impl」注册表，在 lite-fs 内存卷内维护 `/mock-cmd` 系统卷（导入即 `markPersistent`，跨卷复位存活）；mgr 不自动加载命令集——`lite-cmd-node` / `lite-cmd-os` / `lite-cmd-git` 一律须测试显式 `t_install()`（导入不登记）。ESLint 规则与配置通过官方 API 测试，真实 ESLint 仅作为开发依赖用于仓库静态扫描与集成验证。
- **执行面**：`lite-child_process` 是 spawn/exec/execFile 门面，mock 后经 mgr 解析分派内存命令；分派前经 `mgr.i_runAsCurrent` 进入当前执行环境（`i_currentArgv` 供 `lite-process.argv` 读取，带参数文法的命令如 node 解析后经 `i_setCurrentArgv` 细化视图）；进程能力（cwd/env/argv/recordExit/setCwd）由 `lite-process.i_commandContext` 构建并经 ctx 传入（假世界 execPath 经 mgr 寻址 node 命令条目的通用 `execPath` 接口），命令集不依赖 lite-process。
- **虚拟 Node 脚本**（lite-cmd-node）：脚本普通 import 在宿主内执行，AsyncLocalStorage 提供虚拟命令上下文；spawn 输入经 lite-fs `i_stageStdin` 暂存为 fd 0，脚本显式用 `liteFs.readFileSync(0)` 读取。不再包装原生 fs 方法或同步改写其 ESM 具名导出；入口的业务文件访问须显式使用 lite-fs，命令参数、输入输出、退出和信号等契约继续保留。

新增依赖前先确认：不破坏上述分层、不引入环、叶子模块保持叶子。

## 不可破坏的契约

1. 未 mock 时原样透传原生实现，生产行为不变；透传路径保持原生参数与返回形态（含额外实参透传）。
2. 方法隔离：`f_` 文件私有；`i_` 仅同包协作；`t_` 仅测试代码可引用或调用，生产代码不得导入、读取、转存或调用。无 ESLint / 运行时强制，命名与头注释即约定，必须自觉遵守。
3. 每个源文件第一行固定方法隔离横幅：`// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。`
4. 不保留旧别名：`t_` 接口不配无前缀别名；命令实现统一 `i_run` / `i_runSync`。
5. 状态为模块级单例：同进程内经同一 specifier 导入共享同一实例。
6. 内存实现触到未实现的操作面明确报错，不静默落真实磁盘、不静默触网。
7. 故障注入：`exit` 须为 ≥1 整数（不允许成功回包替换）或 `wait` Promise 闸门；`checkpoint` 与故障配置互斥；`subcommand` 匹配仅支持 git。
8. 头注释即规格：行为变更必须同步头注释与 README，未覆盖面如实声明，不夸大。

## 常见任务

### 改动流程

1. 读目标模块头注释 + README 章节 + 对应 `scripts/tests/<模块>.test.mjs`。
2. 先补黑盒用例（或与实现同步），不写白盒（不 import 私有实现）。
3. 实现，保持透传与 mock 两侧行为。
4. `npm test` 全绿；关注覆盖时 `npm run test:coverage`。
5. 同步头注释与 README。

### 新增门面 checklist

- 源文件：第一行方法隔离横幅 + 头部规格注释（世界开闭方式、注入面、单例语义、未覆盖面）。
- 接口命名：公共无前缀；测试专用 `t_`；同包协作 `i_`；文件私有 `f_`。
- `scripts/tests/<模块>.test.mjs` 黑盒用例；README 按既有章节体例补一节。
- 与既有门面的分工要在头注释里写明（如 lite-timer 与 lite-browser-timer 的 Node/页面分工）。

### 新增 / 修改内存命令

- 命令实现协议：`impl = { i_run(argv, ctx, child)?, i_runSync(argv, ctx)? }`——`i_run` 服务异步 spawn（驱动子进程事件面），`i_runSync` 服务 spawnSync（返回同步结果对象面）。
- 登记：系统级经 `mgr.i_defineCommand(path, impl)`（node / os / git 命令集一律由各自模块的 `t_install()` 显式安装，mgr 不自动加载）；用户级临时命令走 `t_defineUserCommand(name, impl)` 落 `/mock/bin`（PATH 序在系统命令之前，可遮蔽；须先 mock lite-fs，卷复位即清）。
- `ctx` 由 lite-child_process 派遣时传入；不要在命令模块内维护子进程账本。
- 寻址：裸名按 PATH 序搜 `/mock-cmd/usr/local/bin` → `/mock-cmd/usr/bin` → `/mock-cmd/bin`（`/mock/bin` 用户级在前）；绝对路径按前缀映射到 `/mock-cmd` 命名空间。

### 故障注入与钩子

- `fault = { exit?, stderr?, wait?, once?, subcommand? }`；规则按注入顺序取首个命中，`once` 命中即毁。
- git 子命令匹配支持跳过 `-c` / `-C` / `--no-optional-locks` / `--no-pager` / `--literal-pathspecs` 全局选项。
- checkpoint 注入：`{ checkpoint, onHit }`，同步回调，在扫描未完成时重入内存命令；与故障互斥；用完必须调用返回的移除函数。
- 命令句柄 `t_onRun(handler)`：handler 为 `(call, runBuiltin) => result`，可包一层改写内置实现的结果；`t_onRun(null)` 移除。故障优先于钩子和内置执行。
- 校验逻辑集中在 `lite-cmd-mgr` 的 `f_validateFault`，新增字段先过校验并同步错误消息。

### 文档即代码

- 文档（AGENTS.md / README / skills）与实现的对齐由 AI 按语义校验，不由测试守护：行为变更必须同步头注释与 README，模块地图遗漏、接口面不符、示例失效都在校验环节暴露。
- 文档 js 示例块约定为可真实执行的完整示例：块内只用包自引用 specifier（`'litenvi-node/…'`）、自带归位（try/finally + t_unmock）；需真实浏览器/外部服务的示例（lite-browser/playwright）除外。
- AGENTS.md 模块地图是唯一真源：新增模块先补表格行；公开门面补 `scripts/tests/<门面名>.test.mjs`（含包自引用单例检查体例），包内实现模块通过所属门面的公开入口验证，用例归入门面测试文件，不单设同名测试文件。

### 测试写法

- `node:test` + `node:assert/strict`；每个 `test` 前置 `/** 场景：… */` 中文说明；断言带中文消息。
- 用例起手 `liteXxx.t_unmock()` 复位，`try/finally` 收尾（或利用 node:test 的返回清理函数）——状态是进程级单例，漏清理会泄漏到后续用例。
- 遮蔽注入类用例中真实时间等待用 `globalThis.setTimeout`；需要固定 Date 对照时先存 `NativeDate = globalThis.Date`。
- 原生对照子进程使用 `scripts/tests/native-reference-env.mjs` 固定环境（LC_ALL=C、去 NODE_OPTIONS/FORCE_COLOR 等）。
- 测试文件与公开门面一一对应，包内实现模块的用例按公开行为归入所属门面；共用夹具放在不注册用例的普通辅助模块中，不通过导入测试文件复用夹具。「真实 vs 内存」对照用例与真实透传锚定用例统一收口在 `scripts/tests/native-reference.test.mjs`（隔离真实子进程/fs/网络对业务用例进程的影响），主文件保持 mock 世界语义；双口径对照时先 `t_mock` 建卷再 `t_install`（持久卷已存在时不能依赖惰性安装时序）。
- 每个模块主测试文件含一条包自引用单例检查：动态 `import('litenvi-node/<模块>.mjs')` 与相对导入断言同一实例（exports 变动先红）；新增门面照抄体例。

## 陷阱清单

- **单例泄漏**：整库测试顺序敏感，任何 mock 都要确保 finally 归位；`t_reset` / `t_resetRequests` 只清账本，不移除世界。
- **lite-fs 是黑名单制**：exclude 外全部落内存卷。新增"真实文件访问"需求时在调用方声明 exclude，不要回退白名单思路（曾因此让未声明路径静默走真实 fs，已废弃）。
- **注入分层**：传输层故障（请求未达 handler）归 `lite-http.t_inject`；响应阶段（handler 已执行）归 `liteServer.t_inject`；close 收尾挂起也是 lite-server 的规则。改匹配条件（url/method/path/query 规范化）时两侧同步。
- **URL 规则匹配是精确序**：查询串按完整顺序精确比较；`url` 与 `path` 的取舍、fragment 忽略等口径见 README，勿自行放宽。
- **exec shell 支持面有限**：普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1`、局部 `cd`。命令替换、通配符、循环未实现——补语法须同步 README 能力清单与用例。
- **fd 0 暂存**：命令输入经 `i_stageStdin` 暂存，虚拟命令显式用 `liteFs.readFileSync(0)` 同步读取，写侧 EBADF；释放时机与 `i_releaseStdin` 配对。
- **Git 锁语义**：add/rm/commit 独占索引锁；status 简化可选锁模型（默认尝试持锁、被占继续读）。扩展其他写命令的锁语义时在头注释声明口径。
- **ESLint 测试边界**：自研规则使用官方 RuleTester，完整配置使用真实工厂与 Linter.verify / ESLint.lintText，真实配置加载及 CLI 行为使用集成测试。规则的项目数据通过 lite-fs 显式装配，不复刻 ESLint CLI 或为其接管原生模块加载。
- **缩进不统一**（2/4 空格混存）：跟随所在文件，不顺手全局统一。
- **文档先于记忆**：README 与头注释与实现三处一致才算完成；"先改代码后补文档"在本仓库算未完成。

## 提交

历史风格：`feat:` / `refactor:` / `chore:` 前缀 + 中文一句话描述（可含要点罗列）。提交操作必须由用户显式指示后执行。
