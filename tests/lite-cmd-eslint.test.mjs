// lite-cmd-eslint 门面用例（node:test 形态，可 `node --test` 或直跑）：eslint 命令集——调用 t_install 后向
// lite-cmd-mgr 登记（/mock-cmd/usr/bin/eslint）；执行入口经 lite-child_process.spawnSync('eslint',
// argv, options) 分派到达：调用统一记在 liteChildProcess.t_calls()，回包经 onRun 钩子注入
//（mgr.command('eslint').t_onRun 安装；返回 { status, stdout, stderr } 浅合并覆盖默认）、钩子返回
// undefined 视为未命中——回落内置真实引擎委托（未装钩子同口径）。运行账本与清理统一归
// lite-child_process。规则执行委托宿主 node_modules 的真实 eslint 包（Linter 类纯内存）：files/
// ignores/languageOptions、espree AST、esquery visitor、插件校验、内联 disable 指令全部真实；
// 文件面归 lite-fs（被检文件与 eslint.config.mjs 从内存卷读取，cwd 对齐使 files 模式按内存路径
// 匹配，配置/规则模块 import 的 node:fs 注入 lite-fs 门面）。配置与外置规则模块经同步迷你加载器
// 在宿主内执行（仅顶部单行 import：node:*/内存卷路径/npm 包；多行 import、named export 明确报错；
// import.meta.url/dirname 注入为卷内路径）。夹具（lint-rules/no-trailing-spaces.mjs 文本规则 +
// 使用方项目同构配置）由用例写入内存卷验证全链路；--format stylish|json、--max-warnings 与 0/1/2
// 退出码为近似口径，错误统计（fatal/fixable）为真实值。
// 前置：宿主须安装 eslint（仓库 devDependency）；引擎事实面（退出码 0/1/2、JSON 交集字段、
// stylish 计数行、向上查找配置）由「真实 ESLint 对照」用例经宿主真实 eslint CLI 逐值核对
//（eslint.org 文档：https://eslint.org/docs/latest/use/command-line-interface#exit-codes），
// 输出排版（stylish 对齐、JSON 超集字段、fatal 消息措辞）仍为近似口径。
// 第三方 npm 插件只验证加载、配置与规则接线，不要求接管其内部原生 I/O；自研插件的业务
// 逻辑通过显式 lite 组件测试。加载器已声明的 fs 注入兼容行为另由对应门面用例验证。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { nativeReferenceEnv } from './native-reference-env.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import { t_install } from '../lite-cmd-eslint.mjs';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';

// 逐用例装配：mock 内存卷 + spawn 边界（eslint 执行唯一入口——执行寻址须卷内 /mock-cmd
// 系统卷）；t_install 在卷建立后调用——/mock-cmd 系统卷已持久存在时即刻补命令文件，
// 不依赖「卷内无 /mock-cmd 才触发」的惰性安装时序。收尾卸载子进程运行态并摘除钩子。
// 卷排除本仓库根（真实文件不落卷）
const REAL_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
// 临时夹具目录由环境变量提供，未设置时使用平台默认位置，不依赖 node:os。
const TEMP_ROOT = path.resolve(process.env.TMPDIR || process.env.TEMP || process.env.TMP
  || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp') : '/tmp'));
function setup() {
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  t_install();
  liteChildProcess.t_mock();
  mgr.command('eslint').t_onRun(null);
  return () => {
    mgr.command('eslint').t_onRun(null);
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  };
}

// ESLint 执行器：复用内存卷并固定 cwd，每次调用均经 liteChildProcess.spawnSync 执行；
// 卷随用例丢弃（setup 收尾统一 unmock），跨用例文件自然消失
function volumeEslint(cwd) {
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync(cwd, { recursive: true });
  return (argv) => liteChildProcess.spawnSync('eslint', argv, { cwd, encoding: 'utf8' });
}

const write = (root, rel, text) => {
  liteFs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  liteFs.writeFileSync(path.join(root, ...rel.split('/')), text);
};

// ---------- 外置规则与配置夹具 ----------

// 外置规则夹具：no-trailing-spaces（文本子集形态——report 顶层 line/column 简写，经适配层转 loc）
const RULE_SOURCE = `// 外置规则：no-trailing-spaces（lite-cmd-eslint 不内置规则，经 flat config 插件装配）
export default {
    meta: {
        type: 'layout',
        schema: [{ type: 'object', properties: { skipBlankLines: { type: 'boolean' } }, additionalProperties: false }],
    },
    create(context) {
        const skipBlankLines = context.options[0]?.skipBlankLines === true;
        context.sourceCode.lines.forEach((line, index) => {
            const match = /[ \\t]+$/.exec(line);
            if (!match) return;
            if (skipBlankLines && line.trim() === '') return;
            context.report({ line: index + 1, column: match.index + 1, message: 'Trailing whitespace not allowed.' });
        });
        return {};
    },
};
`;

// 使用方项目同构配置夹具：node:* default/named import + 内存卷相对 import + import.meta.url 推导根路径
// + 对象插件装配 + export default 标识符
const fixtureConfigSource = (rules) => `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import noTrailingSpaces from './lint-rules/no-trailing-spaces.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

const appPlugins = {
    app: {
        rules: {
            'no-trailing-spaces': noTrailingSpaces,
        },
    },
};

const config = [
    {
        plugins: appPlugins,
        rules: ${JSON.stringify(rules)},
    },
];

export default config;
`;

// AST visitor 形态夹具：真实 espree AST + report({ node })
const AST_RULE_SOURCE = `// 外置 AST 规则：禁止调用 bad()（真实 visitor 形态，report 携带 node）
export default {
    meta: { schema: [] },
    create(context) {
        return {
            CallExpression(node) {
                if (node.callee.type === 'Identifier' && node.callee.name === 'bad') {
                    context.report({ node, message: '禁止调用 bad()' });
                }
            },
        };
    },
};
`;

// node:fs 注入夹具：规则模块 import 的 node:fs 是 lite-fs 门面（mock 后读内存卷）
const FS_RULE_SOURCE = `// 外置规则：node:fs 经 lite-fs 门面（mock 后读内存卷）
import fs from 'node:fs';

export default {
    create(context) {
        const exists = fs.existsSync(context.filename);
        const head = fs.readFileSync(context.filename, 'utf8').slice(0, 3);
        context.report({ line: 1, column: 1, message: 'exists=' + String(exists) + ';head=' + head });
        return {};
    },
};
`;

const writeRule = (root) => write(root, 'lint-rules/no-trailing-spaces.mjs', RULE_SOURCE);
const writeFixtureConfig = (root, rules) => write(root, 'eslint.config.mjs', fixtureConfigSource(rules));

/** 场景：未 t_install 时仅导入模块不会登记命令，spawn/spawnSync 均按真实 Node 语义返回 ENOENT。 */
test('未 t_install 时执行返回 ENOENT', async () => {
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    // 输入：不调用 t_install，直接 spawnSync('eslint', ['.'])
    const synced = liteChildProcess.spawnSync('eslint', ['.'], { cwd: '/mock/project', encoding: 'utf8' });
    // 预期 1：同步执行启动失败且错误码为 ENOENT
    assert.equal(synced.status, null, '未登记的 eslint 应启动失败');
    assert.equal(synced.error?.code, 'ENOENT', '应按真实 Node 语义返回 ENOENT');
    // 输入：异步 spawn('eslint', ['.'])
    const child = liteChildProcess.spawn('eslint', ['.'], { cwd: '/mock/project' });
    const error = await new Promise((resolve) => child.once('error', resolve));
    await liteChildProcess.waitForClose(child);
    // 预期 2：异步执行同样以 ENOENT 错误事件失败
    assert.equal(error?.code, 'ENOENT', '异步 spawn 也应以 ENOENT 错误事件失败');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：重复显式安装不覆盖既有脚本钩子和一次性故障，后续 ESLint 仍执行内置实现。 */
test('重复 t_install 保留钩子与故障配置', () => {
  const done = setup();
  let remove;
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'eslint.config.mjs', 'export default [];\n');
    write('/mock/project', 'src.js', 'const a = 1;\n');
    // 预期 1：安装后可执行内置实现（空配置无规则 → 干净）
    assert.equal(eslint(['src.js']).status, 0, '安装后应能执行内置实现');
    let hookCalls = 0;
    mgr.command('eslint').t_onRun(() => { hookCalls++; });
    remove = mgr.command('eslint').t_inject({ exit: 73, stderr: 'installed-fault', once: true });
    t_install();
    t_install();
    // 预期 2：重复安装保留已有故障
    const failed = eslint(['src.js']);
    assert.equal(failed.status, 73, '重复安装应保留已有故障');
    assert.equal(failed.stderr, 'installed-fault', '故障内容应保持不变');
    // 预期 3：一次性故障消费后回到内置实现，钩子仍保留
    const recovered = eslint(['src.js']);
    assert.equal(recovered.status, 0, '一次性故障消费后应回到内置引擎');
    assert.equal(recovered.stdout, '', '无规则且文件干净应无 stylish 输出');
    assert.equal(hookCalls, 1, '重复安装应保留原钩子，故障请求不执行钩子');
  } finally {
    remove?.();
    done();
  }
});

/** 场景：cwd 及其上级都没有 eslint.config.mjs 时按 fatal（exit 2）返回。 */
test('配置缺失按 fatal 返回', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'src.js', 'const a = 1;\n');
    // 输入：卷内无任何 eslint.config.mjs
    const result = eslint(['src.js']);
    // 预期 1：fatal 退出码 2，stderr 提示找不到配置
    assert.equal(result.status, 2, '缺配置应为 fatal 退出码');
    assert.equal(result.stdout, '', '缺配置不应有 lint 输出');
    assert.match(result.stderr, /couldn't find an eslint\.config\.mjs/, '应提示找不到 flat config');
    assert.ok(result.stderr.endsWith('\n'), 'stderr 应以换行结尾');
  } finally {
    done();
  }
});

