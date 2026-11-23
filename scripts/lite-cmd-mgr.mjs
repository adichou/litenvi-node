// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-mgr：命令模拟内核——/mock-cmd/ 命名空间下的命令登记、系统卷安装、PATH 解析与
// 统一故障注入。无 mock/unmock（世界开闭由各门面自理：lite-fs 管卷、lite-child_process 管
// spawn 边界、lite-process 管进程环境面）：mgr 只维护「完整路径 → impl」注册表，并在 lite-fs
// 内存卷内维护 /mock-cmd 系统卷（导入即 markPersistent 登记持久根——跨卷复位存活：测试世界
// unmock+mock 重建用户数据时命令文件无须重装；lite-fs 保持零命令知识）。
// 命令集分层（用户定稿 2026-11 调整）：mgr 不自动加载任何命令集——node/os/git 命令
// 一律由测试显式调用所属命令集模块的 t_install() 安装，导入不登记。需要哪些系统命令由世界
// 装配方（测试用例）显式安装决定。登记统一经 i_defineCommand(path, impl)：impl =
// { i_run(argv, ctx, child)?, i_runSync(argv, ctx)? }——i_run 服务异步 spawn（驱动子进程事件面），
// i_runSync 服务 spawnSync（返回同步结果对象面）；ctx 由 lite-child_process 派遣时传入（进程面
// 能力：cwd/env/argv 安装等——命令集不依赖 lite-process）。
// 解析对齐真实 exec 语义：裸名按 PATH 顺序搜 /mock-cmd/usr/local/bin → /mock-cmd/usr/bin →
// /mock-cmd/bin；绝对路径按前缀映射（'/usr/bin/open' → '/mock-cmd/usr/bin/open'，'/mock-cmd/…'
// 原样）；i_resolve 执行寻址须文件已在卷内安装且已定义，未命中返回 null——首次惰性安装：i_resolve
// 未命中且卷内尚无 /mock-cmd 时先 f_install() 再重试一次（世界无须显式装）。f_install() 为私有幂等方法
//（卷内已有 /mock-cmd 即 no-op）；lite-fs 未 mock 时 f_install 抛错（防向真实磁盘根写 /mock-cmd）。
// t_defineUserCommand(name, impl)：用户级临时命令——落 /mock/bin（PATH 序在系统命令之前，可遮蔽），卷复
// 位即清（非持久根），须先 mock lite-fs。统一 inject 支持命令故障及命令实现提供的检查点；fault = { exit?, stderr?, wait?, once?, subcommand? }，exit 须
// 为 ≥1 整数（不允许成功回包替换）或 wait 为 Promise 闸门（命中后放行再回失败包——异步面闸
// 门、同步面无法阻塞事件循环直接回包）；stderr 附随失败包 { status: exit, stdout: '', stderr }；
// once 命中即毁。命令对象的 t_inject(fault) / t_onRun(handler) / t_impl() 仅供测试；i_takeFault() / i_runSync()
// 为内部协作方法，i_ 前缀仅表示约定。异步等待与分派由 lite-child_process 统一处理。
// t_onRun(handler) 的 handler(call, runBuiltin) 同时覆盖同步和异步命令；undefined 回落，结果替换。
// 异步入口允许 Promise，runBuiltin() 对异步实现返回聚合输出的 Promise、同步实现仍返回对象；
// 同步入口明确拒绝 Promise。
// command(nameOrPath) 为配置/转调寻址：按与 i_resolve
// 相同的名字映射查注册表，但不要求文件已装（onRun/inject 可在世界建立前配置，lite-process
// 的 chdir/exit/kill 转调同口径）。命令条目携带通用接口：execPath（可执行路径）与当前执行
// argv 查询（i_currentArgv——分派层建立、进程门面读取）。状态为模块级单例：同进程内经同一
// specifier 导入共享。
// 同步钩子误返回 Promise 时立即拒绝，后续 Promise 拒绝会记录原始错误，避免未处理或静默丢弃。
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import liteFs from './lite-fs.mjs';

