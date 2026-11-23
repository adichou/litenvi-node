# litenvi-node — AI 开发与使用须知

可切换的 Node 与浏览器测试环境门面库：每个 `lite-*` 模块默认透传原生实现，测试显式 `t_mock()` 后切换到内存世界（文件系统、命令执行、Git、HTTP、时钟）。业务逻辑与路由仍运行完整生产源码。npm 公共包，纯 ESM（`"type": "module"`，经 `litenvi-node/lite-xxx.mjs` 子路径导入）。

## 模块地图

| 模块 | 门面边界 | 世界开闭 | 测试专用接口 |
|---|---|---|---|
| `lite-fs.mjs` | `node:fs` | `t_mock({ exclude })` 黑名单制内存卷 | `t_inject`、`markPersistent`、`t_stageStdin` / `t_releaseStdin`（fd 0 装配/复位）、`t_isPassthrough`（透传域查询） |
| `lite-child_process.mjs` | `node:child_process` | `t_mock()` 后经内存命令分派 | `t_calls` / `t_reset` |
| `lite-process.mjs` | `process` | `t_mock({ cwd, argv?, env?, pid? })` | `t_exitCodes` |
| `lite-process-exit-error.mjs` | 公开的退出异常类型 `ProcessExitError`，无依赖，使用方直接导入 | 无开关 | 经 `lite-process` 与命令执行用例验证 |
| `lite-http.mjs` | `node:http` / `node:https` 客户端 | `t_mock()` | `t_inject`（传输层，请求未达 handler） |
| `i-http-transport.mjs` | 包内 HTTP 请求管线：传输层故障与服务路由，两个门面共同依赖 | 由 `lite-http` / `lite-server` 各自管理客户端配置与路由登记 | 无；用例归属 `lite-http.test.mjs` 与 `lite-server.test.mjs`，不单设内部模块测试文件 |
| `lite-os.mjs` | `node:os` 路径锚点与只读标识 | `t_mock({ homedir?, tmpdir?, platform?, arch?, hostname? })` 按键覆盖 | — |
| `lite-server.mjs` | `http.createServer` 服务端 | `t_mock()`；可多服务、virtual listen | `t_inject`（响应阶段）、`t_port` / `t_requests` / `t_resetRequests` |
| `lite-cmd-mgr.mjs` | 命令内核（登记表，无开关；不自动加载命令集；条目通用接口 `execPath`，当前执行 argv 环境 `i_currentArgv`） | — | `mgr.command(...).t_inject / t_onRun / t_impl`、`t_defineUserCommand / t_defined` |
| `lite-cmd-node.mjs` / `lite-cmd-os.mjs` | 系统命令集 | 测试显式 `t_install()`（导入不登记） | `t_install`、`t_commands` |
| `lite-cmd-git.mjs` | Git 命令集 | 测试显式 `t_install()` | `t_install` |
| `lite-timer.mjs` | Node 定时器与 `Date`（遮蔽注入） | `t_mock({ now })` | `t_advanceMs` |
| `lite-browser.mjs` | Playwright 共享单例 | 无 mock（`open` / `close`） | — |
| `lite-browser-timer.mjs` | 页面超时信号与周期定时 gate | `t_mock()` | `t_fireSingalTimeout` / `t_tickIntervals` |

## 不可破坏的契约

1. **门面契约**：未 mock 时原样透传原生实现，生产行为不变。内存实现不静默落真实磁盘、不静默触网；触到未实现的操作面要明确报错。
2. **方法隔离**（每个源文件第一行横幅）：`f_` 文件私有；`i_` 仅同包同侧协作（生产之间、测试之间分别允许，禁止跨侧）；`t_` 仅测试代码可引用或调用——**生产代码不得导入、读取、转存或调用 `t_*`**；无前缀为公共接口。ESLint 校验同包同侧和跨包边界；命名不替代运行时安全隔离。
3. **不保留别名**：`t_` 接口不提供无前缀别名；命令实现统一 `i_run` / `i_runSync`，不保留 `run` / `runSync`。
4. **模块级单例**：每个门面的状态是模块级单例，同进程内经同一 specifier 导入（含动态 `import()`）共享同一实例。
5. **头注释即规格**：每个模块头部的长注释是该模块的行为规格（含未覆盖面的如实声明）；行为变更必须同步头注释与 README 对应章节，不得只改代码。
6. **错误注入语义**：`exit` 须为 ≥1 整数（不允许成功回包替换）或 `wait` Promise 闸门；checkpoint 注入与故障注入互斥，不写在同一次 `t_inject` 中。