/** 场景：夹具全链路——使用方项目同构配置（node:* import + 卷内规则 import + import.meta.url + 对象插件
 * 装配 + export default 标识符）驱动外置文本规则命中，报告列位、规则 ID 与退出码正确。 */
test('夹具全链路：flat config 驱动外置规则命中', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    write('/mock/project', 'a.js', 'const a = 1;  \nlet b;\n   \n');
    // 输入：行 1 有行尾空白，行 3 为纯空白行
    const result = eslint(['a.js']);
    // 预期 1：外置规则真实执行，两处均报告
    assert.equal(result.status, 1, '存在行尾空白应退出 1');
    assert.ok(result.stdout.includes('/mock/project/a.js'), '应输出文件路径');
    assert.ok(result.stdout.includes('1:13'), '应报告首个行尾空白列位');
    assert.ok(result.stdout.includes('3:1'), '纯空白行默认也应报告');
    assert.ok(result.stdout.includes('Trailing whitespace not allowed.'), '应使用规则消息');
    assert.ok(result.stdout.includes('app/no-trailing-spaces'), '应报告插件前缀规则 ID');
    assert.ok(result.stdout.includes('✖ 2 problems (2 errors, 0 warnings)'), '汇总应含两处错误');
  } finally {
    done();
  }
});

/** 场景：规则选项经 [severity, options] 元组传入 context.options（skipBlankLines 跳过纯空白行）。 */
test('夹具规则选项经 context.options 生效', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': ['error', { skipBlankLines: true }] });
    write('/mock/project', 'a.js', 'const a = 1;  \nlet b;\n   \n');
    // 输入：skipBlankLines 选项
    const result = eslint(['a.js']);
    // 预期 1：纯空白行被跳过，行 1 仍报告
    assert.equal(result.status, 1, '行 1 的行尾空白仍应报告');
    assert.ok(result.stdout.includes('1:13'), '应报告行 1 列位');
    assert.ok(!result.stdout.includes('3:1'), 'skipBlankLines 应跳过纯空白行');
  } finally {
    done();
  }
});

/** 场景：import.meta.url/dirname 注入为卷内路径，context.options 透传配置元组选项。 */
test('import.meta 注入与 options 透传', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：回显规则（报告 options 与 import.meta 注入值）+ 传入 REPO_ROOT 的配置
    write('/mock/project', 'lint-rules/echo.mjs', `export default {
    meta: { schema: [{ type: 'object' }] },
    create(context) {
        context.report({
            line: 1,
            column: 1,
            message: 'root=' + context.options[0].root + ';dir=' + import.meta.dirname + ';url=' + import.meta.url,
        });
        return {};
    },
};
`);
    write('/mock/project', 'eslint.config.mjs', `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import echo from './lint-rules/echo.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

const config = [
    {
        plugins: { app: { rules: { echo } } },
        rules: { 'app/echo': ['error', { root: REPO_ROOT }] },
    },
];

export default config;
`);
    write('/mock/project', 'a.js', 'const a = 1;\n');
    const result = eslint(['a.js']);
    // 预期 1：配置侧 import.meta.url 推导的根路径与规则侧 dirname/url 注入值均为卷内路径
    assert.equal(result.status, 1, '回显规则应报告一条消息');
    assert.ok(result.stdout.includes('root=/mock/project;'), '配置侧 import.meta.url 应推导出卷内根路径');
    assert.ok(result.stdout.includes('dir=/mock/project/lint-rules'), '规则侧 import.meta.dirname 应为卷内目录');
    assert.ok(result.stdout.includes('url=file:///mock/project/lint-rules/echo.mjs'), '规则侧 import.meta.url 应为卷内 file URL');
  } finally {
    done();
  }
});

/** 场景：severity warn 不改变退出码，--max-warnings 超限时退出 1，非法值按 fatal 报错。 */
test('severity warn 与 --max-warnings', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'warn' });
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    // 预期 1：仅 warning 退出 0，汇总为单数 problem 与 warning
    let result = eslint(['a.js']);
    assert.equal(result.status, 0, '仅 warning 应退出 0');
    assert.ok(result.stdout.includes('✖ 1 problem (0 errors, 1 warning)'), '汇总应为单数 problem 与 warning');
    // 预期 2：--max-warnings 0 时 warning 亦退出 1
    result = eslint(['--max-warnings', '0', 'a.js']);
    assert.equal(result.status, 1, 'warning 超过 --max-warnings 0 应退出 1');
    // 预期 3：warning 未超限应退出 0
    result = eslint(['--max-warnings', '1', 'a.js']);
    assert.equal(result.status, 0, 'warning 未超过 --max-warnings 1 应退出 0');
    // 预期 4：非法值按 fatal 报错
    result = eslint(['--max-warnings', 'x', 'a.js']);
    assert.equal(result.status, 2, '--max-warnings 非整数应为 fatal');
    assert.match(result.stderr, /--max-warnings/, '应报出非法值');
  } finally {
    done();
  }
});

/** 场景：插件值为字符串时按内存卷路径加载，模块须导出 { rules } 插件对象。 */
test('字符串 plugin 形态按卷路径加载', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    // 输入：插件模块（导出 { rules } 插件对象）+ 字符串插件值的配置
    write('/mock/project', 'lint-rules/app-plugin.mjs', `import noTrailingSpaces from './no-trailing-spaces.mjs';

const plugin = { rules: { 'no-trailing-spaces': noTrailingSpaces } };

export default plugin;
`);
    write('/mock/project', 'eslint.config.mjs', `const config = [
    { plugins: { app: './lint-rules/app-plugin.mjs' }, rules: { 'app/no-trailing-spaces': 'error' } },
];

export default config;
`);
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    const result = eslint(['a.js']);
    // 预期 1：字符串插件经迷你加载器装载，规则命中
    assert.equal(result.status, 1, '字符串插件装配后规则应命中');
    assert.ok(result.stdout.includes('app/no-trailing-spaces'), '应报告规则 ID');
  } finally {
    done();
  }
});

/** 场景：多 item 按序合并，后者 rules 覆盖前者（off 可关掉、error 可升上来）。 */
test('多 item 合并：rules 后者覆盖', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    const overrideSource = (first, second) => `import noTrailingSpaces from './lint-rules/no-trailing-spaces.mjs';

const config = [
    { plugins: { app: { rules: { 'no-trailing-spaces': noTrailingSpaces } } }, rules: ${JSON.stringify(first)} },
    { rules: ${JSON.stringify(second)} },
];

export default config;
`;
    // 输入：先 error 后 off
    write('/mock/project', 'eslint.config.mjs', overrideSource({ 'app/no-trailing-spaces': 'error' }, { 'app/no-trailing-spaces': 'off' }));
    // 预期 1：后者覆盖为 off → 干净退出
    assert.equal(eslint(['a.js']).status, 0, '后者覆盖为 off 后应干净退出');
    // 输入：先 off 后 error
    write('/mock/project', 'eslint.config.mjs', overrideSource({ 'app/no-trailing-spaces': 'off' }, { 'app/no-trailing-spaces': 'error' }));
    // 预期 2：后者覆盖为 error → 命中退出 1
    assert.equal(eslint(['a.js']).status, 1, '后者覆盖为 error 后应命中退出 1');
  } finally {
    done();
  }
});

