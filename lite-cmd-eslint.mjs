// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-eslint：导入不注册命令；测试须显式调用 t_install() 安装 /mock-cmd/usr/bin/eslint。
// 命令均由 lite-child_process.spawn/spawnSync 派遣，调用账本与清理统一归该模块；
// mgr.command('eslint').t_onRun 只负责配置脚本钩子，t_inject 提供命令级通用故障。
// 异步执行由子进程门面复用同步命令实现（本模块只实现 pkg_runSync）；与 lite-cmd-git 同属
// 显式安装的命令集，两者互不依赖；本命令没有子命令，也不提供检查点注入。
// 规则执行委托使用方 node_modules 里的真实 eslint 包的 Linter 类（纯内存引擎核心；不 import
// 其磁盘文件面 ESLint 类）——espree AST 解析、esquery visitor、files/ignores/languageOptions、
// 插件与规则校验、内联 disable 指令全部原生处理；宿主未安装 eslint 时明确报错。
// 与 lite-fs 的三个对接缝（文件面整层由 lite-fs 接管，全程不落真实磁盘）：
//   ① 被检文件从内存卷遍历读取，文本经 verify(text, configs, { filename }) 进入引擎，
//      filename 只用于配置匹配与消息显示（引擎不做 IO）；
//   ② new Linter({ configType: 'flat', cwd: 执行 cwd })，config 的 files 相对模式按内存路径匹配；
//   ③ 配置/规则模块 import 的 node:fs / fs（裸名）注入 lite-fs 门面（未 mock 时透传真实 fs，
//      mock 后读内存卷）。
// 配置为 ESLint flat config：从执行 cwd 逐级向上查找 eslint.config.mjs（仅 .mjs），或经 --config
// 显式指定。配置与规则/插件模块都取自 lite-fs 当前作用域，内存卷不在真实磁盘上，Node 原生
// import() 无法读取，故以同步迷你加载器执行（近似 ESM）：仅支持文件顶部单行 import 语句
//（default/named/namespace/副作用四种），specifier 支持 node:*、内存卷相对/绝对路径（递归
// 加载、深度上限 16、环检测）与 npm 包（解析基按序：宿主进程入口脚本 → 宿主 cwd → 本库自身，
// 覆盖 node_modules 安装与源码目录直连/file: 软链接两种引用形态——与项目真实 lint 同引擎
// 同包；require(ESM) 需 Node ≥22.12，顶层 await 不支持）；多行 import、from 再导出、解构导出、
// 动态 import() 明确报错；import.meta.url/dirname 注入为卷内路径；模块在宿主进程内同步执行。
// 同一命令执行内按规范化路径缓存卷内模块（同文件多次导入共享同一实例，身份稳定），命令起始
// 清空；export default 捕获与 import.meta 注入基于代码上下文掩码——字符串/模板/正则/注释内的
// 关键字不误伤。
// 卷内模块支持 export default 与单行具名导出（const/let/var 多声明符、function/async
// function/class、export { 别名列表 }），named import 按导出名解析（使用方共享
// lint-rules/lib 模块形态）；多行导出列表未支持。具名导入保留 ESM 动态绑定：导出经 getter
// 闭包捕获模块作用域声明、导入侧转发 getter 并以 with (__imports) 注入正文（按访问时求值），
// 源模块更新导出变量后导入方读到新值；导出存在性按 Object.hasOwn 判定（值为 undefined 的
// 合法导出仍可导入，真正缺失的导出才报错）。with 注入的近似边界（如实声明）：模块顶部
// 'use strict' 指令被剥离（ESM 本就强制 strict，行为不变）；对导入绑定赋值不产生 ESM 的
// TypeError（sloppy 下静默失败）；正文声明与导入同名按 sloppy 遮蔽（ESM 中属非法重复绑定）。
// flat config 的 default export 须为数组；字符串插件值视为内存卷路径（须导出插件对象，同一
// 路径多次引用保持同一身份）；其余 item 键（files/ignores/languageOptions/name/settings…）
// 全部透传真实引擎——插件/规则/选项的形态与 schema 校验（含「带 options 的规则须声明
// meta.schema」）与 files-less item 的隐式 js/mjs/cjs 作用域均按真实引擎口径。规则接口即
// ESLint 规则 API：外置规则经适配层包裹后交给引擎——report 的顶层 line/column 简写按 1 基
// 约定、自动转换为引擎的 0 基 loc（文本类规则兼容），node/loc 形态与 meta（messageId 依赖）
// 原样透传；文本类规则（create 内同步 report）与 AST visitor 规则均可执行。
// CLI 支持 --config、--format stylish|json、--ext、--max-warnings 与目标文件/目录，选项与目标
// 可交错；候选扩展名由 config 推导（无 files 键的 item 贡献 js/mjs/cjs，files 模式提取尾部
// 扩展名——含尾部花括号组的展开，如 **/*.{js,mjs} 同时贡献 js 与 mjs）并入 --ext；目录递归
// 遍历并跳过 node_modules 与点开头目录，显式文件不受扩展名限制；未匹配任何配置（含被全局
// ignores 排除）的文件静默跳过——跳过判定在读取之前（先以空文本探测 config 匹配，被忽略
// 文件零读取）。输出与退出码为近似口径：stylish 为
// 简化对齐排版，json 字段为真实 formatter 的子集，0=干净、1=存在 error 或 warning 超过
// --max-warnings、2=fatal（配置缺失或执行失败、引擎错误、目标不匹配等）；错误统计为真实值
//（fatal 消息与 fixable 计数来自引擎）。未覆盖面：--fix、stdin lint、处理器——触到即明确报错。
// 状态随 lite-fs 卷生命周期保存或丢弃，不在命令模块中另设运行账本。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mgr from './lite-cmd-mgr.mjs';
import fs from './lite-fs.mjs';

