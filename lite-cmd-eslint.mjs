// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-eslint：t_install 显式安装命令，经 lite-child_process.spawn/execFile 异步执行。
// 配置 eslint.config.mjs 与依赖规则必须在 lite-fs 的真实透传域，由 Node 原生 await import
// 加载；多行 import、再导出、顶层 await、作用域、模块身份与覆盖率归属均遵循原生 ESM。
// 不改写 import/export，不使用 eval/new Function，不注入或替换 node:fs。
// 自研规则访问运行数据时显式使用 lite-fs；第三方依赖只验证消费侧配置和真实接线。
// 受检文件、目录遍历及文本读取仍经 lite-fs，Linter({ cwd }) + verify(text, configs,
// { filename }) 使用真实 ESLint 判断，保留 files/ignores、插件和 schema 校验及内联指令。
// 默认导出须为 flat config 数组；字符串插件路径作为兼容面，经原生 import 异步加载真实模块。
// 配置按 mtime 查询参数重新载入，依赖保持 Node 原生模块缓存；模块状态不随内存卷重置。
// 同步入口 spawnSync 明确失败，不阻塞宿主事件循环等待异步 import，不回退迷你加载器。
// CLI 支持 --config、--format stylish|json、--ext、--max-warnings 及显式文件/目录；
// 目录跳过点目录和 node_modules，--ext 与 config 扩展名取并集，忽略文件在读取前跳过。
// 退出 0=干净，1=规则错误或超出警告阈值，2=配置/执行错误。stylish 排版与 JSON 字段为子集。
// --fix、stdin lint、完整 glob 路径和处理器未覆盖；不支持的参数明确失败。
// 通用故障由子进程门面处理；命令 t_onRun 可观察或包裹异步 runBuiltin()（返回 Promise）。
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import mgr from './lite-cmd-mgr.mjs';
import fs from './lite-fs.mjs';

// 私有：仅为纯内存 Linter 定位宿主 eslint 包，配置及依赖交给原生模块加载器解析。
function f_npmRequires() {
    const bases = [];
    const add = (base) => {
        if (base && !bases.some((entry) => entry.base === base)) bases.push({ base, require: createRequire(base) });
    };
    if (process.argv[1]) add(process.argv[1]);
    add(path.join(process.cwd(), 'package.json'));
    add(fileURLToPath(import.meta.url));
    return bases;
}

// npm 包解析：按基序首个命中即返回；全部失败列出各尝试基，便于定位安装位置。
// 私有方法：仅在本文件实现中使用，不导出。
function f_resolveNpmPackage(spec, fromPath) {
    const failures = [];
    for (const { base, require } of f_npmRequires()) {
        try {
            return require(spec);
        } catch (error) {
            failures.push(`${path.dirname(base)}（${String(error.message).split('\n')[0]}）`);
        }
    }
    throw new Error(`无法解析 npm 包 '${spec}'（宿主未安装？尝试基：${failures.join('；')}）（${fromPath}）`);
}

