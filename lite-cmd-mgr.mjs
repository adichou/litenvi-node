// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；无前缀的接口允许所有调用方使用。
// lite-cmd-mgr：命令模拟内核——/mock-cmd/ 命名空间下的命令登记、系统卷安装、PATH 解析与
// 统一故障注入。无 mock/unmock（世界开闭由各门面自理：lite-fs 管卷、lite-child_process 管
// spawn 边界、lite-process 管进程环境面）：mgr 只维护「完整路径 → impl」注册表，并在 lite-fs
// 内存卷内维护 /mock-cmd 系统卷（导入即 markPersistent 登记持久根——跨卷复位存活：测试世界
// unmock+mock 重建用户数据时命令文件无须重装；lite-fs 保持零命令知识）。
// 命令集分层（用户定稿）：node/os 是系统级——mgr 导入即自动协同加载（上表尾统一注册）；
// git 显式导入才加载（lite-cmd-git 保留导入即登记）。登记统一经 pkg_defineCommand(path, impl)：impl =
// { run(argv, ctx, child)?, runSync(argv, ctx)? }——run 服务异步 spawn（驱动子进程事件面），
// runSync 服务 spawnSync（返回同步结果对象面）；ctx 由 lite-child_process 派遣时传入（进程面
// 能力：cwd/env/argv 安装等——命令集不依赖 lite-process）。
// 解析对齐真实 exec 语义：裸名按 PATH 顺序搜 /mock-cmd/usr/local/bin → /mock-cmd/usr/bin →
// /mock-cmd/bin；绝对路径按前缀映射（'/usr/bin/open' → '/mock-cmd/usr/bin/open'，'/mock-cmd/…'
// 原样）；pkg_resolve 执行寻址须文件已在卷内安装且已定义，未命中返回 null——首次惰性安装：pkg_resolve
// 未命中且卷内尚无 /mock-cmd 时先 f_install() 再重试一次（世界无须显式装）。f_install() 为私有幂等方法
//（卷内已有 /mock-cmd 即 no-op）；lite-fs 未 mock 时 f_install 抛错（防向真实磁盘根写 /mock-cmd）。
// defineUserCommand(name, impl)：用户级临时命令——落 /mock/bin（PATH 序在系统命令之前，可遮蔽），卷复
// 位即清（非持久根），须先 mock lite-fs。统一 inject（哲学对齐 lite-http/lite-server）：fault = { exit?, stderr?, wait?, once? }，exit 须
// 为 ≥1 整数（不允许成功回包替换）或 wait 为 Promise 闸门（命中后放行再回失败包——异步面闸
// 门、同步面无法阻塞事件循环直接回包）；stderr 附随失败包 { status: exit, stdout: '', stderr }；
// once 命中即毁。命令对象公开 inject(fault) / onRun(handler)；pkg_takeFault() / pkg_runSync()
// 为内部协作方法，pkg_ 前缀仅表示约定。异步等待与分派由 lite-child_process 统一处理。
// command(nameOrPath) 为配置/转调寻址：按与 pkg_resolve
// 相同的名字映射查注册表，但不要求文件已装（onRun/inject 可在世界建立前配置，lite-process
// 的 chdir/exit/kill 转调同口径）。状态为模块级单例：同进程内经同一 specifier 导入共享。
import path from 'node:path';
import liteFs from './lite-fs.mjs';
import { pkg_COMMANDS as pkg_NODE_COMMANDS } from './lite-cmd-node.mjs';
import { pkg_COMMANDS as pkg_OS_COMMANDS } from './lite-cmd-os.mjs';

const f_NAMESPACE = '/mock-cmd'; // 命令系统卷根（lite-fs 内存卷内的持久根）
const f_USER_BIN = '/mock/bin'; // 用户级命令目录：卷内普通路径（非持久根）——卷复位即清，临时命令的家
// PATH 搜索序（真实 exec 语义）：用户级在前（Unix 惯例——用户可遮蔽同名系统命令），系统级在后
const f_PATH_DIRS = [f_USER_BIN, `${f_NAMESPACE}/usr/local/bin`, `${f_NAMESPACE}/usr/bin`, `${f_NAMESPACE}/bin`];

liteFs.markPersistent(f_NAMESPACE); // 导入即登记（幂等）：命令文件跨卷复位存活

const f_registry = new Map(); // 完整路径 → 命令条目（含 impl 与分派面，见 pkg_defineCommand）