/** 场景：--config 显式指定配置路径（相对 cwd），不依赖向上发现。 */
test('--config 指定配置路径', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    write('/mock/project', 'configs/custom.mjs', `import noTrailingSpaces from '../lint-rules/no-trailing-spaces.mjs';

const config = [
    { plugins: { app: { rules: { 'no-trailing-spaces': noTrailingSpaces } } }, rules: { 'app/no-trailing-spaces': 'error' } },
];

export default config;
`);
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    // 输入：--config 指向非标准名配置
    const result = eslint(['--config', 'configs/custom.mjs', 'a.js']);
    // 预期 1：指定配置生效
    assert.equal(result.status, 1, '--config 指定的配置应生效');
    assert.ok(result.stdout.includes('app/no-trailing-spaces'), '应报告规则 ID');
  } finally {
    done();
  }
});

/** 场景：裸规则名走真实引擎的核心规则（no-trailing-spaces 真实执行，文案与列位为引擎口径）。 */
test('核心规则裸名直接可用', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：裸名引用真实核心规则（使用方配置的 no-restricted-syntax 同口径）
    write('/mock/project', 'eslint.config.mjs', "const config = [{ rules: { 'no-trailing-spaces': 'error' } }];\n\nexport default config;\n");
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    const result = eslint(['a.js']);
    // 预期 1：真实核心规则执行并报告
    assert.equal(result.status, 1, '核心规则命中应退出 1');
    assert.ok(result.stdout.includes('no-trailing-spaces'), '应报告规则 ID');
    assert.ok(result.stdout.includes('Trailing spaces not allowed.'), '应使用真实核心规则文案');
    assert.ok(result.stdout.includes('1:13'), '应报告行尾空白列位');
    assert.ok(result.stdout.includes('✖ 1 problem (1 error, 0 warnings)'), '汇总应为一条错误');
  } finally {
    done();
  }
});

/** 场景：规则装配错误由真实引擎以真实消息报出——未知插件、未知规则名、非法严重级别。 */
test('规则装配错误报出真实引擎消息', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'a.js', 'const a = 1;\n');
    // 输入：规则引用未定义的插件
    write('/mock/project', 'eslint.config.mjs', "const config = [{ rules: { 'nope/x': 'error' } }];\n\nexport default config;\n");
    // 预期 1：未知插件按 fatal 报出真实消息
    let result = eslint(['a.js']);
    assert.equal(result.status, 2, '未知插件应为 fatal');
    assert.match(result.stderr, /Could not find plugin "nope" in configuration\./, '应报出真实引擎的未知插件消息');
    // 输入：插件未提供的规则名
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: { rules: {} } } }, { rules: { 'app/nope': 'error' } }];\n\nexport default config;\n");
    // 预期 2：未知规则名按 fatal 报出真实消息
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '未知规则名应为 fatal');
    assert.match(result.stderr, /Could not find "nope" in plugin "app"\./, '应报出真实引擎的未知规则消息');
    // 输入：非法严重级别
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'sometimes' });
    // 预期 3：非法严重级别按 fatal 报出真实 schema 消息
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '非法严重级别应为 fatal');
    assert.match(result.stderr, /Expected severity of "off", 0, "warn", 1, "error", or 2\./, '应报出真实引擎的 severity 校验消息');
  } finally {
    done();
  }
});

/** 场景：插件身份与形态语义对齐真实引擎——同一插件对象重复定义允许（按身份去重）、
 * 异对象重定义 fatal、插件多余键（configs）允许、规则缺 create 与插件 rules 非对象 fatal。 */
test('插件身份与形态语义对齐真实引擎', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    // 输入：同一插件对象在两个 item 中重复定义
    write('/mock/project', 'eslint.config.mjs', `import noTrailingSpaces from './lint-rules/no-trailing-spaces.mjs';

const app = { rules: { 'no-trailing-spaces': noTrailingSpaces } };

const config = [
    { plugins: { app: app }, rules: { 'app/no-trailing-spaces': 'error' } },
    { plugins: { app: app } },
];

export default config;
`);
    // 预期 1：同一身份的重定义被真实引擎允许（适配层保持对象身份），规则正常执行
    const same = eslint(['a.js']);
    assert.equal(same.status, 1, '同对象重定义应被允许且规则执行');
    assert.ok(same.stdout.includes('app/no-trailing-spaces'), '应报告规则 ID');
    // 输入：两个不同对象重复定义同名插件
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: { rules: {} } } }, { plugins: { app: { rules: {} } } }];\n\nexport default config;\n");
    // 预期 2：异对象重定义按真实引擎口径 fatal
    let result = eslint(['a.js']);
    assert.equal(result.status, 2, '异对象重定义应为 fatal');
    assert.match(result.stderr, /Cannot redefine plugin "app"\./, '应报出真实引擎的重定义消息');
    // 输入：插件对象携带 configs 等真实插件常见键
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: { rules: {}, configs: {} } } }, { rules: {} }];\n\nexport default config;\n");
    // 预期 3：多余键透传真实引擎，不再误杀
    result = eslint(['a.js']);
    assert.equal(result.status, 0, '插件多余键应被真实引擎接受');
    // 输入：规则实现缺 create
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: { rules: { bad: {} } } } }, { rules: { 'app/bad': 'error' } }];\n\nexport default config;\n");
    // 预期 4：缺 create 按真实引擎口径 fatal
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '规则缺 create 应为 fatal');
    assert.match(result.stderr, /Rule must be an object with a `create` method/, '应报出真实引擎的规则形态消息');
    // 输入：插件 rules 为数组
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: { rules: [] } } }, { rules: {} }];\n\nexport default config;\n");
    // 预期 5：真实引擎容忍非对象 rules（空数组等价于无规则），干净文件正常通过
    result = eslint(['a.js']);
    assert.equal(result.status, 0, '插件 rules 为数组应被真实引擎容忍');
    // 输入：插件值不是对象也不是字符串
    write('/mock/project', 'eslint.config.mjs', "const config = [{ plugins: { app: 42 } }];\n\nexport default config;\n");
    // 预期 6：插件值非法按真实引擎口径 fatal
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '插件值非法应为 fatal');
    assert.match(result.stderr, /Key "plugins": Key "app": Expected an object\./, '应报出真实引擎的插件形态消息');
  } finally {
    done();
  }
});

/** 场景：配置结构 fatal——default export 非数组由本模块报错，item 非对象由真实引擎报错。 */
test('配置结构非法按 fatal 报错', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'a.js', 'const a = 1;\n');
    // 输入：default export 非数组
    write('/mock/project', 'eslint.config.mjs', 'export default {};\n');
    // 预期 1：非数组按 fatal 报错
    let result = eslint(['a.js']);
    assert.equal(result.status, 2, '非数组配置应为 fatal');
    assert.match(result.stderr, /须导出数组/, '应提示配置须导出数组');
    // 输入：item 非对象
    write('/mock/project', 'eslint.config.mjs', 'export default [42];\n');
    // 预期 2：item 非对象按真实引擎口径 fatal
    result = eslint(['a.js']);
    assert.equal(result.status, 2, 'item 非对象应为 fatal');
    assert.match(result.stderr, /Unexpected non-object config at original index 0\./, '应报出真实引擎的 item 形态消息');
  } finally {
    done();
  }
});

/** 场景：加载器限制——npm 包经解析基装载（shell-quote 实证）、缺失包明确报错、
 * 多行 import / 缺失卷文件 / 语法错误 / import.meta 其他成员明确报错（named export 已支持）。 */