// 私有：在当前文件系统作用域中逐级查找配置文件。
function f_findFlatConfig(cwd) {
    let cur = path.resolve(String(cwd));
    for (;;) {
        const candidate = path.join(cur, 'eslint.config.mjs');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
}

// 私有：只加载真实透传域中的配置或兼容插件模块，内存源码不能伪装成真实文件。
async function f_importModule(file) {
    if (!fs.pkg_isPassthrough(file)) throw new Error(`ESLint 配置/规则须位于 exclude 真实源码目录：${file}`);
    const url = pathToFileURL(file);
    url.searchParams.set('mtime', String(fs.statSync(file).mtimeMs));
    return import(url.href);
}

// 私有：保留现有文本 report 简写兼容，不改写任何模块源码或真实规则实现。
function f_wrapRule(rule) {
    const meta = rule !== null && typeof rule === 'object' ? rule.meta : undefined;
    const create = typeof rule === 'function' ? rule : rule?.create;
    if (typeof create !== 'function') return rule;
    return {
        meta,
        create(realContext) {
            const context = Object.create(realContext);
            // 真实 FileContext 的 report 是只读原型属性，普通赋值无法遮蔽，须以 defineProperty 建自有属性
            Object.defineProperty(context, 'report', {
                value: (descriptor) => {
                    // 真实引擎的 loc 坐标列以 0 基解释（输出列 = 值 + 1），文本规则的顶层 line/column
                    // 简写按 1 基约定，转换时列减 1；node/loc 形态原样透传（node 自带 0 基列）
                    if (descriptor && descriptor.node === undefined && descriptor.loc === undefined && descriptor.line !== undefined) {
                        realContext.report({ ...descriptor, loc: { line: descriptor.line, column: descriptor.column - 1 } });
                    } else {
                        realContext.report(descriptor);
                    }
                },
                writable: true,
                configurable: true,
            });
            return create(context);
        },
    };
}

// 私有：原生加载配置，规范化兼容插件路径并保持同一插件对象身份。
async function f_normalizeConfig(configPath) {
    const config = (await f_importModule(configPath)).default;
    if (!Array.isArray(config)) throw new Error(`ESLint 配置须导出数组：${configPath}`);
    const wrappedPlugins = new Map();
    const wrapPlugin = plugin => {
        if (plugin === null || typeof plugin !== 'object') return plugin;
        let wrapped = wrappedPlugins.get(plugin);
        if (!wrapped) {
            const rules = {};
            for (const [name, impl] of Object.entries(plugin.rules ?? {})) rules[name] = f_wrapRule(impl);
            wrapped = { ...plugin, rules };
            wrappedPlugins.set(plugin, wrapped);
        }
        return wrapped;
    };
    const configs = [];
    for (const item of config) {
        if (item === null || typeof item !== 'object' || Array.isArray(item) || item.plugins === undefined
            || typeof item.plugins !== 'object' || Array.isArray(item.plugins)) {
            configs.push(item);
            continue;
        }
        const plugins = {};
        for (const [name, value] of Object.entries(item.plugins)) {
            const loaded = typeof value === 'string'
                ? (await f_importModule(path.resolve(path.dirname(configPath), value))).default : value;
            plugins[name] = wrapPlugin(loaded);
        }
        configs.push({ ...item, plugins });
    }
    return configs;
}

// 候选扩展名推导：无 files 键的 item 贡献默认 js/mjs/cjs；files 模式提取尾部扩展名
//（'**/*.test.mjs' → mjs、'package.json' → json，无扩展名模式不贡献）。
// 私有方法：仅在本文件实现中使用，不导出。
// 花括号展开（仅一层、仅字面量项）：`**/*.{js,mjs}` → 两条模式。引擎 minimatch 自身支持
// 花括号；此展开只为目录递归前的扩展名推导服务。
// 私有方法：仅在本文件实现中使用，不导出。
function f_expandBraces(pattern) {
    const m = /\{([^{}]+)\}([^{]*)$/.exec(pattern);
    if (!m) return [pattern];
    const [, body, tail] = m;
    const items = body.split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length < 2) return [pattern];
    return items.flatMap((item) => f_expandBraces(pattern.slice(0, m.index) + item + tail));
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_configExts(config) {
    const exts = new Set();
    for (const item of config) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        if (item.files === undefined) {
            exts.add('js');
            exts.add('mjs');
            exts.add('cjs');
            continue;
        }
        const patterns = Array.isArray(item.files) ? item.files : [item.files];
        for (const pattern of patterns) {
            for (const expanded of f_expandBraces(String(pattern).replace(/\/+$/, ''))) {
                const m = /\.([A-Za-z][\w]*)$/.exec(expanded);
                if (m) exts.add(m[1]);
            }
        }
    }
    return [...exts];
}

// 真实引擎：使用方 node_modules 里的 eslint 包（Linter 类纯内存，不碰磁盘）；模块级缓存。
// 私有方法：仅在本文件实现中使用，不导出。
let f_engineCache = null;
function f_engine() {
    if (!f_engineCache) {
        let Linter;
        try {
            ({ Linter } = f_resolveNpmPackage('eslint'));
        } catch (error) {
            throw new Error(`内存 ESLint 需要宿主安装 eslint 包：${String(error.message).split('\n')[0]}`);
        }
        if (typeof Linter !== 'function') throw new Error('宿主 eslint 包异常：缺少 Linter 类');
        f_engineCache = { Linter };
    }
    return f_engineCache;
}

// ---------- 文件发现 ----------

// 目录递归：跳过点开头与 node_modules，按扩展名过滤（exts 形如 ['js','jsx']）。
// 私有方法：仅在本文件实现中使用，不导出。
function f_walkDirectory(dir, exts, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) f_walkDirectory(full, exts, files);
        else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(`.${ext}`))) files.push(full);
    }
}

// 目标收集：显式文件不受扩展名限制；目录递归；返回按路径排序的文件清单。失败抛错。
// 私有方法：仅在本文件实现中使用，不导出。
function f_collectTargets(targets, cwd, exts) {
    const files = [];
    for (const target of targets) {
        if (/[*?[\]]/.test(target)) throw new Error(`内存 ESLint 不支持路径通配符：${target}`);
        const full = path.resolve(String(cwd), target);
        let stat = null;
        try { stat = fs.statSync(full); } catch { /* 不存在走下方报错 */ }
        if (!stat) throw new Error(`No files matching the pattern '${target}' were found.`);
        if (stat.isDirectory()) f_walkDirectory(full, exts, files);
        else files.push(full);
    }
    return files.sort();
}