// ---------- 配置发现与模块执行 ----------

// 内存卷内的 ESM 文本无法被 Node 原生 import() 读取（卷不在真实磁盘），本模块以 new Function
// 执行改写后的源码近似 ESM：顶部单行 import 重写为注入绑定、export default 捕获、
// import.meta.url/dirname 注入。支持面之外的形态全部明确报错。
// 私有方法：仅在本文件实现中使用，不导出。
const f_MAX_MODULE_DEPTH = 16;

// node:* 内建经 createRequire 装载（解析基与内建解析无关，任一基均可）。
// 私有方法：仅在本文件实现中使用，不导出。
const f_require = createRequire(import.meta.url);

// npm 包解析基（按序尝试）：宿主进程入口脚本 → 宿主进程 cwd → 本库自身位置。使用方可能以
// 源码目录直连或 file: 软链接方式引用本库——Node 按真实路径加载模块，此时从本库自身向上解析
// 只能看到本库的 node_modules，找不到使用方安装的插件包，故解析须向上冒泡到使用方侧。
// 私有方法：仅在本文件实现中使用，不导出。
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

// require(ESM) 返回命名空间对象（Symbol.toStringTag === 'Module'）：default 导入取其 default，
// named/namespace 按属性取，与 ESM 语义一致；CJS 包 default 导入取 module.exports。
// 私有方法：仅在本文件实现中使用，不导出。
const f_isEsmNamespace = (value) => value !== null && typeof value === 'object' && value[Symbol.toStringTag] === 'Module';