## 开发流程

1. 动手前先读目标模块的头注释、README 对应章节和 `scripts/tests/` 里的既有用例——规格都在那里，不要凭直觉猜 API。
2. 用例与实现同步演进，黑盒口径（访问被测生产模块只走公共与 `t_` 接口；测试 helper 间使用 `i_`，禁止生产代码访问测试侧 `i_`）。
3. 验证：`npm test`（= `node --test scripts/tests/*.test.mjs`，全量秒级）；关注覆盖时 `npm run test:coverage`。
4. 行为变更同步文档：模块头注释 + README；新增门面按 README 既有章节体例补一节。
5. 提交信息沿用历史风格：`feat:` / `refactor:` / `chore:` / `docs:` 前缀 + 中文一句话。**提交必须由用户显式指示。**

## 测试风格（照 `scripts/tests/` 既有用例）

- `node:test` + `node:assert/strict`；每个 `test` 前置 `/** 场景：… */` 中文说明，断言带中文消息。
- 用例起手先 `liteXxx.t_unmock()` 复位，`try/finally` 收尾——状态是进程级单例，漏清理会泄漏到后续用例。
- 遮蔽注入类用例中，真实时间等待一律 `globalThis.setTimeout`（文件内导入的 `setTimeout` mock 后是虚拟时钟）。
- 原生对照子进程使用 `scripts/tests/native-reference-env.mjs` 固定环境（屏蔽 IDE 调试器附加与终端着色干扰）。
- 「真实 vs 内存」对照用例与真实透传锚定用例统一收口在 `scripts/tests/native-reference.test.mjs`——隔离真实子进程、真实 fs、真实网络对模块业务用例进程的影响；模块主测试文件保持 mock 世界语义，共享装配抽至 plain module或随用例自带局部副本。
- 公开门面的测试文件与门面一一对应：`scripts/tests/<门面名>.test.mjs`（对照收口文件 `native-reference.test.mjs` 不承载门面）；每个门面主测试文件含一条包自引用单例检查（`import('litenvi-node/<门面名>.mjs')` 与相对导入须为同一实例）。包内实现模块通过所属门面的公开行为验证，用例归入门面测试文件，不单设同名测试文件。共用夹具放在不注册用例的辅助模块中，测试文件之间不为复用夹具而互相导入。

## 文档即代码（AI 校验）

文档（AGENTS.md / README / skills）与实现的对齐不由测试守护，改由 AI 按语义校验——横幅措辞、模块地图与实现一致性、接口面、示例块有效性、skills 软链接布局等全部文档约定面纳入同一校验，语义级判断比语法级断言更稳。测试只守护模块行为（scripts/tests/ 黑盒用例），相应的文档纪律不变：

- AGENTS.md 模块地图是唯一真源：新增模块先补表格行；新增公开门面补 `scripts/tests/<门面名>.test.mjs`，包内实现模块的用例补到所属门面测试文件。
- js 示例块约定为可真实执行的完整示例：块内只用包自引用 specifier（`'litenvi-node/…'`）、自带归位（try/finally + t_unmock）；需真实浏览器/外部服务的示例（lite-browser/playwright）除外。
- 每个模块测试文件含一条包自引用单例检查（`import('litenvi-node/<模块>.mjs')` 与相对导入须为同一实例），守护发布面与单例契约。

## 代码风格

- 缩进 2/4 空格在既有文件间不统一：**跟随所在文件的既有风格**，不顺手统一。
- 注释用中文，密度与详略向周围代码看齐（本仓库注释密度显著偏高，属既有约定）。

## 使用本库的入口

两个 skill 的真源在仓库根 `skills/` 目录（`skills/litenvi-node-dev/`、`skills/litenvi-node-use/`），`.agents/skills/` 下是指向它们的相对软链接（供 ZCode 等 Agent 工作区发现，勿在软链接侧直接改动）：业务项目里 import `litenvi-node/lite-*.mjs` 装配测试世界、注入故障、控制时钟的操作指南，见 skill **`litenvi-node-use`**；修改本仓库源码、新增命令与用例的完整指南，见 skill **`litenvi-node-dev`**。使用侧三条高频提醒：

- Git 必须显式 `t_install()`（`lite-cmd-git.mjs`），仅导入模块不会登记，未安装时执行返回 `ENOENT`。
- `lite-fs` 是黑名单制作用域：`exclude` 外的路径全部落内存卷，防止越界写穿透真实磁盘。
- 要共享单例状态，必须经同一 specifier 导入（含动态 import 的 specifier 也须一致）。