// ---------- 检查执行 ----------

// 单文件检查：先以空文本探测 config 匹配（未匹配/被全局 ignores 排除的文件在读取之前即
// 静默跳过返回 null——被忽略文件零 readFileSync，对齐真实 CLI「应用忽略规则后才读文件」的
// 顺序）；匹配的文件再从内存卷读真文本交给真实引擎；其余消息按 (line, column) 排序并归一
// 为本模块的字段子集。
// 私有方法：仅在本文件实现中使用，不导出。
function f_lintFile(linter, configs, file) {
    // 私有方法：config 未匹配的判据——verify 只回 no-config warning（丢弃空文本可能产生的
    // 诊断，仅用于路径匹配判定）。
    const f_unmatched = (messages) => messages.length > 0
        && messages.every((message) => message.ruleId === null && /No matching configuration/.test(String(message.message || '')));
    if (f_unmatched(linter.verify('', configs, { filename: file }))) return null;
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`无法读取被检文件 ${file}：${error.message}`);
    }
    const raw = linter.verify(text, configs, { filename: file });
    if (f_unmatched(raw)) {
        return null;
    }
    return raw
        .map((message) => ({
            ruleId: message.ruleId,
            severity: message.severity,
            line: message.line,
            column: message.column,
            message: message.message,
            fatal: Boolean(message.fatal),
            fix: message.fix !== undefined,
        }))
        .sort((a, b) => a.line - b.line || a.column - b.column);
}

// ---------- 输出格式 ----------

// stylish：仅列出有问题的文件，位置/严重级别/消息列宽跨文件全局对齐，末尾汇总；与真实排版近似。
// 私有方法：仅在本文件实现中使用，不导出。
function f_formatStylish(results) {
    const withMessages = results.filter((result) => result.messages.length > 0);
    if (!withMessages.length) return '';
    const all = withMessages.flatMap((result) => result.messages);
    const posWidth = Math.max(...all.map((m) => `${m.line}:${m.column}`.length));
    const sevWidth = Math.max(...all.map((m) => (m.severity === 2 ? 'error' : 'warning').length));
    const msgWidth = Math.max(...all.map((m) => m.message.length));
    const lines = [];
    for (const result of withMessages) {
        lines.push(result.filePath);
        for (const message of result.messages) {
            const pos = `${message.line}:${message.column}`.padEnd(posWidth);
            const sev = (message.severity === 2 ? 'error' : 'warning').padEnd(sevWidth);
            const text = message.message.padEnd(msgWidth);
            lines.push(`  ${pos}  ${sev}  ${text}  ${message.ruleId}`);
        }
    }
    const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
    const warningCount = results.reduce((n, r) => n + r.warningCount, 0);
    const total = errorCount + warningCount;
    lines.push('', `✖ ${total} ${total === 1 ? 'problem' : 'problems'} (${errorCount} ${errorCount === 1 ? 'error' : 'errors'}, ${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'})`);
    return `${lines.join('\n')}\n`;
}

// json：results 数组整体序列化（含无问题文件，messages 为空数组）；字段为真实 formatter 的子集。
// 私有方法：仅在本文件实现中使用，不导出。
const f_formatJson = (results) => `${JSON.stringify(results, null, 2)}\n`;

// ---------- 回包辅助 ----------

// 私有方法：仅在本文件实现中使用，不导出。
const f_fatal = (message) => ({ status: 2, stdout: '', stderr: `${message}\n` });

// ---------- 分派 ----------