test('加载器 import 口径', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'a.js', 'const a = 1;\n');
    // 输入：配置 import npm 包 shell-quote（宿主已装）并在规则消息中消费
    write('/mock/project', 'eslint.config.mjs', `import { quote } from 'shell-quote';

const rule = {
    create(context) {
        context.report({ line: 1, column: 1, message: 'q=' + quote(['a b']) });
        return {};
    },
};

const config = [{ plugins: { app: { rules: { q: rule } } } }, { rules: { 'app/q': 'error' } }];

export default config;
`);
    // 预期 1：npm 包从使用方 node_modules 解析并执行
    let result = eslint(['a.js']);
    assert.equal(result.status, 1, 'npm 包 import 应成功且规则执行');
    assert.ok(result.stdout.includes("q='a b'"), '规则消息应包含 shell-quote 的返回值');
    // 输入：import 宿主未安装的 npm 包
    write('/mock/project', 'eslint.config.mjs', "import x from 'fs-extra';\n\nexport default [];\n");
    // 预期 2：缺失 npm 包明确报错
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '缺失 npm 包应为 fatal');
    assert.match(result.stderr, /无法解析 npm 包 'fs-extra'/, '应报出无法解析的包名');
    // 输入：多行 import
    write('/mock/project', 'eslint.config.mjs', "import {\n    join\n} from 'node:path';\n\nexport default [];\n");
    // 预期 3：多行 import 明确报错
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '多行 import 应为 fatal');
    assert.match(result.stderr, /单行 import/, '应提示仅支持单行 import');
    // 输入：named export 与 export default 并存
    write('/mock/project', 'eslint.config.mjs', 'export const x = 1;\n\nexport default [];\n');
    // 预期 4：具名导出被支持，配置仍按数组装载（空规则 → 干净）
    result = eslint(['a.js']);
    assert.equal(result.status, 0, 'named export 应被支持且配置仍为数组');
    // 输入：import 缺失的卷内文件
    write('/mock/project', 'eslint.config.mjs', "import m from './lint-rules/missing.mjs';\n\nexport default [];\n");
    // 预期 5：缺失卷文件按 fatal 报错并带路径
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '缺失卷文件应为 fatal');
    assert.match(result.stderr, /无法读取模块 .*missing\.mjs/, '应报出缺失模块路径');
    // 输入：语法错误
    write('/mock/project', 'eslint.config.mjs', 'export default [;;;\n');
    // 预期 6：语法错误按 fatal 报错
    result = eslint(['a.js']);
    assert.equal(result.status, 2, '语法错误应为 fatal');
    assert.match(result.stderr, /执行失败/, '应报出模块执行失败');
    // 输入：import.meta 使用其他成员
    write('/mock/project', 'eslint.config.mjs', "const u = import.meta.resolve('x');\n\nexport default [];\n");
    // 预期 7：import.meta 其他成员明确报错
    result = eslint(['a.js']);
    assert.equal(result.status, 2, 'import.meta 其他成员应为 fatal');
    assert.match(result.stderr, /import\.meta 仅支持 url \/ dirname/, '应提示 import.meta 支持面');
  } finally {
    done();
  }
});

/** 场景：AST visitor 规则真实执行——espree 解析 + CallExpression visitor + report({ node })，
 * 内联 eslint-disable-next-line 指令生效。 */
test('AST visitor 规则与内联指令', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'lint-rules/no-bad-call.mjs', AST_RULE_SOURCE);
    write('/mock/project', 'eslint.config.mjs', `import noBadCall from './lint-rules/no-bad-call.mjs';

const config = [
    { plugins: { app: { rules: { 'no-bad-call': noBadCall } } }, rules: { 'app/no-bad-call': 'error' } },
];

export default config;
`);
    write('/mock/project', 'a.js', 'bad();\n');
    // 输入：调用 bad() 的文件
    let result = eslint(['a.js']);
    // 预期 1：真实 AST 执行，消息取 node 位置
    assert.equal(result.status, 1, 'AST 规则命中应退出 1');
    assert.ok(result.stdout.includes('1:1'), '应报告 node 的真实位置');
    assert.ok(result.stdout.includes('禁止调用 bad()'), '应使用规则消息');
    assert.ok(result.stdout.includes('app/no-bad-call'), '应报告规则 ID');
    // 输入：内联指令抑制
    write('/mock/project', 'a.js', '// eslint-disable-next-line app/no-bad-call\nbad();\n');
    // 预期 2：内联指令由真实引擎处理，命中被抑制
    result = eslint(['a.js']);
    assert.equal(result.status, 0, '内联指令应抑制命中');
    assert.equal(result.stdout, '', '抑制后应无 stylish 输出');
  } finally {
    done();
  }
});

/** 场景：files/ignores/languageOptions 由真实引擎处理——files 限定只命中匹配文件、
 * 全局 ignores 排除的文件被静默跳过、languageOptions 透传。 */
test('files 限定、全局 ignores 与 languageOptions', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    // 输入：ignores-only 全局忽略 + files 限定的规则分区（含 languageOptions）
    write('/mock/project', 'eslint.config.mjs', `import noTrailingSpaces from './lint-rules/no-trailing-spaces.mjs';

const config = [
    { ignores: ['ignored/**'] },
    {
        files: ['src/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        plugins: { app: { rules: { 'no-trailing-spaces': noTrailingSpaces } } },
        rules: { 'app/no-trailing-spaces': 'error' },
    },
];

export default config;
`);
    const bad = 'const a = 1;  \n';
    write('/mock/project', 'src/a.js', bad);
    write('/mock/project', 'lib/out.js', bad);
    write('/mock/project', 'ignored/x.js', bad);
    const results = JSON.parse(eslint(['.', '--format', 'json']).stdout);
    // 预期 1：被全局 ignores 排除的文件不出现在结果中
    assert.equal(results.some((r) => r.filePath.includes('/ignored/')), false, 'ignored 文件应被静默跳过');
    // 预期 2：files 限定的规则只命中匹配文件
    const withMessages = results.filter((r) => r.messages.length > 0).map((r) => r.filePath);
    assert.deepEqual(withMessages, ['/mock/project/src/a.js'], 'files 模式外的文件不应命中规则');
    // 预期 3：files 模式外的文件以空消息进入结果（真实引擎未配置即无诊断）
    const out = results.find((r) => r.filePath === '/mock/project/lib/out.js');
    assert.ok(out, '未命中规则的文件应保留空结果');
    assert.deepEqual(out.messages, [], 'lib/out.js 应无诊断');
    // 预期 4：汇总只统计命中文件
    assert.equal(results.reduce((n, r) => n + r.errorCount, 0), 1, '错误总数应为 1');
  } finally {
    done();
  }
});

/** 场景：配置/规则模块 import 的 node:fs 注入 lite-fs 门面——mock 后规则读写内存卷。 */
test('node:fs 注入 lite-fs 门面', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'lint-rules/fs-probe.mjs', FS_RULE_SOURCE);
    write('/mock/project', 'eslint.config.mjs', `import fsProbe from './lint-rules/fs-probe.mjs';

const config = [
    { plugins: { app: { rules: { 'fs-probe': fsProbe } } }, rules: { 'app/fs-probe': 'error' } },
];

export default config;
`);
    // 输入：内容只存在于内存卷的文件
    write('/mock/project', 'a.js', 'VOLUMETEXT\n');
    const result = eslint(['a.js']);
    // 预期 1：规则经门面读到内存卷内容
    assert.equal(result.status, 1, '探针规则应报告一条消息');
    assert.ok(result.stdout.includes('exists=true'), 'fs.existsSync 应命中内存卷文件');
    assert.ok(result.stdout.includes('head=VOL'), 'fs.readFileSync 应读到内存卷内容');
  } finally {
    done();
  }
});

/** 场景：卷内模块的具名导出与 named import——lib 多具名导出（function/const/别名列表）、
 * 规则模块按导出名解析（使用方共享 lib 模块形态）。 */
test('具名导出与 named import', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：lib 模块多具名导出（function/const/别名列表）+ 规则模块 named import 消费
    write('/mock/project', 'lint-rules/lib/helper.mjs', `export const VERSION = 'v1';

export function tag(value) {
    return '[' + value + ']';
}

export { tag as wrap };
`);
    write('/mock/project', 'lint-rules/named-probe.mjs', `import { tag, VERSION, wrap } from './lib/helper.mjs';

export default {
    create(context) {
        context.report({ line: 1, column: 1, message: 'v=' + VERSION + ';t=' + tag('x') + ';w=' + wrap('y') });
        return {};
    },
};
`);
    write('/mock/project', 'eslint.config.mjs', `import namedProbe from './lint-rules/named-probe.mjs';

const config = [
    { plugins: { app: { rules: { 'named-probe': namedProbe } } }, rules: { 'app/named-probe': 'error' } },
];

export default config;
`);
    write('/mock/project', 'a.js', 'const a = 1;\n');
    const result = eslint(['a.js']);
    // 预期 1：具名导出与 named import（含别名）均按导出名解析
    assert.equal(result.status, 1, '探针规则应报告一条消息');
    assert.ok(result.stdout.includes('v=v1;t=[x];w=[y]'), '具名绑定与别名导出应全部生效');
  } finally {
    done();
  }
});

/** 场景：规则模块 import 的 fs（裸名）同样注入 lite-fs 门面——同一路径内容只存在于内存卷
 * （真实磁盘无此文件），裸名 fs 读到内存值证明未穿透到宿主文件系统。 */