// 故障校验：exit ≥1 整数（不允许成功回包替换）或 wait 为 Promise 闸门，二者必有其一
// 私有方法：校验命令故障配置；仅在本文件实现中使用，不导出。
function f_validateFault(fault) {
    if (!fault || typeof fault !== 'object')
        throw new Error('lite-cmd-mgr.command(...).inject 需要 fault 对象 { exit?, stderr?, wait?, once? }');
    const hasExit = fault.exit !== undefined;
    const hasWait = fault.wait !== undefined;
    if (!hasExit && !hasWait)
        throw new Error('lite-cmd-mgr.command(...).inject 需要 exit（≥1 整数）或 wait（Promise 闸门）之一');
    if (hasExit && (!Number.isInteger(fault.exit) || fault.exit < 1))
        throw new Error('lite-cmd-mgr.command(...).inject 的 exit 须为 ≥1 的整数（不允许成功回包替换）');
    if (hasWait && !(fault.wait instanceof Promise))
        throw new Error('lite-cmd-mgr.command(...).inject 的 wait 须为 Promise（闸门：命中后放行再回失败包）');
    if (fault.stderr !== undefined && typeof fault.stderr !== 'string')
        throw new Error('lite-cmd-mgr.command(...).inject 的 stderr 须为字符串');
    if (fault.once !== undefined && typeof fault.once !== 'boolean')
        throw new Error('lite-cmd-mgr.command(...).inject 的 once 须为布尔值');
}

// 故障命中：按注入序取首条；once 命中即毁（对齐 lite-http 的 once 自毁语义）
// 私有方法：领取命令故障配置；仅在本文件实现中使用，不导出。
function f_takeFault(faults) {
    const fault = faults[0];
    if (!fault)
        return null;
    if (fault.once)
        faults.shift();
    return fault;
}