const f_NAMESPACE = '/mock-cmd'; // 命令系统卷根（lite-fs 内存卷内的持久根）
const f_USER_BIN = '/mock/bin'; // 用户级命令目录：卷内普通路径（非持久根）——卷复位即清，临时命令的家
// PATH 搜索序（真实 exec 语义）：用户级在前（Unix 惯例——用户可遮蔽同名系统命令），系统级在后
const f_PATH_DIRS = [f_USER_BIN, `${f_NAMESPACE}/usr/local/bin`, `${f_NAMESPACE}/usr/bin`, `${f_NAMESPACE}/bin`];

// 当前命令执行环境：分派层调用命令实现前进入（f_runAsCurrent），记录规范化 argv 视图
//（argv[0] = 命令 execPath）；lite-process.argv 经 i_currentArgv 读取。
const f_currentExecution = new AsyncLocalStorage();

// 私有方法：包裹一次命令执行，建立当前执行环境；同步进入、实现（含其异步续体）内可查。
function f_runAsCurrent(entry, args, run) {
    return f_currentExecution.run({ argv: [entry.execPath, ...args] }, run);
}

liteFs.markPersistent(f_NAMESPACE); // 导入即登记（幂等）：命令文件跨卷复位存活

const f_registry = new Map(); // 完整路径 → 命令条目（含 impl 与分派面，见 i_defineCommand）

// 故障校验：exit ≥1 整数（不允许成功回包替换）或 wait 为 Promise 闸门，二者必有其一
// 私有方法：校验命令故障配置；仅在本文件实现中使用，不导出。
function f_validateFault(fault, commandPath) {
    if (!fault || typeof fault !== 'object')
        throw new Error('lite-cmd-mgr.command(...).t_inject 需要 fault 对象 { exit?, stderr?, wait?, once? }');
    if (fault.checkpoint !== undefined) {
        if (typeof fault.checkpoint !== 'string' || !fault.checkpoint.trim())
            throw new Error('checkpoint 须为非空字符串');
        if (typeof fault.onHit !== 'function') throw new Error('checkpoint 的 onHit 须为函数');
        if (fault.exit !== undefined || fault.wait !== undefined || fault.stderr !== undefined || fault.subcommand !== undefined)
            throw new Error('checkpoint 不能与命令故障配置混用');
        if (fault.once !== undefined && typeof fault.once !== 'boolean')
            throw new Error('lite-cmd-mgr.command(...).t_inject 的 once 须为布尔值');
        return;
    }
    if (fault.onHit !== undefined) throw new Error('onHit 需要 checkpoint');
    const hasExit = fault.exit !== undefined;
    const hasWait = fault.wait !== undefined;
    if (!hasExit && !hasWait)
        throw new Error('lite-cmd-mgr.command(...).t_inject 需要 exit（≥1 整数）或 wait（Promise 闸门）之一');
    if (hasExit && (!Number.isInteger(fault.exit) || fault.exit < 1))
        throw new Error('lite-cmd-mgr.command(...).t_inject 的 exit 须为 ≥1 的整数（不允许成功回包替换）');
    if (hasWait && !(fault.wait instanceof Promise))
        throw new Error('lite-cmd-mgr.command(...).t_inject 的 wait 须为 Promise（闸门：命中后放行再回失败包）');
    if (fault.stderr !== undefined && typeof fault.stderr !== 'string')
        throw new Error('lite-cmd-mgr.command(...).t_inject 的 stderr 须为字符串');
    if (fault.once !== undefined && typeof fault.once !== 'boolean')
        throw new Error('lite-cmd-mgr.command(...).t_inject 的 once 须为布尔值');
    if (fault.subcommand !== undefined) {
        if (path.basename(commandPath) !== 'git')
            throw new Error('subcommand 故障匹配仅支持 git 命令');
        if (typeof fault.subcommand !== 'string' || !/^[a-z][a-z0-9-]*$/.test(fault.subcommand))
            throw new Error('subcommand 须为非空 Git 子命令名称');
    }
}

// Git 全局参数按 mini-git 支持的口径跳过，子命令后的参数不参与匹配。
function f_gitSubcommand(argv) {
    let i = 0;
    while (i < argv.length) {
        if ((argv[i] === '-c' || argv[i] === '-C') && i + 1 < argv.length) i += 2;
        else if (['--no-optional-locks', '--no-pager', '--literal-pathspecs'].includes(argv[i])) i++;
        else break;
    }
    return argv[i];
}