test('fs 裸名注入 lite-fs 门面', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'lint-rules/fs-bare.mjs', `import fs from 'fs';

export default {
    create(context) {
        context.report({ line: 1, column: 1, message: 'value=' + fs.readFileSync(context.filename, 'utf8').trim() });
        return {};
    },
};
`);
    write('/mock/project', 'eslint.config.mjs', `import fsBare from './lint-rules/fs-bare.mjs';

const config = [
    { plugins: { app: { rules: { 'fs-bare': fsBare } } }, rules: { 'app/fs-bare': 'error' } },
];

export default config;
`);
    // 输入：内容只存在于内存卷的文件（真实磁盘 /mock/... 不存在）
    write('/mock/project', 'a.js', 'MEMORY_VALUE\n');
    const result = eslint(['a.js']);
    // 预期 1：裸名 fs 读到的是内存卷内容而非宿主磁盘
    assert.equal(result.status, 1, '探针规则应报告一条消息');
    assert.ok(result.stdout.includes('value=MEMORY_VALUE'), 'fs 裸名应读到内存卷内容');
  } finally {
    done();
  }
});

/** 场景：--ext 与 config 推导扩展名取并集——--ext ts 不漏查 main.js 的违规（P1 回归）。 */
test('--ext 并入候选扩展名', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    write('/mock/project', 'main.js', 'const a = 1;  \n');
    write('/mock/project', 'x.ts', 'const b = 1;\n');
    // 输入：--ext ts
    const result = eslint(['--ext', 'ts', '.']);
    // 预期 1：js 文件的违规仍被检出（不因 --ext 而漏查，返回 0 是错误行为）
    assert.equal(result.status, 1, '--ext ts 不应漏查 main.js 的违规');
    assert.ok(result.stdout.includes('/mock/project/main.js'), 'main.js 诊断应在报告中');
    // 预期 2：未配置覆盖的 ts 文件静默跳过
    assert.ok(!result.stdout.includes('x.ts'), '未配置的 ts 文件应被跳过');
  } finally {
    done();
  }
});

/** 场景：同一命令内卷内模块按规范化路径缓存——同文件两次导入共享同一实例（真实引擎按对象
 * 身份允许同插件重定义；P2 回归：无缓存时两次执行产生不同对象误报 Cannot redefine）。 */
test('模块缓存保持模块身份', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    write('/mock/project', 'lint-rules/once.mjs', `import noTrailingSpaces from './no-trailing-spaces.mjs';

export default { rules: { 'no-trailing-spaces': noTrailingSpaces } };
`);
    write('/mock/project', 'eslint.config.mjs', `import first from './lint-rules/once.mjs';
import second from './lint-rules/once.mjs';

const config = [
    { plugins: { app: first }, rules: { 'app/no-trailing-spaces': 'error' } },
    { plugins: { app: second } },
];

export default config;
`);
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    const result = eslint(['a.js']);
    // 预期 1：两次导入同一文件得到同一实例，重定义不被误报且规则执行
    assert.equal(result.status, 1, '同文件两次导入应共享同一实例并正常执行规则');
    assert.ok(result.stdout.includes('app/no-trailing-spaces'), '应报告规则 ID');
  } finally {
    done();
  }
});

/** 场景：export default 捕获与 import.meta 注入基于代码上下文掩码——字符串/模板内的关键字
 * 是合法内容不误改（P2 回归：字符串里先出现 'export default' 曾导致真实导出解析失败）。 */
test('源码转换不误伤字符串与模板', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'eslint.config.mjs', [
      "const label = 'export default';",
      "const doc = 'import.meta.url 在此字符串内';",
      'const tpl = `export default ${label.length}`;',
      '',
      'const config = [',
      '    {',
      "        plugins: { app: { rules: { probe: { meta: { schema: [] }, create(context) { context.report({ line: 1, column: 1, message: 'label=' + label.length + ';doc=' + doc.length + ';tpl=' + tpl.length }); return {}; } } } } },",
      "        rules: { 'app/probe': 'error' },",
      '    },',
      '];',
      '',
      'export default config;',
    ].join('\n'));
    write('/mock/project', 'a.js', 'const a = 1;\n');
    const result = eslint(['a.js']);
    // 预期 1：字符串/模板内容原样保留，真实导出正常捕获，配置装载成功
    assert.equal(result.status, 1, '配置应正常装载且探针规则执行');
    assert.ok(result.stdout.includes('label=14'), '字符串内的 export default 应原样保留');
    assert.ok(result.stdout.includes('doc=22'), '字符串内的 import.meta.url 应原样保留');
    assert.ok(result.stdout.includes('tpl=17'), '模板内的 export default 应原样保留');
  } finally {
    done();
  }
});

/** 场景：if 条件后的正则字面量包含 export default 时，不能被误当代码改写；配置正常加载，
 * 干净文件通过，debugger 仍由配置中的真实核心规则检出。 */
test('源码转换不误伤 if 条件后的正则', function testRegexAfterIfPreservesExportDefault() {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：正则紧跟 if 的右括号，正则中的 export default 早于真正的默认导出。
    write('/mock/project', 'eslint.config.mjs', [
      "if (true) /export default/.test('x');",
      "export default [{ rules: { 'no-debugger': 'error' } }];",
      '',
    ].join('\n'));
    write('/mock/project', 'a.js', 'const value = 1;\n');
    const clean = eslint(['a.js', '--format', 'json']);
    // 预期 1：合法配置和干净文件正常通过，不能因改写正则而产生配置 fatal。
    assert.equal(clean.status, 0, `if 条件后的正则不应破坏配置默认导出：${clean.stderr}`);
    assert.equal(clean.stderr, '', '合法正则配置不应产生加载错误');
    const cleanReports = JSON.parse(clean.stdout);
    assert.equal(cleanReports.length, 1, '应检查且只报告显式指定的 a.js');
    assert.equal(cleanReports[0].filePath, '/mock/project/a.js', '干净文件报告应对应 a.js');
    assert.deepEqual(cleanReports[0].messages, [], '干净文件不应产生规则或解析诊断');
    assert.equal(cleanReports[0].errorCount, 0, '干净文件错误数应为零');

    // 输入：保留同一配置，将被检文件改为 debugger，验证真实导出中的规则仍然启用。
    write('/mock/project', 'a.js', 'debugger;\n');
    const violation = eslint(['a.js', '--format', 'json']);
    // 预期 2：真实 no-debugger 规则执行，不能以丢失配置或规则换取干净文件通过。
    assert.equal(violation.status, 1, `debugger 应以规则错误退出 1，而非配置 fatal：${violation.stderr}`);
    assert.equal(violation.stderr, '', 'debugger 应通过规则报告，而非配置加载错误');
    const reports = JSON.parse(violation.stdout);
    assert.equal(reports.length, 1, '违规检查应只报告显式指定的 a.js');
    assert.equal(reports[0].filePath, '/mock/project/a.js', '违规应定位到 a.js');
    assert.equal(reports[0].errorCount, 1, 'debugger 应恰好产生一个规则错误');
    assert.equal(reports[0].messages.length, 1, 'debugger 应恰好产生一条诊断');
    assert.deepEqual(reports[0].messages[0], {
      ruleId: 'no-debugger',
      severity: 2,
      line: 1,
      column: 1,
      message: "Unexpected 'debugger' statement.",
      fatal: false,
      fix: false,
    }, '诊断应为 a.js 首行首列的真实 no-debugger 规则错误');
  } finally {
    done();
  }
});

/** 场景：files 使用标准花括号 glob 时，目录检查仍发现 js/mjs 文件并执行规则，不能空报告通过。 */
test('标准 glob 不应漏查 js 与 mjs', function testBraceGlobDoesNotSkipManagedFiles() {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：只有包含花括号 glob 的配置分区，两个目标文件均包含 debugger。
    write('/mock/project', 'eslint.config.mjs', "export default [{ files: ['**/*.{js,mjs}'], rules: { 'no-debugger': 'error' } }];\n");
    write('/mock/project', 'src/a.js', 'debugger;\n');
    write('/mock/project', 'src/b.mjs', 'debugger;\n');
    const result = eslint(['.', '--format', 'json']);
    // 预期 1：两个受管扩展名都被发现并报告规则错误，不能以空文件集合返回成功。
    assert.equal(result.status, 1, `花括号 glob 下的 debugger 必须检出：${result.stderr}`);
    assert.equal(result.stderr, '', '标准花括号 glob 不应导致配置或加载错误');
    const reports = JSON.parse(result.stdout);
    const violations = reports.filter(report => report.messages.length > 0);
    assert.deepEqual(violations.map(report => report.filePath).sort(), [
      '/mock/project/src/a.js',
      '/mock/project/src/b.mjs',
    ], 'js 与 mjs 文件都应产生违规报告，合法配置自身不应报错');
    for (const report of violations) {
      assert.equal(report.errorCount, 1, `${report.filePath} 应恰好报告一个 debugger 错误`);
      assert.equal(report.messages.length, 1, `${report.filePath} 不应附带额外诊断`);
      assert.equal(report.messages[0].ruleId, 'no-debugger', `${report.filePath} 应由真实 no-debugger 规则检出`);
      assert.equal(report.messages[0].fatal, false, `${report.filePath} 不应以解析错误代替规则检出`);
    }

    // 输入：修复两个目标，保留相同的 glob 和目录检查入口。
    write('/mock/project', 'src/a.js', 'const value = 1;\n');
    write('/mock/project', 'src/b.mjs', 'const value = 2;\n');
    const recovered = eslint(['.', '--format', 'json']);
    // 预期 2：修复后通过，两个文件仍真实出现在检查结果中，不能因遗漏而通过。
    assert.equal(recovered.status, 0, `花括号 glob 下修复后的文件应通过：${recovered.stderr}`);
    assert.equal(recovered.stderr, '', '修复后的 glob 检查不应有执行错误');
    const cleanReports = JSON.parse(recovered.stdout);
    for (const file of ['/mock/project/src/a.js', '/mock/project/src/b.mjs']) {
      const report = cleanReports.find(entry => entry.filePath === file);
      assert.ok(report, `修复后仍应检查 ${file}`);
      assert.deepEqual(report.messages, [], `${file} 修复后不应有诊断`);
    }
  } finally {
    done();
  }
});