// eslint [options] <文件|目录>…：选项与目标可交错，文件面在 lite-fs 当前作用域完成，
// 规则执行委托真实引擎。失败抛错统一包为 fatal 回包。
// 私有方法：仅在本文件实现中使用，不导出。
async function f_runEslint(argv, options, ctx, stopped) {
    const cwd = options?.cwd || ctx.cwd();
    let format = 'stylish';
    let extArg = null;
    let maxWarnings = null;
    let configArg = null;
    const targets = [];
    try {
        // CLI 选项与目标可交错：--config、--format <stylish|json>、--ext <列表>、--max-warnings <n>；其余选项明确报错
        for (let i = 0; i < argv.length; i++) {
            const arg = String(argv[i]);
            if (!arg.startsWith('-')) { targets.push(arg); continue; }
            if (arg !== '--config' && arg !== '--format' && arg !== '--ext' && arg !== '--max-warnings') {
                return f_fatal(`内存 ESLint 不支持选项：${arg}`);
            }
            if (i + 1 >= argv.length) return f_fatal(`内存 ESLint 选项缺少值：${arg}`);
            const value = String(argv[++i]);
            if (arg === '--config') {
                configArg = value;
            } else if (arg === '--format') {
                if (value !== 'stylish' && value !== 'json') return f_fatal(`内存 ESLint 不支持输出格式：${value}`);
                format = value;
            } else if (arg === '--ext') {
                extArg = value;
            } else {
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed < 0) return f_fatal(`--max-warnings 须为 ≥0 整数：${value}`);
                maxWarnings = parsed;
            }
        }
        if (!targets.length) return f_fatal('内存 ESLint 需要至少一个目标文件或目录');
        const { Linter } = f_engine();
        // flat config：--config 显式指定（相对 cwd），否则从 cwd 向上查找
        const configPath = configArg
            ? (path.isAbsolute(configArg) ? configArg : path.resolve(String(cwd), configArg))
            : f_findFlatConfig(cwd);
        if (!configPath) {
            return f_fatal(`ESLint couldn't find an eslint.config.mjs file to use (searched from ${cwd} upward).`);
        }
        const configs = await f_normalizeConfig(configPath);
        if (stopped()) return f_fatal('ESLint 命令已取消');
        // --ext 与 config 推导的候选扩展名取并集（而非替换）——config 覆盖的文件不因 --ext 漏查
        const exts = f_configExts(configs);
        if (extArg) {
            for (const ext of extArg.split(',').map((item) => item.trim().replace(/^\./, '')).filter(Boolean)) {
                if (!exts.includes(ext)) exts.push(ext);
            }
        }
        const linter = new Linter({ configType: 'flat', cwd: String(cwd) });
        const files = f_collectTargets(targets, cwd, exts);
        const results = [];
        let errorCount = 0;
        let warningCount = 0;
        for (const file of files) {
            const messages = f_lintFile(linter, configs, file);
            if (messages === null) continue; // 未匹配配置/被全局 ignores 排除的文件静默跳过
            const fileErrors = messages.filter((m) => m.severity === 2).length;
            const fileWarnings = messages.length - fileErrors;
            errorCount += fileErrors;
            warningCount += fileWarnings;
            results.push({
                filePath: file,
                messages,
                errorCount: fileErrors,
                warningCount: fileWarnings,
                fatalErrorCount: messages.filter((m) => m.fatal).length,
                fixableErrorCount: messages.filter((m) => m.severity === 2 && m.fix).length,
                fixableWarningCount: messages.filter((m) => m.severity === 1 && m.fix).length,
            });
        }
        let status = errorCount > 0 ? 1 : 0;
        if (maxWarnings !== null && warningCount > maxWarnings) status = 1;
        const stdout = format === 'json' ? f_formatJson(results) : f_formatStylish(results);
        return { status, stdout, stderr: '' };
    } catch (error) {
        return f_fatal(String(error && error.message ? error.message : error));
    }
}

// 测试专用：显式安装异步 ESLint 命令；重复安装保留已有故障及观察配置。
export function t_install() {
    if (mgr.command('/mock-cmd/usr/bin/eslint')) return;
    mgr.pkg_defineCommand('/mock-cmd/usr/bin/eslint', {
        // 内部：Node 原生 import 异步加载配置，所有诊断仍由真实 Linter 计算。
        pkg_run(argv, ctx, child) {
            let stopped = false, pending;
            const dispose = () => { stopped = true; };
            child.once('exit', dispose);
            ctx.onDispose?.(dispose);
            const runBuiltin = () => pending ??= f_runEslint(argv, ctx.options, ctx, () => stopped);
            const run = async () => {
                const hook = mgr.command('/mock-cmd/usr/bin/eslint').pkg_script;
                const custom = hook ? await hook({ argv: [...argv], options: { ...ctx.options } }, runBuiltin) : undefined;
                return custom === undefined ? runBuiltin() : { status: 0, stdout: '', stderr: '', ...custom };
            };
            const finish = result => {
                if (stopped) return;
                if (result.stdout) child.stdout.write(result.stdout);
                if (result.stderr) child.stderr.write(result.stderr);
                child.emit('exit', result.status, null);
                child.emit('close', result.status, null);
            };
            run().then(finish, error => finish(f_fatal(error.message || String(error))));
        },
        // 内部：同步入口明确拒绝异步 ESM 加载，不改写源码、不启动真实子进程。
        pkg_runSync() {
            return f_fatal('lite-cmd-eslint：原生 ESM 配置加载为异步，请使用 spawn/execFile，spawnSync 不支持');
        },
    });
}