// 顶部单行 import 的形态表：specGroup = specifier 捕获组，defaultGroup/namedGroup/nsGroup 同理（-1 表示无）。
// 私有方法：仅在本文件实现中使用，不导出。
const f_IMPORT_PATTERNS = [
    { kind: 'sideEffect', re: /^import\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 1, defaultGroup: -1, namedGroup: -1, nsGroup: -1 },
    { kind: 'defaultNamed', re: /^import\s+(\w+)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 3, defaultGroup: 1, namedGroup: 2, nsGroup: -1 },
    { kind: 'defaultNamespace', re: /^import\s+(\w+)\s*,\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 3, defaultGroup: 1, namedGroup: -1, nsGroup: 2 },
    { kind: 'named', re: /^import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 2, defaultGroup: -1, namedGroup: 1, nsGroup: -1 },
    { kind: 'namespace', re: /^import\s+\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 2, defaultGroup: -1, namedGroup: -1, nsGroup: 1 },
    { kind: 'default', re: /^import\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/, specGroup: 2, defaultGroup: 1, namedGroup: -1, nsGroup: -1 },
];

// 从 cwd 逐级向上查找 eslint.config.mjs；找不到返回 null。
// 私有方法：仅在本文件实现中使用，不导出。
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

// 顶层逗号分段（忽略括号与字符串内的逗号），用于 const/let/var 多声明符具名导出的名字提取。
// 私有方法：仅在本文件实现中使用，不导出。
function f_splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
}

// 逐字符标记源码中处于「代码上下文」的位置：字符串、模板字面量、正则与注释内为 false，
// 模板 ${ 插值内部回到 true。关键字改写只允许命中标记为代码的连续区间——字符串里出现
// 'export default'、'import.meta.url' 是合法内容，不得误伤。
// 私有方法：仅在本文件实现中使用，不导出。
function f_codeMask(source) {
    const n = source.length;
    const mask = new Array(n).fill(true);
    const mark = (from, to) => { for (let k = from; k < to && k < n; k++) mask[k] = false; };
    const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
    // 这些关键字之后出现 / 是正则字面量而非除法
    const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
    // 这些关键字引导的圆括号组是控制结构条件头：其右括号之后紧跟的 / 是正则字面量而非除法
    const CONTROL_HEADS = new Set(['if', 'while', 'for', 'with', 'switch']);
    let mode = 'code';           // code | line | block | string | template
    let quote = '';              // 字符串模式下的引号字符（' 或 "）
    const braces = [];           // 模板插值嵌套栈：每层记录未配对的 '{' 深度
    const parens = [];           // 圆括号栈：每层记录该括号组是否为控制结构条件头
    let prev = '';               // 上一代码上下文非空白字符
    let lastWord = '';           // 上一代码上下文标识符（配合 prev 区分除法与正则）
    let i = 0;
    while (i < n) {
        const ch = source[i];
        if (mode === 'line') {
            if (ch === '\n') { mode = 'code'; i++; continue; }
            mask[i] = false;
            i++;
            continue;
        }
        if (mode === 'block') {
            if (ch === '*' && source[i + 1] === '/') { mask[i] = false; mask[i + 1] = false; i += 2; mode = 'code'; continue; }
            mask[i] = false;
            i++;
            continue;
        }
        if (mode === 'string') {
            mask[i] = false;
            if (ch === '\\') { mask[i + 1] = false; i += 2; continue; }
            if (ch === quote) mode = 'code';
            i++;
            continue;
        }
        if (mode === 'template') {
            mask[i] = false;
            if (ch === '\\') { mask[i + 1] = false; i += 2; continue; }
            if (ch === '`') { mode = 'code'; i++; continue; }
            if (ch === '$' && source[i + 1] === '{') { mask[i + 1] = false; i += 2; braces.push(0); mode = 'code'; continue; }
            i++;
            continue;
        }
        // code
        if (ch === '/' && source[i + 1] === '/') {
            const stop = source.indexOf('\n', i);
            const end = stop === -1 ? n : stop;
            mark(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const close = source.indexOf('*/', i + 2);
            const end = close === -1 ? n : close + 2;
            mark(i, end);
            i = end;
            continue;
        }
        if (ch === '"' || ch === "'") { mode = 'string'; quote = ch; mark(i, i + 1); i++; continue; }
        if (ch === '`') { mode = 'template'; mark(i, i + 1); i++; continue; }
        if (ch === '{') { if (braces.length) braces[braces.length - 1] += 1; i++; prev = ch; lastWord = ''; continue; }
        if (ch === '}') {
            if (braces.length && braces[braces.length - 1] === 0) {
                braces.pop();
                mode = 'template';
                mask[i] = false;
                i++;
                prev = '`';
                lastWord = '';
                continue;
            }
            if (braces.length) braces[braces.length - 1] -= 1;
            i++;
            prev = ch;
            lastWord = '';
            continue;
        }
        if (ch === '(') {
            parens.push(CONTROL_HEADS.has(lastWord));
            i++;
            prev = ch;
            lastWord = '';
            continue;
        }
        if (ch === ')') {
            const controlHead = parens.pop();
            if (controlHead) {
                // 控制条件头的右括号之后回到「正则允许」位置（如 if (x) /re/.test(y)）
                prev = '';
                lastWord = '';
            } else {
                prev = ch;
                lastWord = '';
            }
            i++;
            continue;
        }
        const regexPosition = !(isWord(prev) && !REGEX_KEYWORDS.has(lastWord)) && prev !== ')' && prev !== ']' && prev !== '}';
        if (ch === '/' && regexPosition) {
            // 正则字面量（含字符类与转义；未闭合按除法回退）
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < n) {
                const c = source[j];
                if (c === '\\') { j += 2; continue; }
                if (c === '\n') break;
                if (c === '[') inClass = true;
                else if (c === ']') inClass = false;
                else if (c === '/' && !inClass) { closed = true; break; }
                j++;
            }
            if (closed) {
                let end = j + 1;
                while (end < n && isWord(source[end])) end++;
                mark(i, end);
                i = end;
                prev = '/';
                lastWord = '';
                continue;
            }
        }
        if (!/\s/.test(ch)) {
            prev = ch;
            lastWord = isWord(ch) ? lastWord + ch : '';
        }
        i++;
    }
    return mask;
}