/** 场景：导出变量被模块函数更新后，具名导入应观察到新值并据此启用规则，而非保留导入时快照。 */
test('具名导入保留导出变量的动态绑定', function testNamedImportPreservesLiveBinding() {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：enabled 初始为 false；配置调用 enable 后应读到 true 并启用 no-debugger。
    write('/mock/project', 'settings.mjs', [
      'export let enabled = false;',
      'export function enable() { enabled = true; }',
      '',
    ].join('\n'));
    write('/mock/project', 'eslint.config.mjs', [
      "import { enabled, enable } from './settings.mjs';",
      'enable();',
      "export default [{ rules: { 'no-debugger': enabled ? 'error' : 'off' } }];",
      '',
    ].join('\n'));
    write('/mock/project', 'a.js', 'debugger;\n');
    const result = eslint(['a.js', '--format', 'json']);
    // 预期 1：读取更新后的绑定，debugger 应报错；不能因旧值 false 关闭规则而通过。
    assert.equal(result.status, 1, `具名导入应观察 enable 修改后的 enabled：${result.stderr}`);
    assert.equal(result.stderr, '', '合法动态绑定不应导致配置加载错误');
    const reports = JSON.parse(result.stdout);
    assert.equal(reports.length, 1, '动态绑定检查应只报告显式指定的 a.js');
    assert.equal(reports[0].filePath, '/mock/project/a.js', '规则错误应归属 a.js');
    assert.equal(reports[0].errorCount, 1, 'enabled 更新后应启用规则并报告一个错误');
    assert.equal(reports[0].messages.length, 1, 'debugger 应恰好产生一条诊断');
    assert.equal(reports[0].messages[0].ruleId, 'no-debugger', '更新后的绑定应启用真实 no-debugger 规则');
    assert.equal(reports[0].messages[0].fatal, false, '动态绑定用例不应以解析错误代替规则检出');

    // 输入：保留配置与动态绑定，将目标修复为无 debugger 的合法源码。
    write('/mock/project', 'a.js', 'const value = 1;\n');
    const clean = eslint(['a.js', '--format', 'json']);
    // 预期 2：启用规则不意味着无条件失败，合法源码仍正常通过。
    assert.equal(clean.status, 0, `动态绑定配置下的合法源码应通过：${clean.stderr}`);
    assert.equal(clean.stderr, '', '动态绑定配置的合法对照不应有执行错误');
    assert.deepEqual(JSON.parse(clean.stdout)[0].messages, [], '合法源码不应产生 no-debugger 诊断');
  } finally {
    done();
  }
});

/** 场景：值为 undefined 的具名导出仍然存在，能正常导入并决定规则配置；真正缺失的导出才报错。 */
test('值为 undefined 的具名导出仍可导入', function testUndefinedNamedExportIsNotMissing() {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：optional 明确导出且值为 undefined，配置应据此启用 no-debugger。
    write('/mock/project', 'settings.mjs', 'export const optional = undefined;\n');
    write('/mock/project', 'eslint.config.mjs', [
      "import { optional } from './settings.mjs';",
      "export default [{ rules: { 'no-debugger': optional === undefined ? 'error' : 'off' } }];",
      '',
    ].join('\n'));
    write('/mock/project', 'a.js', 'debugger;\n');
    const result = eslint(['a.js', '--format', 'json']);
    // 预期 1：导出存在性与值分开判断，undefined 不应被误判为缺失导出导致 fatal。
    assert.equal(result.status, 1, `合法的 undefined 导出应加载成功并启用规则：${result.stderr}`);
    assert.equal(result.stderr, '', '值为 undefined 的合法导出不应报告加载错误');
    const reports = JSON.parse(result.stdout);
    assert.equal(reports.length, 1, 'undefined 导出用例应只检查 a.js');
    assert.equal(reports[0].messages.length, 1, 'undefined 条件启用规则后应报告一条 debugger 诊断');
    assert.equal(reports[0].messages[0].ruleId, 'no-debugger', '错误应来自 no-debugger，而非导入或解析失败');
    assert.equal(reports[0].messages[0].fatal, false, '合法 undefined 导出不应产生 fatal');

    // 输入：移除 optional 导出，只保留另一个同为 undefined 的导出，配置导入保持不变。
    write('/mock/project', 'settings.mjs', 'export const another = undefined;\n');
    const missing = eslint(['a.js', '--format', 'json']);
    // 预期 2：真正不存在的导出仍须明确失败，不能给所有缺失名称静默补 undefined。
    assert.equal(missing.status, 2, '真正缺少 optional 导出时应返回配置 fatal');
    assert.equal(missing.stdout, '', '缺失导出不应伪造 lint 文件报告');
    assert.match(missing.stderr, /optional/, '缺失导出的诊断应指出 optional 名称');
  } finally {
    done();
  }
});

/** 场景：全局 ignores 排除的文件不应被读取；对其注入 EACCES 不能使合法项目检查失败。 */
test('忽略文件不应触发读取或权限错误', function testIgnoredFilesAreNotRead() {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const done = setup();
  let remove;
  try {
    const eslint = volumeEslint('/mock/project');
    // 输入：合法业务文件和被全局忽略的违规文件；任何读取忽略文件的尝试均记账并抛 EACCES。
    write('/mock/project', 'eslint.config.mjs', "export default [{ ignores: ['ignored/**'] }, { rules: { 'no-debugger': 'error' } }];\n");
    write('/mock/project', 'main.js', 'const value = 1;\n');
    write('/mock/project', 'ignored/no-access.js', 'debugger;\n');
    let ignoredReads = 0;
    remove = liteFs.t_inject({
      op: 'readFileSync',
      matches(target) {
        if (target !== '/mock/project/ignored/no-access.js') return false;
        ignoredReads += 1;
        return true;
      },
      code: 'EACCES',
    });
    const result = eslint(['.', '--format', 'json']);
    // 预期 1：应用忽略规则后再读取文件，忽略文件零读取且不影响合法项目通过。
    assert.equal(result.status, 0, `忽略文件的读取权限不应阻断检查：${result.stderr}`);
    assert.equal(result.stderr, '', '被忽略文件的 EACCES 不应出现在执行错误中');
    assert.equal(ignoredReads, 0, '全局 ignores 排除的文件应完全不触发 readFileSync');
    const reports = JSON.parse(result.stdout);
    assert.ok(reports.some(report => report.filePath === '/mock/project/main.js'), '合法业务文件仍应真实进入检查');
    assert.equal(reports.some(report => report.filePath.includes('/ignored/')), false, '忽略文件不应进入 JSON 报告');
    for (const report of reports) {
      assert.deepEqual(report.messages, [], `${report.filePath} 的合法内容不应产生诊断`);
    }

    // 输入：保留忽略文件的故障注入，只在受管 main.js 中增加 debugger。
    write('/mock/project', 'main.js', 'debugger;\n');
    const violation = eslint(['.', '--format', 'json']);
    // 预期 2：忽略文件始终零读取，受管文件的真实规则错误仍被正常报告。
    assert.equal(violation.status, 1, `main.js 的 debugger 应正常检出：${violation.stderr}`);
    assert.equal(violation.stderr, '', '受管文件违规不应变成忽略文件的权限错误');
    assert.equal(ignoredReads, 0, '受管文件违规时也不应读取忽略文件');
    const violations = JSON.parse(violation.stdout).filter(report => report.messages.length > 0);
    assert.equal(violations.length, 1, '应只有受管 main.js 产生规则诊断');
    assert.equal(violations[0].filePath, '/mock/project/main.js', '规则错误应归属 main.js');
    assert.equal(violations[0].messages[0].ruleId, 'no-debugger', '应报告真实 no-debugger 规则错误');
  } finally {
    remove?.();
    done();
  }
});

