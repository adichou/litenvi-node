---
name: litenvi-node-dev
description: 开发 litenvi-node 仓库本身时使用。修改 lite-* 门面源码、新增内存命令或故障注入能力、编写或调整 tests/ 黑盒用例、演进模块头注释与 README 规格、排查本仓库测试失败时触发。仅在业务项目里 import 'litenvi-node/…' 写测试时用 litenvi-node-use，不用本 skill。
---

# litenvi-node 开发指南

本仓库是可切换的 Node 与浏览器测试环境门面库。开发前先读目标模块的**头注释**（它就是该模块的行为规格，含未覆盖面声明）和 README 对应章节，再动代码；不要凭直觉猜 API。仓库根 `AGENTS.md` 有模块地图与契约摘要，本 skill 是开发侧的完整操作指南。

## 架构分层与依赖方向

- **叶子模块**（不依赖其他 lite-*）：`lite-fs`（仅 node:fs/path）、`lite-timer`（仅 @sinonjs/fake-timers，不 install、不触碰宿主全局）、`lite-browser`（仅 playwright）、`lite-browser-timer`（零依赖）。
- **HTTP 管线**：`lite-server ↔ lite-http` 互为两端（浏览器流量经真实 loopback socket 回灌进程内管线：内存客户端 → 服务端故障 → 真实 handler），属既定设计，不是待修复的环。
- **命令体系**：`lite-cmd-mgr` 维护「完整路径 → impl」注册表，在 lite-fs 内存卷内维护 `/mock-cmd` 系统卷（导入即 `markPersistent`，跨卷复位存活）；`lite-cmd-node` / `lite-cmd-os` 导入即登记，`lite-cmd-git` 须测试显式 `t_install()`。
- **执行面**：`lite-child_process` 是 spawn/exec/execFile 门面，mock 后经 mgr 解析分派内存命令；进程能力（cwd/env/argv/recordExit/setCwd）由 `lite-process.pkg_commandContext` 构建并经 ctx 传入，命令集不依赖 lite-process。
- **虚拟 Node 脚本**（lite-cmd-node）：脚本普通 import 在宿主内执行，AsyncLocalStorage 将 process/console/定时器/文件路由到当前虚拟命令；spawn 输入经 lite-fs `pkg_stageStdin` 暂存为 fd 0。

新增依赖前先确认：不破坏上述分层、不引入环（http/server 互引除外）、叶子模块保持叶子。

## 不可破坏的契约

1. 未 mock 时原样透传原生实现，生产行为不变；透传路径保持原生参数与返回形态（含额外实参透传）。
2. 方法隔离：`f_` 文件私有；`pkg_` 仅同包协作；`t_` 仅测试代码可引用或调用，生产代码不得导入、读取、转存或调用。无 ESLint / 运行时强制，命名与头注释即约定，必须自觉遵守。
3. 每个源文件第一行固定方法隔离横幅：`// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。`
4. 不保留旧别名：`t_` 接口不配无前缀别名；命令实现统一 `pkg_run` / `pkg_runSync`。
5. 状态为模块级单例：同进程内经同一 specifier 导入共享同一实例。
6. 内存实现触到未实现的操作面明确报错，不静默落真实磁盘、不静默触网。
7. 故障注入：`exit` 须为 ≥1 整数（不允许成功回包替换）或 `wait` Promise 闸门；`checkpoint` 与故障配置互斥；`subcommand` 匹配仅支持 git。
8. 头注释即规格：行为变更必须同步头注释与 README，未覆盖面如实声明，不夸大。

## 常见任务

### 改动流程

1. 读目标模块头注释 + README 章节 + 对应 `tests/<模块>.test.mjs`。
2. 先补黑盒用例（或与实现同步），不写白盒（不 import 私有实现）。
3. 实现，保持透传与 mock 两侧行为。
4. `npm test` 全绿；关注覆盖时 `npm run test:coverage`。
5. 同步头注释与 README。

### 新增门面 checklist

- 源文件：第一行方法隔离横幅 + 头部规格注释（世界开闭方式、注入面、单例语义、未覆盖面）。
- 接口命名：公共无前缀；测试专用 `t_`；同包协作 `pkg_`；文件私有 `f_`。
- `tests/<模块>.test.mjs` 黑盒用例；README 按既有章节体例补一节。
- 与既有门面的分工要在头注释里写明（如 lite-timer 与 lite-browser-timer 的 Node/页面分工）。

### 新增 / 修改内存命令