// 命令条目工厂：pkg_defineCommand（系统命令集）与 defineUserCommand（用户级临时命令）共用
// 私有方法：创建命令条目；仅在本文件实现中使用，不导出。
function f_createEntry(p, impl) {
    // 命令条目保存实现与故障配置，并保留内部同步入口；异步执行归子进程门面。
    // inject/onRun 为公开配置；pkg_takeFault/pkg_runSync 供模块间协作，仍使用同一条目对象
    const faults = [];
    const entry = {
        path: p,
        pkg_impl: impl,
        pkg_script: null, // onRun 世界脚本钩子，由同步入口统一包裹内置实现
        // 外部方法：注入命令故障，允许所有调用方使用，包括测试文件。
        inject(fault) {
            f_validateFault(fault);
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
        // 外部方法：配置命令执行钩子，允许所有调用方使用，包括测试文件。
        onRun(handler) { entry.pkg_script = handler; },
        // 只领取故障配置，不执行也不等待；once 在领取时消费，与故障后续是否放行无关。
        // 内部方法：供 child_process 领取故障，测试通过公共执行入口验证。
        pkg_takeFault() { return f_takeFault(faults); },
        // 同步分派面：故障命中直接回失败包（同步面无法阻塞事件循环，闸门不适用）。onRun 钩子
        // 为通用包裹：签名 (call, runBuiltin)——runBuiltin() 惰性执行内置实现并取回包，钩子可
        // 包裹改写（如前后加标记证明确实走了钩子）、可整体替换（不调 runBuiltin 直接回对象，
        // 内置零执行——脚本化纯 stub 形态）、可返回 undefined 交 mgr 自动跑内置（回落真实语义）。
        // 兼容性：既有单参钩子 (call) => … 不调 runBuiltin，行为与旧「命中即跳过内置」一致
        // 子进程异步入口已领取故障时显式传 null，避免同步回落再次消费后续故障。
        // 内部方法：供 child_process 和 lite-process 同步分派，测试不直接调用。
        pkg_runSync(argv, ctx, fault = f_takeFault(faults)) {
            if (fault)
                return { status: fault.exit ?? 1, stdout: '', stderr: fault.stderr ?? '' };
            const call = { argv: [...argv], options: { ...(ctx?.options || {}) } };
            if (entry.pkg_script) {
                let builtinRan = false, builtinResult = null;
                // 私有方法：仅在本文件实现中使用，不导出。
                const f_runBuiltin = () => {
                    if (!builtinRan) {
                        builtinRan = true;
                        builtinResult = typeof entry.pkg_impl.runSync === 'function'
                            ? entry.pkg_impl.runSync([...argv], ctx)
                            : { status: 1, stdout: '', stderr: '' };
                    }
                    return builtinResult;
                };
                const out = entry.pkg_script(call, f_runBuiltin);
                if (out !== undefined)
                    return { status: 0, stdout: '', stderr: '', ...(out || {}) };
                return f_runBuiltin(); // 钩子未命中（undefined）：回落内置真实语义
            }
            return typeof entry.pkg_impl.runSync === 'function'
                ? entry.pkg_impl.runSync([...argv], ctx)
                : { status: 1, stdout: '', stderr: '' };
        },
    };
    f_registry.set(p, entry);
    return entry;
}

// pkg_defineCommand：系统命令集定义（lite-cmd-node/-git/-os 导入时调用）——落 /mock-cmd 持久
// 系统卷；系统卷已装的世界晚定义即刻补文件（维持「/mock-cmd 在卷 ⟺ 已定义系统命令全部在卷」）
// 内部方法：登记系统命令；仅限同一 package 内模块协作，测试通过公共入口验证。
function pkg_defineCommand(cmdPath, impl) {
    const p = String(cmdPath ?? '');
    if (!p.startsWith(`${f_NAMESPACE}/`) || p === f_NAMESPACE)
        throw new Error(`lite-cmd-mgr.pkg_defineCommand 的 path 须为 ${f_NAMESPACE}/ 命名空间下的完整路径：${p}`);
    if (!impl || typeof impl !== 'object')
        throw new Error(`lite-cmd-mgr.pkg_defineCommand 需要 impl 对象（{ run?, runSync? }）：${p}`);
    const entry = f_createEntry(p, impl);
    if (liteFs.isMocked() && liteFs.existsSync(f_NAMESPACE))
        f_writeCommandFile(p);
    return entry;
}

// defineUserCommand：用户级临时命令注册（用例内自定义命令的正道）——落 /mock/bin（卷内普通路径，
// 非持久根）：①不污染 /mock-cmd 系统卷；②卷复位文件即清，用例间不泄漏（注册表条目随卷
// 失效——pkg_resolve 须文件在卷，陈旧条目惰性失活）；③PATH 序在系统命令之前，可遮蔽同名系统
// 命令。须先 lite-fs mock（命令文件落内存卷，防向真实磁盘写 /mock）
// 外部方法：登记用户临时命令；允许所有调用方使用，包括测试文件。
function defineUserCommand(name, impl) {
    const n = String(name ?? '');
    if (!n || n.includes('/') || path.isAbsolute(n))
        throw new Error(`lite-cmd-mgr.defineUserCommand 的 name 须为裸命令名（不含路径）：${n}`);
    if (!impl || typeof impl !== 'object')
        throw new Error(`lite-cmd-mgr.defineUserCommand 需要 impl 对象（{ run?, runSync? }）：${n}`);
    if (!liteFs.isMocked())
        throw new Error('lite-cmd-mgr.defineUserCommand 需要 lite-fs 先 mock（用户级命令文件落内存卷 /mock/bin）');
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
        throw new Error('lite-cmd-mgr.f_install 需要 lite-fs 先 mock（/mock-cmd 系统卷只存在于内存卷）');
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
// 内部方法：执行寻址；仅限同一 package 内模块协作，测试通过公共入口验证。
function pkg_resolve(command) {
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
    pkg_defineCommand,
    // 外部方法：允许所有调用方使用，包括测试文件。
    defineUserCommand,
    // 内部方法：仅限同一 package 内模块协作，测试通过公共入口验证。
    pkg_resolve,
    // 配置/转调寻址：注册表命中即可，不要求文件已装（onRun/inject 世界建立前可配置；lite-process
    // 的 chdir/exit/kill 转调同口径——命令在即语义在）
    // 外部方法：允许所有调用方使用，包括测试文件。
    command(commandName) { return f_candidatesOfName(commandName)[0] ?? null; },
    // 注册表自省：已定义命令的完整路径清单（有序）
    // 外部方法：允许所有调用方使用，包括测试文件。
    defined() { return [...f_registry.keys()].sort(); },
};

// 假世界退出意图载体：记录在案、向上抛出，由调用方决定如何收场——不静默吞掉（失败必须可见）。
// 定义在本模块：exit 命令实现（lite-cmd-os）与 process 替身（lite-process 转出口径）共用，
// 两者依赖方向都指向 mgr
class pkg_ProcessExitError extends Error {
    // 外部构造方法：经 lite-process 的 ProcessExitError 导出供调用方识别退出意图。
    constructor(code) {
        super(`ProcessExitError：假世界 process.exit(${code})——退出码已记录，宿主进程不终止`);
        this.name = 'ProcessExitError';
        this.exitCode = code;
    }
}

// 系统级命令集自动协同加载（node/os：用户定稿——随 mgr 导入即注册；git 为显式导入加载，
// 见 lite-cmd-git 的导入即登记）。置于文件尾：f_registry 与 pkg_defineCommand 均已就绪
for (const [cmdPath, impl] of [...Object.entries(pkg_NODE_COMMANDS), ...Object.entries(pkg_OS_COMMANDS)])
    pkg_defineCommand(cmdPath, impl);

// 内部导出：命令实现共用退出意图类型；对外由 lite-process 导出 ProcessExitError。
export { pkg_ProcessExitError };
export default liteCmdMgr;