/** 场景：--format json 输出 results 数组（含干净文件），消息与计数字段齐全且按 (line, column) 排序。 */
test('--format json 输出结构', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    write('/mock/project', 'b.js', 'const b = 2;\n');
    // 输入：a.js 含行尾空白（1:13），b.js 干净
    const results = JSON.parse(eslint(['a.js', 'b.js', '--format', 'json']).stdout);
    // 预期 1：json 包含全部被检文件且按路径排序
    assert.equal(results.length, 2, 'json 应包含全部被检文件');
    const [first, second] = results;
    assert.equal(first.filePath, '/mock/project/a.js', '应按路径排序先输出 a.js');
    assert.equal(second.filePath, '/mock/project/b.js', '干净文件也应在结果中');
    assert.deepEqual(second.messages, [], '干净文件 messages 应为空数组');
    assert.equal(second.errorCount, 0, '干净文件 errorCount 应为 0');
    // 预期 2：消息字段齐全
    assert.equal(first.messages.length, 1, 'a.js 应有一条消息');
    assert.deepEqual(first.messages[0], {
      ruleId: 'app/no-trailing-spaces',
      severity: 2,
      line: 1,
      column: 13,
      message: 'Trailing whitespace not allowed.',
      fatal: false,
      fix: false,
    }, '消息字段应齐全');
    // 预期 3：文件级计数正确
    assert.equal(first.errorCount, 1, 'error 计数应为 1');
    assert.equal(first.warningCount, 0, 'warning 计数应为 0');
    assert.equal(first.fatalErrorCount, 0, '无语法错误时 fatal 计数应为 0');
    assert.equal(first.fixableErrorCount, 0, '规则无 fix 时 fixable 计数应为 0');
  } finally {
    done();
  }
});

/** 场景：多文件 stylish 按路径排序输出，汇总跨文件统计且单复数正确。 */
test('多文件排序与跨文件汇总', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    write('/mock/project', 'z.js', 'const z = 1;  \n');
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    // 输入：目标顺序 z.js、a.js
    const result = eslint(['z.js', 'a.js']);
    // 预期 1：输出按文件路径排序而非目标顺序
    assert.equal(result.status, 1, '存在 error 应退出 1');
    const atA = result.stdout.indexOf('/mock/project/a.js');
    const atZ = result.stdout.indexOf('/mock/project/z.js');
    assert.ok(atA >= 0 && atZ > atA, 'stylish 应按文件路径排序输出');
    // 预期 2：汇总跨文件统计
    assert.ok(result.stdout.includes('✖ 2 problems (2 errors, 0 warnings)'), '汇总应跨文件统计');
  } finally {
    done();
  }
});

/** 场景：目录递归发现按 --ext 过滤并跳过 node_modules 与点目录，显式文件不受 --ext 限制。 */
test('目录递归、--ext 过滤与跳过目录', () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    const bad = 'const\ta = 1;  \n';
    write('/mock/project', 'src/a.js', bad);
    write('/mock/project', 'src/sub/b.js', bad);
    write('/mock/project', 'lib/c.js', bad);
    write('/mock/project', 'other.ts', bad);
    write('/mock/project', 'node_modules/d.js', bad);
    write('/mock/project', '.hidden/e.js', bad);
    // 输入：目标 '.'，默认候选扩展名 js/mjs/cjs（由无 files 键的配置 item 推导，配置与规则模块
    // 本身也按 flat config 惯例参与 lint），json 输出便于断言
    const json = JSON.parse(eslint(['.', '--format', 'json']).stdout);
    // 预期 1：js/mjs 文件被发现，node_modules 与点目录被跳过，结果按路径排序
    assert.deepEqual(json.map((r) => r.filePath), [
      '/mock/project/eslint.config.mjs',
      '/mock/project/lib/c.js',
      '/mock/project/lint-rules/no-trailing-spaces.mjs',
      '/mock/project/src/a.js',
      '/mock/project/src/sub/b.js',
    ], '默认候选扩展名下应发现 js/mjs 文件且跳过 node_modules 与点目录');
    // 输入：--ext js,ts
    const withTs = JSON.parse(eslint(['.', '--format', 'json', '--ext', 'js,ts']).stdout);
    // 预期 2：--ext 与 config 推导候选取并集（js/mjs/cjs ∪ ts）——ts 进入发现但未被配置覆盖
    // 而静默跳过；js/mjs 检查不受影响（P1 回归：--ext 不得替换候选而漏查文件）
    assert.deepEqual(withTs.map((r) => r.filePath), [
      '/mock/project/eslint.config.mjs',
      '/mock/project/lib/c.js',
      '/mock/project/lint-rules/no-trailing-spaces.mjs',
      '/mock/project/src/a.js',
      '/mock/project/src/sub/b.js',
    ], '--ext 并入候选扩展名，js/mjs 检查不受影响且未配置的 ts 被静默跳过');
    // 输入：配置显式覆盖 ts 后，显式文件目标 other.ts 不受 --ext 限制
    write('/mock/project', 'eslint.config.mjs', `import noTrailingSpaces from './lint-rules/no-trailing-spaces.mjs';

const config = [
    {
        files: ['**/*.ts'],
        plugins: { app: { rules: { 'no-trailing-spaces': noTrailingSpaces } } },
        rules: { 'app/no-trailing-spaces': 'error' },
    },
];

export default config;
`);
    const explicit = JSON.parse(eslint(['other.ts', '--format', 'json']).stdout);
    // 预期 3：显式文件不受 --ext 限制，files 覆盖后真实执行
    assert.deepEqual(explicit.map((r) => r.filePath), ['/mock/project/other.ts'], '显式文件不受 --ext 限制');
  } finally {
    done();
  }
});

/** 场景：命令级故障注入优先于内置实现，onRun 钩子浅合并覆盖、返回 undefined 回落内置。 */
test('故障注入与 onRun 钩子', () => {
  const done = setup();
  let remove;
  try {
    const eslint = volumeEslint('/mock/project');
    write('/mock/project', 'eslint.config.mjs', 'export default [];\n');
    write('/mock/project', 'a.js', 'const a = 1;\n');
    // 输入：一次性故障注入
    remove = mgr.command('eslint').t_inject({ exit: 128, stderr: 'boom', once: true });
    // 预期 1：故障短路内置实现，消费后恢复
    const failed = eslint(['a.js']);
    assert.equal(failed.status, 128, '故障注入应短路内置实现');
    assert.equal(failed.stderr, 'boom', '故障 stderr 应原样返回');
    assert.equal(eslint(['a.js']).status, 0, 'once 故障消费后应回到内置实现');
    remove();
    // 输入：钩子返回覆盖对象
    mgr.command('eslint').t_onRun(() => ({ status: 9, stdout: 'hook' }));
    // 预期 2：钩子返回值浅合并覆盖默认
    const hooked = eslint(['a.js']);
    assert.equal(hooked.status, 9, '钩子返回值应浅合并覆盖默认');
    assert.equal(hooked.stdout, 'hook', '钩子 stdout 应生效');
    // 输入：钩子返回 undefined
    mgr.command('eslint').t_onRun(() => undefined);
    // 预期 3：钩子返回 undefined 应回落内置实现
    assert.equal(eslint(['a.js']).status, 0, '钩子返回 undefined 应回落内置实现');
  } finally {
    mgr.command('eslint').t_onRun(null);
    remove?.();
    done();
  }
});

/** 场景：异步 spawn 复用同步实现，stdout 与退出码和 spawnSync 一致。 */
test('异步 spawn 与同步结果一致', async () => {
  const done = setup();
  try {
    const eslint = volumeEslint('/mock/project');
    writeRule('/mock/project');
    writeFixtureConfig('/mock/project', { 'app/no-trailing-spaces': 'error' });
    write('/mock/project', 'a.js', 'const a = 1;  \n');
    // 输入：异步 spawn 执行同一目标
    const child = liteChildProcess.spawn('eslint', ['a.js'], { cwd: '/mock/project' });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    const synced = liteChildProcess.spawnSync('eslint', ['a.js'], { cwd: '/mock/project', encoding: 'utf8' });
    // 预期 1：退出码一致
    assert.deepEqual(closed, { code: 1, signal: null }, '异步退出码应与同步一致');
    // 预期 2：stdout 一致
    assert.equal(stdout, synced.stdout, '异步 stdout 应与同步一致');
    // 预期 3：结果为外置规则报告
    assert.ok(stdout.includes('app/no-trailing-spaces'), '异步输出应含规则报告');
  } finally {
    done();
  }
});