// 故障命中：按注入序取首条匹配规则；once 仅在匹配时消费。
// 私有方法：领取命令故障配置；仅在本文件实现中使用，不导出。
function f_takeFault(faults, argv) {
    const index = faults.findIndex(fault => fault.subcommand === undefined || fault.subcommand === f_gitSubcommand(argv));
    if (index < 0)
        return null;
    const fault = faults[index];
    if (fault.once)
        faults.splice(index, 1);
    return fault;
}

// 命令条目工厂：i_defineCommand（系统命令集）与 t_defineUserCommand（用户级临时命令）共用
// 私有方法：创建命令条目；仅在本文件实现中使用，不导出。
function f_createEntry(p, impl) {
    // 命令条目保存实现与故障配置，并保留内部同步入口；异步执行归子进程门面。
    // t_inject/t_onRun 为测试配置；i_takeFault/i_runSync 供包内协作，仍使用同一条目对象
    const faults = [];
    const entry = {
        path: p,
        // 通用命令接口：命令的可执行路径（执行视角的 execPath）——注册路径即执行体所在。
        // 消费方经条目读 execPath（如 lite-process 假世界取 node 命令路径、当前执行 argv
        // 规范化 argv[0]），只依赖本通用接口，不依赖任何具体命令集模块。
        execPath: p,
        i_impl: impl,
        i_script: null, // onRun 世界脚本钩子，分别由同步入口与异步分派层包裹内置实现
        // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
        t_inject(fault) {
            f_validateFault(fault, p);
            if (fault.checkpoint !== undefined) {
                if (typeof entry.i_impl.i_injectCheckpoint !== 'function')
                    throw new Error(`命令不支持检查点：${p}`);
                let remove;
                const observer = (...args) => {
                    if (fault.once) remove();
                    return fault.onHit(...args);
                };
                remove = entry.i_impl.i_injectCheckpoint(fault.checkpoint, observer);
                return remove;
            }
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
        // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
        t_onRun(handler) { entry.i_script = handler; },
        // 测试专用方法：返回命令实现对象，供用例核对实现面契约（不保留 run/runSync 别名、
        // 声明 i_run/i_runSync 执行方法）；生产代码禁止使用（包内协作直接读 i_impl）。
        t_impl() { return entry.i_impl; },
        // 只领取故障配置，不执行也不等待；once 在领取时消费，与故障后续是否放行无关。
        // 内部方法：供 child_process 领取故障，测试通过公共执行入口验证。
        i_takeFault(argv) { return f_takeFault(faults, argv); },
        // 同步分派面：故障命中直接回失败包（同步面无法阻塞事件循环，闸门不适用）。onRun 钩子
        // 为通用包裹：签名 (call, runBuiltin)——runBuiltin() 惰性执行内置实现并取回包，钩子可
        // 包裹改写（如前后加标记证明确实走了钩子）、可整体替换（不调 runBuiltin 直接回对象，
        // 内置零执行——脚本化纯 stub 形态）、可返回 undefined 交 mgr 自动跑内置（回落真实语义）。
        // 兼容性：既有单参钩子 (call) => … 不调 runBuiltin，行为与旧「命中即跳过内置」一致
        // 子进程异步入口已领取故障时显式传 null，避免同步回落再次消费后续故障。
        // 内部方法：供 child_process 和 lite-process 同步分派，测试不直接调用。
        i_runSync: (argv, ctx, fault = f_takeFault(faults, argv)) => {
            if (fault)
                return { status: fault.exit ?? 1, stdout: '', stderr: fault.stderr ?? '' };
            const call = { argv: [...argv], options: { ...(ctx?.options || {}) } };
            if (entry.i_script) {
                let builtinRan = false, builtinResult = null;
                // 私有方法：仅在本文件实现中使用，不导出。
                const f_runBuiltin = () => {
                    if (!builtinRan) {
                        builtinRan = true;
                        builtinResult = typeof entry.i_impl.i_runSync === 'function'
                            ? entry.i_impl.i_runSync([...argv], ctx)
                            : { status: 1, stdout: '', stderr: '' };
                    }
                    return builtinResult;
                };
                const out = entry.i_script(call, f_runBuiltin);
                if (out && typeof out.then === 'function') {
                    Promise.resolve(out).catch(error => { console.warn('同步命令钩子返回的 Promise 已拒绝：', error); });
                    throw new TypeError('同步命令钩子不能返回 Promise；请通过异步子进程入口执行');
                }
                if (out !== undefined)
                    return { status: 0, stdout: '', stderr: '', ...(out || {}) };
                return f_runBuiltin(); // 钩子未命中（undefined）：回落内置真实语义
            }
            return typeof entry.i_impl.i_runSync === 'function'
                ? entry.i_impl.i_runSync([...argv], ctx)
                : { status: 1, stdout: '', stderr: '' };
        },
    };
    f_registry.set(p, entry);
    return entry;
}

// i_defineCommand：系统命令集定义（node/os 导入时调用，git 在 t_install 时调用）——落 /mock-cmd 持久
// 系统卷；系统卷已装的世界晚定义即刻补文件（维持「/mock-cmd 在卷 ⟺ 已定义系统命令全部在卷」）
// 私有：登记系统命令，由门面的 i_defineCommand 属性供包内协作。
function f_defineCommand(cmdPath, impl) {
    const p = String(cmdPath ?? '');
    if (!p.startsWith(`${f_NAMESPACE}/`) || p === f_NAMESPACE)
        throw new Error(`lite-cmd-mgr.i_defineCommand 的 path 须为 ${f_NAMESPACE}/ 命名空间下的完整路径：${p}`);
    if (!impl || typeof impl !== 'object')
        throw new Error(`lite-cmd-mgr.i_defineCommand 需要 impl 对象（{ i_run?, i_runSync? }）：${p}`);
    const entry = f_createEntry(p, impl);
    if (liteFs.isMocked() && liteFs.existsSync(f_NAMESPACE))
        f_writeCommandFile(p);
    return entry;
}

// t_defineUserCommand：用户级临时命令注册（用例内自定义命令的正道）——落 /mock/bin（卷内普通路径，
// 非持久根）：①不污染 /mock-cmd 系统卷；②卷复位文件即清，用例间不泄漏（注册表条目随卷
// 失效——i_resolve 须文件在卷，陈旧条目惰性失活）；③PATH 序在系统命令之前，可遮蔽同名系统
// 命令。须先 lite-fs mock（命令文件落内存卷，防向真实磁盘写 /mock）
// 私有：登记用户临时命令，由门面的 t_defineUserCommand 属性供测试使用。
function f_defineUserCommand(name, impl) {
    const n = String(name ?? '');
    if (!n || n.includes('/') || path.isAbsolute(n))
        throw new Error(`lite-cmd-mgr.t_defineUserCommand 的 name 须为裸命令名（不含路径）：${n}`);
    if (!impl || typeof impl !== 'object')
        throw new Error(`lite-cmd-mgr.t_defineUserCommand 需要 impl 对象（{ i_run?, i_runSync? }）：${n}`);
    if (!liteFs.isMocked())
        throw new Error('lite-cmd-mgr.t_defineUserCommand 需要 lite-fs 先 t_mock（用户级命令文件落内存卷 /mock/bin）');
    const entry = f_createEntry(`${f_USER_BIN}/${n}`, impl);
    f_writeCommandFile(`${f_USER_BIN}/${n}`);
    return entry;
}

// 命令文件节点：普通空文件即可（path → impl 映射留在注册表；文件存在性是解析命中条件）
// 私有方法：创建命令文件；仅在本文件实现中使用，不导出。
function f_writeCommandFile(p) {
    liteFs.mkdirSync(path.dirname(p), { recursive: true });
    liteFs.writeFileSync(p, '');
}

// f_install：在当前内存卷内重建系统卷全部命令文件。幂等：卷内已有 /mock-cmd 即 no-op；
// lite-fs 未 mock 时抛错——防误装向真实磁盘根写 /mock-cmd
// 私有方法：安装系统命令文件，仅由本文件的执行寻址触发，不导出。
function f_install() {
    if (!liteFs.isMocked())
        throw new Error('lite-cmd-mgr.f_install 需要 lite-fs 先 t_mock（/mock-cmd 系统卷只存在于内存卷）');
    if (liteFs.existsSync(f_NAMESPACE))
        return;
    for (const p of f_registry.keys())
        if (p.startsWith(`${f_NAMESPACE}/`)) // 只装系统命令：用户级 register 命令靠卷复位清除，不经系统安装复活
            f_writeCommandFile(p);
}

// 名字 → 候选条目序列（按 PATH 序，可能多条）：裸名逐目录收集全部命中——用户级遮蔽条目在
// 卷复位后文件已清，只取首条会让陈旧遮蔽挡住后面的系统同名，执行寻址须按文件存在性逐条
// 挑选；绝对路径原样优先（/mock/bin/* 等卷内直查），未中再按系统卷前缀映射。
// 配置寻址（command 句柄）取首候选即可
// 私有方法：查找命令候选条目；仅在本文件实现中使用，不导出。
function f_candidatesOfName(command) {
    const name = String(command ?? '');
    if (!name)
        return [];
    if (path.isAbsolute(name)) {
        const out = [];
        if (f_registry.has(name))
            out.push(f_registry.get(name));
        const mapped = name.startsWith(`${f_NAMESPACE}/`) ? name : `${f_NAMESPACE}${name}`;
        if (f_registry.has(mapped) && mapped !== name)
            out.push(f_registry.get(mapped));
        return out;
    }
    return f_PATH_DIRS.map(dir => f_registry.get(path.join(dir, name))).filter(Boolean);
}

// 执行寻址（spawn/spawnSync 派遣用）：注册表命中且文件已在卷内安装；未命中且卷内尚无系统卷
// → 惰性安装后重试一次；仍未命中返回 null
// 私有：执行寻址，由门面的 i_resolve 属性供包内协作。
function f_resolve(command) {
    for (const entry of f_candidatesOfName(command))
        if (liteFs.existsSync(entry.path))
            return entry;
    if (liteFs.isMocked() && !liteFs.existsSync(f_NAMESPACE)) {
        f_install();
        for (const entry of f_candidatesOfName(command))
            if (liteFs.existsSync(entry.path))
                return entry;
    }
    return null;
}

const liteCmdMgr = {
    // 内部方法：仅限同一 package 内模块协作，测试通过公共入口验证。
    i_defineCommand: f_defineCommand,
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_defineUserCommand: f_defineUserCommand,
    // 内部方法：仅限同一 package 内模块协作，测试通过公共入口验证。
    i_resolve: f_resolve,
    // 当前命令执行环境（通用接口）：分派层（lite-child_process 的 spawn/spawnSync）在调用
    // 命令实现前经 i_runAsCurrent 进入、实现返回后退出；「当前命令的 argv」是执行态事实、
    // 归分派层所有，不属于任何具体命令集——进程门面（lite-process.argv）经 i_currentArgv
    // 读取。默认 argv 视图为 [entry.execPath, ...args]（argv[0] = 命令 execPath，与原生
    // Node 对 process.argv 的规范化同口径）；带参数文法的命令（如 node 剔除脚本前 CLI 旗标）
    // 解析出真实入口参数后经 i_setCurrentArgv 细化本视图。嵌套分派内层生效（npm run 拉起
    // 子命令时子命令环境覆盖父命令，AsyncLocalStorage 语义），异步实现内部创建的续体继承
    // 当前环境。
    i_runAsCurrent: f_runAsCurrent,
    // 内部方法：当前命令执行的规范化 argv 视图；不在任何命令执行内时返回 undefined。
    i_currentArgv() { return f_currentExecution.getStore()?.argv; },
    // 内部方法：细化当前执行的 argv 视图（命令实现解析出真实入口参数后回写）；不在任何
    // 命令执行内时为 no-op。
    i_setCurrentArgv(argv) { const store = f_currentExecution.getStore(); if (store) store.argv = [...argv]; },
    // 配置/转调寻址：注册表命中即可，不要求文件已装（onRun/inject 世界建立前可配置；lite-process
    // 的 chdir/exit/kill 转调同口径——命令在即语义在）
    // 外部方法：允许所有调用方使用，包括测试文件。
    command(commandName) { return f_candidatesOfName(commandName)[0] ?? null; },
    // 注册表自省：已定义命令的完整路径清单（有序）
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_defined() { return [...f_registry.keys()].sort(); },
};

export default liteCmdMgr;