- 命令实现协议：`impl = { pkg_run(argv, ctx, child)?, pkg_runSync(argv, ctx)? }`——`pkg_run` 服务异步 spawn（驱动子进程事件面），`pkg_runSync` 服务 spawnSync（返回同步结果对象面）。
- 登记：系统级经 `mgr.pkg_defineCommand(path, impl)`（node/os 导入即协同加载；git 由 `t_install()` 显式安装）；用户级临时命令走 `t_defineUserCommand(name, impl)` 落 `/mock/bin`（PATH 序在系统命令之前，可遮蔽；须先 mock lite-fs，卷复位即清）。
- `ctx` 由 lite-child_process 派遣时传入；不要在命令模块内维护子进程账本。
- 寻址：裸名按 PATH 序搜 `/mock-cmd/usr/local/bin` → `/mock-cmd/usr/bin` → `/mock-cmd/bin`（`/mock/bin` 用户级在前）；绝对路径按前缀映射到 `/mock-cmd` 命名空间。

### 故障注入与钩子

- `fault = { exit?, stderr?, wait?, once?, subcommand? }`；规则按注入顺序取首个命中，`once` 命中即毁。
- git 子命令匹配支持跳过 `-c` / `-C` / `--no-optional-locks` / `--no-pager` / `--literal-pathspecs` 全局选项。
- checkpoint 注入：`{ checkpoint, onHit }`，同步回调，在扫描未完成时重入内存命令；与故障互斥；用完必须调用返回的移除函数。
- 命令句柄 `t_onRun(handler)`：handler 为 `(call, runBuiltin) => result`，可包一层改写内置实现的结果；`t_onRun(null)` 移除。故障优先于钩子和内置执行。
- 校验逻辑集中在 `lite-cmd-mgr` 的 `f_validateFault`，新增字段先过校验并同步错误消息。

### 测试写法

- `node:test` + `node:assert/strict`；每个 `test` 前置 `/** 场景：… */` 中文说明；断言带中文消息。
- 用例起手 `liteXxx.t_unmock()` 复位，`try/finally` 收尾（或利用 node:test 的返回清理函数）——状态是进程级单例，漏清理会泄漏到后续用例。
- 遮蔽注入类用例中真实时间等待用 `globalThis.setTimeout`；需要固定 Date 对照时先存 `NativeDate = globalThis.Date`。
- 原生对照子进程使用 `tests/native-reference-env.mjs` 固定环境（LC_ALL=C、去 NODE_OPTIONS/FORCE_COLOR 等）。
- 文件与模块一一对应；跨模块协作用例（如 lite-cmd-git-lock）可同场景跑「真实实现 + 内存实现」双口径对照。

## 陷阱清单

- **单例泄漏**：整库测试顺序敏感，任何 mock 都要确保 finally 归位；`t_reset` / `t_resetRequests` 只清账本，不移除世界。
- **lite-fs 是黑名单制**：exclude 外全部落内存卷。新增"真实文件访问"需求时在调用方声明 exclude，不要回退白名单思路（曾因此让未声明路径静默走真实 fs，已废弃）。
- **注入分层**：传输层故障（请求未达 handler）归 `lite-http.t_inject`；响应阶段（handler 已执行）归 `liteServer.t_inject`；close 收尾挂起也是 lite-server 的规则。改匹配条件（url/method/path/query 规范化）时两侧同步。
- **URL 规则匹配是精确序**：查询串按完整顺序精确比较；`url` 与 `path` 的取舍、fragment 忽略等口径见 README，勿自行放宽。
- **exec shell 支持面有限**：普通引号、初始环境变量展开、`;`/`&&`/`||`、缓冲管道、`<`/`>`/`>>`、`1>&2`/`2>&1`、局部 `cd`。命令替换、通配符、循环未实现——补语法须同步 README 能力清单与用例。
- **fd 0 暂存**：spawnSync 输入经 `pkg_stageStdin` 暂存，虚拟命令 `readFileSync(0)` 同步可读，写侧 EBADF；释放时机与 `pkg_releaseStdin` 配对。
- **Git 锁语义**：add/rm/commit 独占索引锁；status 简化可选锁模型（默认尝试持锁、被占继续读）。扩展其他写命令的锁语义时在头注释声明口径。
- **缩进不统一**（2/4 空格混存）：跟随所在文件，不顺手全局统一。
- **文档先于记忆**：README 与头注释与实现三处一致才算完成；"先改代码后补文档"在本仓库算未完成。

## 提交

历史风格：`feat:` / `refactor:` / `chore:` 前缀 + 中文一句话描述（可含要点罗列）。提交操作必须由用户显式指示后执行。