// 原生 ESLint CLI 对照夹具：宿主 devDependencies 的真实 eslint 可执行文件（flat config 同构夹具）
const ESLINT_BIN = path.join(REAL_ROOT, 'node_modules', '.bin', 'eslint');

/** 场景：退出码与 JSON 报告的引擎事实与真实 ESLint CLI 对照（eslint.org 文档 CLI「Exit Codes」
 * 与内置 formatter：https://eslint.org/docs/latest/use/command-line-interface#exit-codes /
 * https://eslint.org/docs/latest/use/formatters）——干净 0 / 存在 error 或 warning 超
 * --max-warnings 1 / fatal 2；JSON 交集字段（filePath、ruleId/severity/line/column/message/
 * fatal、errorCount/warningCount/fatalErrorCount）来自同一真实引擎，应逐值一致。声明为
 * 近似口径的格式排版面（endLine/suggestions/source 等超集字段、fatal 消息措辞）不纳入对照。 */
test('真实 ESLint 对照：退出码口径与 JSON 报告引擎事实', () => {
  const temporary = nativeFs.mkdtempSync(path.join(TEMP_ROOT, 'lite-eslint-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const configSource = `export default [{
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
  rules: { 'no-debugger': 'error', 'no-unused-vars': 'warn' },
}];
`;
  nativeFs.writeFileSync(path.join(realRoot, 'eslint.config.mjs'), configSource);
  nativeFs.writeFileSync(path.join(realRoot, 'clean.js'), 'var ok = 2;\n');
  nativeFs.writeFileSync(path.join(realRoot, 'broken.js'), 'debugger;\nvar x = 1;\n');
  nativeFs.writeFileSync(path.join(realRoot, 'syntax.js'), 'var var var;\n');
  const scenario = memory => {
    const observations = [];
    const run = argv => {
      const result = memory
        ? liteChildProcess.spawnSync('eslint', argv, { cwd: '/mock/project', encoding: 'utf8' })
        : nativeSpawnSync(process.execPath, [ESLINT_BIN, ...argv], { cwd: realRoot, env: nativeReferenceEnv(), encoding: 'utf8' });
      return result;
    };
    // 输入：干净文件 / 违规文件 / 仅警告超限 / 语法错误（fatal）/ 缺配置（fatal）
    observations.push({ clean: run(['clean.js', '--format', 'json']).status });
    const mixed = run(['clean.js', 'broken.js', '--format', 'json']);
    const report = JSON.parse(mixed.stdout).map(entry => ({
      file: path.basename(entry.filePath),
      counts: [entry.errorCount, entry.warningCount, entry.fatalErrorCount, entry.fixableErrorCount, entry.fixableWarningCount],
      messages: entry.messages.map(message => ({ ruleId: message.ruleId, severity: message.severity,
        line: message.line, column: message.column, message: message.message, fatal: message.fatal ?? false })),
    })).sort((a, b) => a.file.localeCompare(b.file));
    observations.push({ mixedStatus: mixed.status, report });
    const fatal = run(['syntax.js', '--format', 'json']);
    observations.push({ fatalStatus: fatal.status,
      fatalMessage: JSON.parse(fatal.stdout)[0].messages.map(message => ({
        ruleId: message.ruleId, severity: message.severity, fatal: message.fatal ?? false,
        message: /Parsing error/.test(message.message) ? 'Parsing error' : message.message })) });
    observations.push({ warningsLimited: run(['--max-warnings', '0', 'broken.js']).status,
      warningsAllowed: run(['--max-warnings', '1', 'broken.js']).status });
    // 输入：子目录请求命中向上查找的父级配置（0）；真隔离目录无任何配置（fatal 2）
    observations.push({ upwardSearch: (() => {
      const nested = memory ? '/mock/project/nested' : path.join(realRoot, 'nested');
      (memory ? liteFs : nativeFs).mkdirSync(nested, { recursive: true });
      (memory ? liteFs : nativeFs).writeFileSync(path.join(nested, 'd.js'), 'var q = 1;\n');
      return (memory
        ? liteChildProcess.spawnSync('eslint', ['d.js'], { cwd: nested, encoding: 'utf8' })
        : nativeSpawnSync(process.execPath, [ESLINT_BIN, 'd.js'], { cwd: nested, env: nativeReferenceEnv(), encoding: 'utf8' })).status;
    })() });
    observations.push({ noConfigAnyWhere: (() => {
      const isolated = memory ? '/mock/isolated-no-config' : nativeFs.realpathSync(nativeFs.mkdtempSync(path.join(TEMP_ROOT, 'lite-eslint-bare-')));
      (memory ? liteFs : nativeFs).mkdirSync(isolated, { recursive: true });
      (memory ? liteFs : nativeFs).writeFileSync(path.join(isolated, 'd.js'), 'var q = 1;\n');
      return (memory
        ? liteChildProcess.spawnSync('eslint', ['d.js'], { cwd: isolated, encoding: 'utf8' })
        : nativeSpawnSync(process.execPath, [ESLINT_BIN, 'd.js'], { cwd: isolated, env: nativeReferenceEnv(), encoding: 'utf8' })).status;
    })() });
    return observations;
  };
  try {
    const expected = scenario(false);
    const done = setup();
    try {
      write('/mock/project', 'eslint.config.mjs', configSource);
      write('/mock/project', 'clean.js', 'var ok = 2;\n');
      write('/mock/project', 'broken.js', 'debugger;\nvar x = 1;\n');
      write('/mock/project', 'syntax.js', 'var var var;\n');
      // 预期：退出码映射与 JSON 引擎事实（规则 ID、严重级、位置、消息、计数）与真实 CLI 一致
      assert.deepEqual(scenario(true), expected, '内存 ESLint 退出码与 JSON 引擎事实应与真实 CLI 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：stylish 计数行与目标不匹配 fatal 与真实 ESLint CLI 对照（eslint.org 文档 formatter
 * stylish、CLI 退出码：https://eslint.org/docs/latest/use/formatters /
 * https://eslint.org/docs/latest/use/command-line-interface#exit-codes）——末行
 * ✖ N problems (X errors, Y warnings) 与无匹配目标 exit 2。stylish 的列对齐排版为头注释
 * 声明的简化口径，只比末行；无匹配目标的 fatal 消息措辞两侧各按声明（引号与提示行不同），
 * 只比退出码。 */
test('真实 ESLint 对照：stylish 计数行与无匹配目标退出码', () => {
  const temporary = nativeFs.mkdtempSync(path.join(TEMP_ROOT, 'lite-eslint-stylish-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const configSource = `export default [{
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
  rules: { 'no-debugger': 'error', 'no-unused-vars': 'warn' },
}];
`;
  nativeFs.writeFileSync(path.join(realRoot, 'eslint.config.mjs'), configSource);
  nativeFs.writeFileSync(path.join(realRoot, 'broken.js'), 'debugger;\nvar x = 1;\n');
  const scenario = memory => {
    const run = argv => (memory
      ? liteChildProcess.spawnSync('eslint', argv, { cwd: '/mock/project', encoding: 'utf8' })
      : nativeSpawnSync(process.execPath, [ESLINT_BIN, ...argv], { cwd: realRoot, env: nativeReferenceEnv(), encoding: 'utf8' }));
    const observations = {};
    const stylish = run(['broken.js']);
    observations.stylishTail = stylish.stdout.trimEnd().split('\n').at(-1);
    observations.stylishStatus = stylish.status;
    observations.noMatch = run(['missing-target']).status;
    return observations;
  };
  try {
    const expected = scenario(false);
    const done = setup();
    try {
      write('/mock/project', 'eslint.config.mjs', configSource);
      write('/mock/project', 'broken.js', 'debugger;\nvar x = 1;\n');
      // 预期：stylish 末行计数与无匹配目标 exit 2 与真实 CLI 一致
      assert.deepEqual(scenario(true), expected, '内存 ESLint stylish 计数行应与真实 CLI 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-cmd-eslint.mjs 导入的
 * 安装入口与库内部相对导入必须是同一实例（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async () => {
  const selfRef = await import('litenvi-node/lite-cmd-eslint.mjs');
  assert.equal(selfRef.t_install, t_install, '同一模块经不同 specifier 应共享同一实例');
});