// 在代码上下文（掩码为真）中查找正则首个完整命中，返回 [start, end]；未命中返回 null。
// 正则须带 g 标志（非代码命中需继续推进 lastIndex；非全局正则 exec 永远返回首个命中会死循环）。
// 私有方法：仅在本文件实现中使用，不导出。
function f_firstCodeMatch(source, mask, regex) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(source)) !== null) {
        let inCode = true;
        for (let k = m.index; k < m.index + m[0].length; k++) {
            if (!mask[k]) { inCode = false; break; }
        }
        if (inCode) return [m.index, m.index + m[0].length];
        if (!regex.global) return null;
    }
    return null;
}

// 替换全部代码上下文命中（掩码外的字符串内容原样保留）。
// 私有方法：仅在本文件实现中使用，不导出。
function f_replaceCode(source, mask, regex, replacement) {
    regex.lastIndex = 0;
    const ranges = [];
    let m;
    while ((m = regex.exec(source)) !== null) {
        let inCode = true;
        for (let k = m.index; k < m.index + m[0].length; k++) {
            if (!mask[k]) { inCode = false; break; }
        }
        if (inCode) ranges.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) regex.lastIndex += 1;
    }
    if (!ranges.length) return source;
    let out = '';
    let pos = 0;
    for (const [start, end] of ranges) {
        out += source.slice(pos, start) + replacement;
        pos = end;
    }
    return out + source.slice(pos);
}

