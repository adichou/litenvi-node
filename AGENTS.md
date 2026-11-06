# litenvi-node — AI 开发与使用须知

可切换的 Node 与浏览器测试环境门面库：每个 `lite-*` 模块默认透传原生实现，测试显式 `t_mock()` 后切换到内存世界（文件系统、命令执行、Git、HTTP、时钟）。业务逻辑与路由仍运行完整生产源码。npm 公共包，纯 ESM（`"type": "module"`，经 `litenvi-node/lite-xxx.mjs` 子路径导入）。

## 模块地图

| 模块 | 门面边界 | 世界开闭 | 测试专用接口 |
|---|---|---|---|
| `lite-fs.mjs` | `node:fs` | `t_mock({ exclude })` 黑名单制内存卷 | `t_inject`、`markPersistent` |
| `lite-child_process.mjs` | `node:child_process` | `t_mock()` 后经内存命令分派 | `t_calls` / `t_reset` |
| `lite-process.mjs` | `process` | `t_mock({ cwd, argv?, env?, pid? })` | `t_exitCodes` |
| `lite-http.mjs` | `node:http` 客户端 | `t_mock()` | `t_inject`（传输层，请求未达 handler） |
| `lite-server.mjs` | `http.createServer` 服务端 | `t_mock()`；可多服务、virtual listen | `t_inject`（响应阶段）、`t_port` / `t_requests` / `t_resetRequests` |
| `lite-cmd-mgr.mjs` | 命令内核（登记表，无开关） | — | `mgr.command(...).t_inject / t_onRun`、`t_defineUserCommand / t_defined` |
| `lite-cmd-node.mjs` / `lite-cmd-os.mjs` | 系统命令集 | 导入即登记 | — |
| `lite-cmd-git.mjs` | Git 命令集 | 测试显式 `t_install()` | `t_install` |
| `lite-timer.mjs` | Node 定时器与 `Date`（遮蔽注入） | `t_mock({ now })` | `t_advanceMs` |
| `lite-browser.mjs` | Playwright 共享单例 | 无 mock（`open` / `close`） | — |
| `lite-browser-timer.mjs` | 页面超时信号与周期定时 gate | `t_mock()` | `t_fireSingalTimeout` / `t_tickIntervals` |

## 不可破坏的契约

1. **门面契约**：未 mock 时原样透传原生实现，生产行为不变。内存实现不静默落真实磁盘、不静默触网；触到未实现的操作面要明确报错。
2. **方法隔离**（每个源文件第一行横幅）：`f_` 文件私有；`pkg_` 仅同包协作；`t_` 仅测试代码可引用或调用——**生产代码不得导入、读取、转存或调用 `t_*`**；无前缀为公共接口。当前无 ESLint / 运行时强制，靠头注释与命名表达，AI 必须自觉遵守。
3. **不保留别名**：`t_` 接口不提供无前缀别名；命令实现统一 `pkg_run` / `pkg_runSync`，不保留 `run` / `runSync`。
4. **模块级单例**：每个门面的状态是模块级单例，同进程内经同一 specifier 导入（含动态 `import()`）共享同一实例。
5. **头注释即规格**：每个模块头部的长注释是该模块的行为规格（含未覆盖面的如实声明）；行为变更必须同步头注释与 README 对应章节，不得只改代码。
6. **错误注入语义**：`exit` 须为 ≥1 整数（不允许成功回包替换）或 `wait` Promise 闸门；checkpoint 注入与故障注入互斥，不写在同一次 `t_inject` 中。

## 开发流程

1. 动手前先读目标模块的头注释、README 对应章节和 `tests/` 里的既有用例——规格都在那里，不要凭直觉猜 API。
2. 用例与实现同步演进，黑盒口径（只走公共与 `t_` 接口）。
3. 验证：`npm test`（= `node --test tests/*.test.mjs`，全量秒级）；关注覆盖时 `npm run test:coverage`。
4. 行为变更同步文档：模块头注释 + README；新增门面按 README 既有章节体例补一节。
5. 提交信息沿用历史风格：`feat:` / `refactor:` / `chore:` / `docs:` 前缀 + 中文一句话。**提交必须由用户显式指示。**

## 测试风格（照 `tests/` 既有用例）

- `node:test` + `node:assert/strict`；每个 `test` 前置 `/** 场景：… */` 中文说明，断言带中文消息。
- 用例起手先 `liteXxx.t_unmock()` 复位，`try/finally` 收尾——状态是进程级单例，漏清理会泄漏到后续用例。
- 遮蔽注入类用例中，真实时间等待一律 `globalThis.setTimeout`（文件内导入的 `setTimeout` mock 后是虚拟时钟）。
- 原生对照子进程使用 `tests/native-reference-env.mjs` 固定环境（屏蔽 IDE 调试器附加与终端着色干扰）。
- 测试文件与模块一一对应：`tests/<模块名>.test.mjs`。

## 代码风格

- 缩进 2/4 空格在既有文件间不统一：**跟随所在文件的既有风格**，不顺手统一。
- 注释用中文，密度与详略向周围代码看齐（本仓库注释密度显著偏高，属既有约定）。

## 使用本库的入口

两个 skill 的真源在仓库根 `skills/` 目录（`skills/litenvi-node-dev/`、`skills/litenvi-node-use/`），`.agents/skills/` 下是指向它们的相对软链接（供 ZCode 等 Agent 工作区发现，勿在软链接侧直接改动）：业务项目里 import `litenvi-node/lite-*.mjs` 装配测试世界、注入故障、控制时钟的操作指南，见 skill **`litenvi-node-use`**；修改本仓库源码、新增命令与用例的完整指南，见 skill **`litenvi-node-dev`**。使用侧三条高频提醒：

- Git 必须显式 `t_install()`，仅导入模块不会登记，未安装时执行返回 `ENOENT`。
- `lite-fs` 是黑名单制作用域：`exclude` 外的路径全部落内存卷，防止越界写穿透真实磁盘。
- 要共享单例状态，必须经同一 specifier 导入（含动态 import 的 specifier 也须一致）。