// specifier 解析：node:fs 与 fs（裸名）注入 lite-fs 门面（对接缝③）；node:* 其余经
// createRequire；内存卷路径递归执行返回 { default, named } 命名空间；npm 包按解析基序从使用方侧装载。
// 私有方法：仅在本文件实现中使用，不导出。
function f_resolveImport(spec, fromPath, depth, loading) {
    if (spec === 'node:fs' || spec === 'fs') return { builtin: true, value: fs };
    if (spec.startsWith('node:')) return { builtin: true, value: f_require(spec) };
    if (/^(?:\.\/|\.\.\/|\/)/.test(spec)) {
        const target = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(fromPath), spec);
        const mod = f_executeModule(target, depth + 1, loading);
        // 转发对象：不 spread 拷贝（值快照会断开动态绑定），按属性描述符转发 getter——
        // default 与具名导出都在访问时回到被导入模块求值
        const forwarded = {};
        Object.defineProperty(forwarded, 'default', { get: () => mod.default, enumerable: true });
        for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mod.named))) {
            Object.defineProperty(forwarded, name,
                descriptor.get ? { get: descriptor.get, enumerable: true } : { get: () => mod.named[name], enumerable: true });
        }
        return { builtin: false, value: forwarded };
    }
    return { builtin: true, value: f_resolveNpmPackage(spec, fromPath) };
}

// 卷内模块缓存：按规范化路径存放 { default, named }。同一命令执行内多次导入同一文件共享
// 同一模块实例（模块身份稳定——真实 ESM 语义，同文件重定义插件不误报 Cannot redefine）；
// 每次命令执行起始清空，卷复位不会泄漏陈旧模块。
// 私有方法：仅在本文件实现中使用，不导出。
const f_moduleCache = new Map();

// 同步迷你加载器：返回 { default, named }；执行面与支持限制定义见文件头注释。
// 私有方法：仅在本文件实现中使用，不导出。
function f_executeModule(volumePath, depth = 0, loading = new Set()) {
    const resolvedPath = path.resolve(String(volumePath));
    const cached = f_moduleCache.get(resolvedPath);
    if (cached) return cached;
    if (depth > f_MAX_MODULE_DEPTH) throw new Error(`import 层级超过上限 ${f_MAX_MODULE_DEPTH}：${resolvedPath}`);
    if (loading.has(resolvedPath)) throw new Error(`循环 import：${resolvedPath}`);
    loading.add(resolvedPath);
    let source;
    try {
        source = fs.readFileSync(resolvedPath, 'utf8');
    } catch (error) {
        throw new Error(`无法读取模块 ${resolvedPath}：${error.message}`);
    }
    const lines = source.split('\n');
    // 导入命名空间：绑定名 → 惰性 getter（按访问时求值）。正文包 with (__imports) 执行——
    // 具名导入转发被导入模块导出变量的 getter，保留 ESM 动态绑定语义（导入后源模块更新，
    // 导入方读到新值）；default/namespace 同为惰性属性（builtin 值静态、卷内模块转发 getter）。
    const imports = {};
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_defineImport = (local, get) => { Object.defineProperty(imports, local, { get, enumerable: true }); };
    let i = 0;
    // 顶部 import：跳过空行与注释行；import 之后的首个非 import 行开始正文（仅支持顶部 import）
    for (; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
        if (!line.startsWith('import')) break;
        const pattern = f_IMPORT_PATTERNS.find(({ re }) => re.test(line));
        if (!pattern) throw new Error(`仅支持文件顶部单行 import 语句：${resolvedPath}:${i + 1}`);
        const m = pattern.re.exec(line);
        const spec = m[pattern.specGroup];
        const { builtin, value } = f_resolveImport(spec, resolvedPath, depth, loading);
        if (pattern.defaultGroup >= 0) {
            f_defineImport(m[pattern.defaultGroup], () => builtin ? (f_isEsmNamespace(value) ? value.default : value) : value.default);
        }
        if (pattern.nsGroup >= 0) f_defineImport(m[pattern.nsGroup], () => value);
        if (pattern.namedGroup >= 0) {
            for (const entry of m[pattern.namedGroup].split(',')) {
                const item = entry.trim();
                if (!item) continue;
                const pair = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(item);
                if (!pair) throw new Error(`无法解析 named import 绑定 '${item}'：${resolvedPath}:${i + 1}`);
                const name = pair[1];
                // 存在性与值分开判定：值为 undefined 的合法导出仍可导入（hasOwn 不触发 getter、
                // 不受原型链污染）；真正缺失的导出才报错
                if (!Object.hasOwn(value, name)) {
                    throw new Error(`'${spec}' 未导出 ${name}：${resolvedPath}:${i + 1}`);
                }
                f_defineImport(pair[2] ?? name, () => value[name]);
            }
        }
        lines[i] = ''; // import 语句已消费，从正文移除
    }
    // 顶部 'use strict' 指令剥离：ESM 语义本就强制 strict（剥离不改行为），正文以 sloppy 形态
    // 包入 with (__imports)（with 需非严格模式；行中指令位置之后的 'use strict' 只是普通
    // 表达式语句，无指令效果，无需处理）
    if (i < lines.length && /^\s*(['"])use strict\1\s*;?\s*$/.test(lines[i])) lines[i] = '';
    // 顶部导出收集：export default 之外，支持单行具名导出（const/let/var/function/async
    // function/class 与 export { 别名列表 }）；解构导出、多行导出列表、from 再导出明确报错
    const namedExports = new Map(); // 导出名 → 源标识符
    for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        if (!/^\s*export\b/.test(line)) continue;
        if (/^\s*export\s+default\b/.test(line)) continue; // default 由后续整体替换捕获
        const listMatch = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/.exec(line);
        if (listMatch) {
            for (const entry of listMatch[1].split(',')) {
                const item = entry.trim();
                if (!item) continue;
                const pair = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(item);
                if (!pair) throw new Error(`无法解析导出列表项 '${item}'：${resolvedPath}:${j + 1}`);
                namedExports.set(pair[2] ?? pair[1], pair[1]);
            }
            lines[j] = ''; // 导出列表语句移除（源绑定保留在正文）
            continue;
        }
        if (/^\s*export\s*\{/.test(line)) {
            throw new Error(`仅支持单行 export { ... } 导出列表（多行列表与 from 再导出未支持）：${resolvedPath}:${j + 1}`);
        }
        const stripped = line.replace(/^\s*export\s+/, '');
        if (/^(?:const|let|var)\s+\{/.test(stripped) || /^(?:const|let|var)\s+\[/.test(stripped)) {
            throw new Error(`仅支持简单标识符的具名导出（解构导出未支持）：${resolvedPath}:${j + 1}`);
        }
        lines[j] = stripped;
        const kindMatch = /^(const|let|var)\s+/.exec(stripped);
        if (kindMatch) {
            for (const part of f_splitTopLevel(stripped.slice(kindMatch[0].length))) {
                const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
                if (!nameMatch) throw new Error(`无法解析具名导出声明 '${part.trim()}'：${resolvedPath}:${j + 1}`);
                namedExports.set(nameMatch[1], nameMatch[1]);
            }
            continue;
        }
        const fnMatch = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(stripped);
        if (fnMatch) { namedExports.set(fnMatch[1], fnMatch[1]); continue; }
        const classMatch = /^class\s+([A-Za-z_$][\w$]*)/.exec(stripped);
        if (classMatch) { namedExports.set(classMatch[1], classMatch[1]); continue; }
        throw new Error(`无法识别的具名导出形态：${resolvedPath}:${j + 1}`);
    }
    const body = lines.join('\n');
    // 关键字改写基于代码上下文掩码：字符串/模板/正则/注释内的 export default 与 import.meta
    // 是合法内容，不误伤（首个代码命中才替换为捕获语句）
    let code = body;
    let mask = f_codeMask(code);
    const defaultHit = f_firstCodeMatch(code, mask, /\bexport\s+default\b/g);
    if (defaultHit) code = code.slice(0, defaultHit[0]) + 'const __exportDefault =' + code.slice(defaultHit[1]);
    mask = f_codeMask(code);
    code = f_replaceCode(code, mask, /import\.meta\.url/g, '__importMetaUrl');
    mask = f_codeMask(code);
    code = f_replaceCode(code, mask, /import\.meta\.dirname/g, '__importMetaDirname');
    mask = f_codeMask(code);
    if (f_firstCodeMatch(code, mask, /\bimport\.meta\b/g)) throw new Error(`import.meta 仅支持 url / dirname 成员：${resolvedPath}`);
    // 具名导出为 getter：闭包捕获模块作用域声明（const/let/var/function/class 全覆盖），
    // 导入方经转发链读到当前值——导出变量的动态绑定
    const namedPairs = [...namedExports].map(([alias, source]) => `get ${alias}() { return ${source}; }`).join(', ');
    let fn;
    try {
        fn = new Function('__importMetaUrl', '__importMetaDirname', '__imports',
            `with (__imports) {\n${code}\n;return { __exportDefault: typeof __exportDefault !== 'undefined' ? __exportDefault : undefined, __namedExports: { ${namedPairs} } };\n}`);
        const result = fn(`file://${resolvedPath}`, path.dirname(resolvedPath), imports);
        const module = { default: result.__exportDefault, named: result.__namedExports };
        f_moduleCache.set(resolvedPath, module);
        return module;
    } catch (error) {
        throw new Error(`模块 ${resolvedPath} 执行失败：${error.message}`);
    } finally {
        loading.delete(resolvedPath);
    }
}

// ---------- 配置标准化与规则适配 ----------

// 外置规则适配层：把引擎真实 RuleContext 包一层——report 的顶层 line/column 简写自动转为
// loc（文本类规则兼容），node/loc 形态与 meta（messageId 依赖）原样透传；非法形态交给真实
// 引擎以真实错误报出。
// 私有方法：仅在本文件实现中使用，不导出。
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

// 配置标准化：执行配置模块 → default export 数组 → 字符串插件值按卷路径装载（同一路径多次
// 引用保持同一身份）→ 外置规则统一包裹（同一插件对象保持同一身份——真实引擎按对象身份去重
// 重定义）→ 返回交给 Linter 的数组。其余键与形态全部透传真实引擎。失败抛错，由 f_runEslint
// 统一包为 fatal 回包。
// 私有方法：仅在本文件实现中使用，不导出。
function f_normalizeConfig(configPath) {
    const config = f_executeModule(configPath).default;
    if (!Array.isArray(config)) throw new Error(`ESLint 配置须导出数组：${configPath}`);
    const stringPlugins = new Map();  // 卷路径 → 装载的插件对象
    const wrappedPlugins = new Map(); // 原插件对象 → 包裹后插件
    const wrapPlugin = (plugin) => {
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
    return config.map((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
        if (item.plugins === undefined || typeof item.plugins !== 'object' || Array.isArray(item.plugins)) return item;
        const plugins = {};
        for (const [name, value] of Object.entries(item.plugins)) {
            if (typeof value === 'string') {
                let loaded = stringPlugins.get(value);
                if (!loaded) {
                    const pluginPath = path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
                    loaded = f_executeModule(pluginPath).default;
                    stringPlugins.set(value, loaded);
                }
                plugins[name] = wrapPlugin(loaded);
            } else {
                plugins[name] = wrapPlugin(value);
            }
        }
        return { ...item, plugins };
    });
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
function f_runEslint(argv, options, ctx) {
    const cwd = options?.cwd || ctx.cwd();
    let format = 'stylish';
    let extArg = null;
    let maxWarnings = null;
    let configArg = null;
    const targets = [];
    try {
        f_moduleCache.clear(); // 模块缓存以单次命令执行为界，卷复位后不泄漏陈旧模块
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
        const configs = f_normalizeConfig(configPath);
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

// 测试专用方法：显式安装 ESLint 命令；重复调用保留已有钩子与故障配置。
export function t_install() {
    if (mgr.command('/mock-cmd/usr/bin/eslint')) return;
    mgr.pkg_defineCommand('/mock-cmd/usr/bin/eslint', {
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        pkg_runSync(argv, ctx) {
            return f_runEslint(argv, ctx.options, ctx);
        },
    });
}
