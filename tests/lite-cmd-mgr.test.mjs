// lite-cmd-mgr 门面用例（node:test 形态，可 `node --test` 或直跑）：命令模拟内核——/mock-cmd/
// 命名空间的命令登记（defineUserCommand：裸名 + impl 实现）、系统卷安装（install 幂等 /
// spawn 惰性安装 / lite-fs 持久根跨卷复位存活）、PATH 解析与绝对路径前缀映射、统一故障注入
//（exit 替换 / wait 闸门 / once 自毁 / 非法 fault 拒绝 / 移除函数）。命令集 lite-cmd-git/
// -node/-os 导入即登记（本文件导入以覆盖真实命令面）；试验命令 tst 为本文件专用（故障挂
// 在条目上跨用例共享，专用命令不污染真实命令）。用例注释格式：方法级写测试场景；语句中
//「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
let gitModule; // 冷启动登记用例中通过普通 import 加载，不创建第二份带查询参数的模块
import * as nodeModule from '../lite-cmd-node.mjs';
import * as osModule from '../lite-cmd-os.mjs';
import * as processModule from '../lite-process.mjs';
import liteHttp from '../lite-http.mjs';
import liteServer from '../lite-server.mjs';

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));

// 用户级试验命令：每个用例通过公共登记入口创建，卷复位后不会残留。
const TST_PATH = '/mock/bin/tst';
let tstCommand;
const tstImpl = {
    run(_argv, _ctx, child) {
        queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('tst-ok\n'));
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        });
    },
    runSync() { return { status: 0, stdout: 'tst-ok\n', stderr: '' }; },
};

// 逐用例装配：内存卷 + spawn 边界（命令执行寻址须卷内 /mock-cmd 系统卷——惰性安装覆盖）
function setup() {
  liteFs.mock({ exclude: [EXCLUDED] });
  liteChildProcess.mock();
  tstCommand = mgr.defineUserCommand('tst', tstImpl);
  return () => {
    liteChildProcess.unmock();
    liteFs.unmock();
  };
}

/** 场景：系统卷已安装后导入命令模块，导入登记即时补齐命令文件。 */
test('晚定义落卷：导入 Git 模块后命令文件立即补齐并可执行', async () => {
  const done = setup();
  try {
    // 输入：安装系统卷后首次导入 Git 命令模块
    assert.equal(liteChildProcess.spawnSync('/bin/echo', ['install']).status, 0, '公共执行入口应触发系统卷安装');
    assert.equal(mgr.command('git'), null, '导入前 Git 尚未登记');
    assert.equal(liteChildProcess.spawnSync('git').error?.code, 'ENOENT', '命令文件缺失时不可执行');
    gitModule = await import('../lite-cmd-git.mjs');
    // 预期：模块完成登记后即刻补文件，执行入口能找到 Git 实现
    assert.equal(liteFs.existsSync('/mock-cmd/usr/bin/git'), true, '晚登记应立即补齐命令文件');
    assert.equal(liteChildProcess.spawnSync('git', ['--version']).error, undefined, '晚登记命令应可执行');
  } finally { done(); }
});

/** 场景：模块只公开用户操作入口，内部协作名称使用 pkg_，mock 不暴露私有实现。 */
test('方法隔离：公共接口、内部名称与私有实现边界', () => {
  // 输入：读取各模块的公共门面与导出列表，不执行内部协作方法
  for (const [owner, names] of [[mgr, ['defineCommand', 'resolve', 'install', 'f_install', '_defineCommand', '_resolve']],
    [liteChildProcess, ['signal', '_signal']], [liteServer, ['handle', 'listening', 'liveRequests', '_handle', 'f_liveRequests']],
    [processModule.liteProcess, ['installArgv']]]) {
    for (const name of names) assert.equal(owner[name], undefined, `${name} 不应作为公共方法暴露`);
  }
  assert.equal(processModule.commandContext, undefined, '命令上下文应使用内部导出名');
  assert.equal(processModule._commandContext, undefined, '旧内部前缀应移除');
  assert.ok(Object.keys(processModule).every(name => !name.startsWith('f_')), '文件私有绑定不应导出');
  assert.deepEqual(Object.keys(gitModule), [], 'git 模块只负责导入登记，不导出执行条目');
  assert.ok(Object.keys(nodeModule).every(name => name.startsWith('pkg_')), 'node 的命令表与路径仅供内部协作');
  assert.ok(Object.keys(osModule).every(name => name.startsWith('pkg_')), 'os 的命令表仅供内部协作');
  // 预期：mock 返回公共门面，调用方不能经返回值取得私有实现
  liteFs.mock({ exclude: [EXCLUDED] });
  try {
    assert.equal(liteFs.mock(), liteFs, 'fs mock 应返回公共门面');
    assert.equal(liteChildProcess.mock(), liteChildProcess, 'child_process mock 应返回公共门面');
    assert.equal(liteHttp.mock(), liteHttp, 'http mock 应返回公共门面');
    assert.equal(liteServer.mock(), liteServer, 'server mock 应返回公共门面');
    assert.equal(processModule.liteProcess.mock({ cwd: '/mock/interface' }), processModule.liteProcess, 'process mock 应返回公共门面');
    assert.equal(liteFs.fdInUse, undefined, '旧描述符管理名称不应暴露');
    assert.equal(liteFs.f_fdInUse, undefined, '文件私有描述符管理方法不应通过门面暴露');
  } finally {
    processModule.liteProcess.unmock(); liteServer.unmock(); liteHttp.unmock(); liteChildProcess.unmock(); liteFs.unmock();
  }
});

/** 场景：命令对象统一承载公开配置，执行层协作方法以 pkg_ 标识包内用途。 */
test('接口约定：command 对象公开 inject/onRun，内部执行方法使用 pkg_', () => {
  const done = setup();
  try {
    // 输入：按命令名取得配置句柄，不直接调用内部执行方法
    const command = mgr.command('tst');
    assert.equal(typeof command.inject, 'function', '命令对象应公开 inject');
    assert.equal(typeof command.onRun, 'function', '命令对象应公开 onRun');
    assert.equal(mgr.inject, undefined, 'mgr 不应再公开 inject');
    assert.equal(command.takeFault, undefined, '旧 takeFault 名称应移除');
    assert.equal(command.runSync, undefined, '旧句柄 runSync 名称应移除');
    assert.equal(command.impl, undefined, '原始实现应使用包内属性名');
    for (const name of ['_impl', '_script', '_takeFault', '_runSync']) {
      assert.equal(command[name], undefined, `${name} 的旧前缀不应继续暴露`);
    }
    // 预期：公共执行入口仍能运行登记的实现
    assert.equal(liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' }).stdout, 'tst-ok\n', '公共执行入口应正常分派');
  } finally { done(); }
});

/** 场景：异步执行在等待前消费 once，持续故障保留至显式移除。 */
test('故障领取：once 在闸门等待前消费，持续故障保留至移除', async () => {
  const done = setup();
  let release;
  try {
    // 输入：排入一次性等待与持续故障，通过 spawn 触发，不调用内部领取方法
    const entry = mgr.defineUserCommand('take-fault-probe', { runSync() { return { status: 0 }; } });
    const gate = new Promise(resolve => { release = resolve; });
    const removeOnce = entry.inject({ wait: gate, exit: 4, once: true });
    const removePersistent = entry.inject({ exit: 5 });
    const first = liteChildProcess.waitForClose(liteChildProcess.spawn('take-fault-probe'));
    await new Promise(resolve => queueMicrotask(resolve));
    // 预期 1：首个调用仍在等待时，后续调用已命中持续故障
    assert.equal(liteChildProcess.spawnSync('take-fault-probe').status, 5, 'once 应在等待前消费');
    removeOnce();
    assert.equal(liteChildProcess.spawnSync('take-fault-probe').status, 5, '移除已消费规则不应影响后续故障');
    removePersistent();
    // 预期 2：移除持续故障后恢复内置执行，原等待调用仍保留退出配置
    assert.equal(liteChildProcess.spawnSync('take-fault-probe').status, 0, '移除后应恢复内置执行');
    release();
    assert.deepEqual(await first, { code: 4, signal: null }, '等待结束应使用已领取的故障');
  } finally { release?.(); done(); }
});

/** 场景：用户命令登记后可按名称或路径配置，并通过公共执行入口调用。 */
test('命令登记：defined 含完整路径，command 按名称与路径返回同一句柄', () => {
  const done = setup();
  try {
    // 输入：setup 通过 defineUserCommand 登记专用命令
    assert.ok(mgr.defined().includes(TST_PATH), '登记名单应含完整路径');
    assert.equal(mgr.command('tst'), tstCommand, '裸名应寻址到登记句柄');
    assert.equal(mgr.command(TST_PATH), tstCommand, '完整路径应寻址到登记句柄');
    // 预期：无效用户命令名与实现通过公共入口拒绝
    assert.throws(() => mgr.defineUserCommand('/usr/local/bin/nope', { runSync() {} }), /裸命令名/, '带路径名称应拒绝');
    assert.throws(() => mgr.defineUserCommand('nope2', null), /impl/, '非法 impl 应拒绝');
  } finally { done(); }
});

/** 场景：公共执行入口自动安装系统命令，重复执行不会覆盖已有命令文件。 */
test('自动安装：执行命令建系统卷，重复执行保留文件与用户命令', () => {
  const done = setup();
  try {
    // 输入：只调用公共子进程接口，不直接访问文件私有安装方法
    const first = liteChildProcess.spawnSync('/bin/echo', ['installed'], { encoding: 'utf8' });
    // 预期 1：系统命令已安装并可执行，用户命令仍在卷内
    assert.equal(first.stdout, 'installed\n', '公共执行入口应自动完成安装');
    assert.equal(liteFs.statSync(TST_PATH).isFile(), true, '用户命令文件应保留');
    for (const filename of ['/mock-cmd/usr/bin/git', '/mock-cmd/usr/local/bin/node', '/mock-cmd/bin/ls']) {
      assert.equal(liteFs.statSync(filename).isFile(), true, '系统命令文件应已安装');
    }
    // 输入：修改系统命令文件内容，再通过公共入口重复执行
    liteFs.writeFileSync('/mock-cmd/bin/echo', 'installation-marker');
    const second = liteChildProcess.spawnSync('/bin/echo', ['again'], { encoding: 'utf8' });
    // 预期 2：重复执行正常，已有命令文件内容不会被重装清空
    assert.equal(second.stdout, 'again\n', '重复执行应继续正常分派');
    assert.equal(liteFs.readFileSync('/mock-cmd/bin/echo', 'utf8'), 'installation-marker', '已有命令文件不应被覆盖');
    assert.equal(mgr.install, undefined, '安装方法不应作为公共入口导出');
    assert.equal(mgr.f_install, undefined, '文件私有安装方法不应挂到门面上');
  } finally { done(); }
});

/** 场景：惰性安装——执行寻址首次未命中且卷内尚无 /mock-cmd 时自动 install 后重试，世界无须显式装。 */
test('惰性安装：执行入口自动落系统卷并命中', () => {
  const done = setup();
  try {
    // 输入：新卷（未显式 install）直接执行 git
    const hit = liteChildProcess.spawnSync('git', ['--version']);
    // 预期 1：执行寻址命中（惰性安装后重试成功）
    assert.equal(hit.error, undefined, '惰性安装后应找到已登记命令');
    // 预期 2：系统卷文件确已落卷
    assert.equal(liteFs.existsSync('/mock-cmd/usr/bin/git'), true, '系统卷应已惰性安装');
  } finally {
    done();
  }
});

/** 场景：执行入口按 PATH 寻址，用户命令优先于系统命令，绝对路径映射至系统卷。 */
test('PATH 解析：用户命令优先，绝对路径映射与命名空间路径均可执行', () => {
  const done = setup();
  try {
    // 输入：先观察系统 echo，再登记同名用户命令
    const run = command => liteChildProcess.spawnSync(command, ['probe'], { encoding: 'utf8' });
    assert.equal(run('echo').stdout, 'probe\n', '裸名应找到系统命令');
    mgr.defineUserCommand('echo', { runSync() { return { status: 0, stdout: 'user-first\n' }; } });
    // 预期：裸名命中用户命令，显式系统路径仍运行系统实现
    assert.equal(run('echo').stdout, 'user-first\n', '用户命令应优先');
    assert.equal(run('/bin/echo').stdout, 'probe\n', '绝对路径应映射到系统卷');
    assert.equal(run('/mock-cmd/bin/echo').stdout, 'probe\n', '命名空间路径应原样执行');
    assert.equal(mgr.command('node').path, '/mock-cmd/usr/local/bin/node', 'node 配置句柄应位于 usr/local/bin');
    assert.equal(mgr.command('git').path, '/mock-cmd/usr/bin/git', 'git 配置句柄应位于 usr/bin');
  } finally { done(); }
});

/** 场景：未注册命令执行报 ENOENT——未定义命令（裸名/绝对路径）与文件被删的已定义命令都未命中。 */
test('执行失败：未定义命令与文件缺失的已定义命令', () => {
  const done = setup();
  try {
    // 输入：执行未定义的裸名（惰性安装已触发后仍未命中）
    // 预期 1：裸名未定义 → ENOENT
    assert.equal(liteChildProcess.spawnSync('whatever').error?.code, 'ENOENT', '未定义裸名应返回 ENOENT');
    // 预期 2：绝对路径未定义 → ENOENT
    assert.equal(liteChildProcess.spawnSync('/usr/bin/whatever').error?.code, 'ENOENT', '未定义绝对路径应返回 ENOENT');
    // 输入：删除已定义命令的卷内文件后按完整路径执行
    liteFs.rmSync(TST_PATH);
    // 预期 3：文件缺失的已定义命令未命中（命中须文件存在且已定义——系统卷已在卷内，不重装）
    assert.equal(liteChildProcess.spawnSync(TST_PATH).error?.code, 'ENOENT', '文件缺失的已定义命令应未命中');
    // 输入：补回文件节点（持久根按卷内现状快照——收尾补回，避免删除态被带入后续用例的卷）
    liteFs.writeFileSync(TST_PATH, '');
  } finally {
    done();
  }
});

/** 场景：系统卷持久——/mock-cmd 为 lite-fs 持久根：卷复位（unmock+mock）后命令文件存活，用户数据清零。 */
test('系统卷持久：卷复位后 /mock-cmd 仍在、用户数据被清、命令继续可执行', () => {
  const done = setup();
  try {
    // 输入：装系统卷并写用户数据，随后卷复位（unmock + mock 重建）
    assert.equal(liteChildProcess.spawnSync('/bin/echo', ['install']).status, 0, '公共执行入口应触发系统卷安装');
    liteFs.mkdirSync('/mock/data', { recursive: true });
    liteFs.writeFileSync('/mock/data/x.txt', 'user');
    liteFs.unmock();
    liteFs.mock({ exclude: [EXCLUDED] });
    // 预期 1：/mock-cmd 命令文件跨卷复位存活（持久根语义——核心断言）
    assert.equal(liteFs.existsSync('/mock-cmd/usr/bin/git'), true, '/mock-cmd 应跨卷复位存活');
    // 预期 2：用户数据目录被清空（由世界自播种）
    assert.equal(liteFs.existsSync('/mock/data'), false, '非持久根的用户数据应被清空');
    // 预期 3：命令继续可执行（执行寻址直接命中，无须重装）
    const r = liteChildProcess.spawnSync('/bin/echo', ['persistent'], { encoding: 'utf8' });
    assert.equal(r.status, 0, '卷复位后命令应继续可执行');
    assert.equal(r.stdout, 'persistent\n', '系统命令回包应为内置实现内容');
  } finally {
    done();
  }
});

/** 场景：持久根通用机制——markPersistent 登记任意根跨卷存活；卷内缺席的持久根恢复后仍缺席。 */
test('markPersistent：自定义持久根跨卷存活、缺席根保持缺席', () => {
  // 输入：登记自定义持久根（lite-fs 不认识具体根——通用机制）
  liteFs.markPersistent('/keep');
  liteFs.markPersistent('/absent-root');
  const done = setup();
  try {
    liteFs.mkdirSync('/keep/sub', { recursive: true });
    liteFs.writeFileSync('/keep/sub/f.txt', 'kept');
    liteFs.mkdirSync('/mock/data', { recursive: true });
    liteFs.unmock();
    liteFs.mock({ exclude: [EXCLUDED] });
    // 预期 1：持久根内容跨卷复位存活
    assert.equal(liteFs.readFileSync('/keep/sub/f.txt', 'utf8'), 'kept', '持久根内容应存活');
    // 预期 2：非持久根被清空
    assert.equal(liteFs.existsSync('/mock/data'), false, '非持久根应被清空');
    // 预期 3：卷内缺席的持久根恢复后仍缺席（快照为 null，不凭空造根）
    assert.equal(liteFs.existsSync('/absent-root'), false, '缺席的持久根应保持缺席');
  } finally {
    done();
  }
});

/** 场景：inject exit 替换——命中后回包整体替换为失败包（status=exit、stdout 空、stderr 附带）。 */
test('inject exit：同步面回包替换、异步面退出码替换', async () => {
  const done = setup();
  let remove = null;
  try {
    // 输入：对试验命令注入 exit 故障后 spawnSync
    remove = mgr.command('tst').inject({ exit: 5, stderr: 'boom\n' });
    const sync = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    // 预期 1：status 替换为注入的 exit
    assert.equal(sync.status, 5, 'status 应替换为注入的 exit');
    // 预期 2：stdout 清空（失败包不带原实现输出）
    assert.equal(sync.stdout, '', 'stdout 应为空');
    // 预期 3：stderr 为注入内容
    assert.equal(sync.stderr, 'boom\n', 'stderr 应为注入内容');
    // 输入：异步面 spawn 同一故障命令
    const child = liteChildProcess.spawn('tst', []);
    const closed = await liteChildProcess.waitForClose(child);
    // 预期 4：异步面按注入 exit 收场（无 wait 即异步直回）
    assert.equal(closed.code, 5, '异步面应按注入 exit 收场');
    // 输入：调移除函数后再次执行
    remove();
    remove = null;
    const clean = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    // 预期 5：移除故障后回内置实现
    assert.equal(clean.status, 0, '移除后应回内置实现');
    assert.equal(clean.stdout, 'tst-ok\n', '移除后 stdout 应为内置实现内容');
  } finally {
    if (remove) remove();
    done();
  }
});

/** 场景：inject wait 闸门——异步面命中后挂起，闸门放行再按 exit 收场；同步面无法阻塞、直接回失败包。 */
test('inject wait：异步面闸门放行后收场、同步面直接回包', async () => {
  const done = setup();
  let remove = null;
  try {
    // 输入：注入 wait 闸门（未放行）故障后 spawn
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    remove = mgr.command('tst').inject({ wait: gate, exit: 4 });
    const child = liteChildProcess.spawn('tst', []);
    let closed = null;
    liteChildProcess.waitForClose(child).then((r) => { closed = r; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 预期 1：闸门未放行前子进程不收场
    assert.equal(closed, null, '闸门期间不应收场');
    // 输入：放行闸门
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 预期 2：放行后按注入 exit 收场
    assert.deepEqual(closed, { code: 4, signal: null }, '放行后应按注入 exit 收场');
    // 输入：同一 wait 故障在同步面执行（无法阻塞事件循环——闸门不适用）
    const sync = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    // 预期 3：同步面直接回失败包（不挂起）
    assert.equal(sync.status, 4, '同步面应直接回失败包');
  } finally {
    if (remove) remove();
    done();
  }
});

/** 场景：inject once——命中即毁：首次执行回失败包，后续执行回内置实现。 */
test('inject once：命中即毁', () => {
  const done = setup();
  try {
    // 输入：注入 once 故障后连续两次 spawnSync
    mgr.command('tst').inject({ exit: 7, once: true });
    const first = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    const second = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    // 预期 1：首次命中失败包
    assert.equal(first.status, 7, '首次应命中注入故障');
    // 预期 2：once 命中即毁，第二次回内置实现
    assert.equal(second.status, 0, '第二次应回内置实现');
    assert.equal(second.stdout, 'tst-ok\n', '第二次 stdout 应为内置实现内容');
  } finally {
    done();
  }
});

/** 场景：inject 句柄形态与命中顺序——command(path).inject 同一入口；多条故障按注入序命中、移除后让位。 */
test('inject 句柄形态与命中顺序：command().inject、按注入序、移除让位', () => {
  const done = setup();
  let removeA = null;
  try {
    // 输入：完整路径与裸名取得同一命令对象，依次注入 A、B（持续）
    removeA = mgr.command(TST_PATH).inject({ exit: 5 });
    const removeB = mgr.command('tst').inject({ exit: 8 });
    const first = liteChildProcess.spawnSync('tst', []);
    // 预期 1：按注入序首条（A）命中
    assert.equal(first.status, 5, '首条注入应先命中');
    // 输入：移除 A 后再执行
    removeA();
    removeA = null;
    const second = liteChildProcess.spawnSync('tst', []);
    // 预期 2：移除 A 后由 B 命中
    assert.equal(second.status, 8, '移除后应由后续注入命中');
    // 输入：移除 B 后再执行
    removeB();
    const third = liteChildProcess.spawnSync('tst', []);
    // 预期 3：全部移除后回内置实现
    assert.equal(third.status, 0, '全部移除后应回内置实现');
  } finally {
    if (removeA) removeA();
    done();
  }
});

/** 场景：非法 fault 拒绝——exit 缺席且无 wait、exit 0/负数/非整、wait 非 Promise、stderr 非串、非对象。 */
test('inject 非法 fault：各非法形态逐一拒绝', () => {
  const done = setup();
  try {
    // 输入：逐个非法形态注入（exit 须 ≥1 或 wait 为 Promise——不允许成功回包替换）
    // 预期 1：空对象拒绝（exit 与 wait 均缺席）
    assert.throws(() => mgr.command('tst').inject({}), /exit.*wait|wait.*exit/, '空对象应拒绝');
    // 预期 2：exit 0 拒绝（不允许成功回包替换）
    assert.throws(() => mgr.command('tst').inject({ exit: 0 }), /≥1/, 'exit 0 应拒绝');
    // 预期 3：exit 负数拒绝
    assert.throws(() => mgr.command('tst').inject({ exit: -2 }), /≥1/, 'exit 负数应拒绝');
    // 预期 4：exit 非整数拒绝
    assert.throws(() => mgr.command('tst').inject({ exit: 'x' }), /≥1/, 'exit 非整数应拒绝');
    // 预期 5：wait 非 Promise 拒绝
    assert.throws(() => mgr.command('tst').inject({ wait: 5 }), /Promise/, 'wait 非 Promise 应拒绝');
    // 预期 6：stderr 非字符串拒绝
    assert.throws(() => mgr.command('tst').inject({ exit: 3, stderr: 5 }), /stderr/, 'stderr 非字符串应拒绝');
    // 预期 7：非对象拒绝
    assert.throws(() => mgr.command('tst').inject(null), /fault/, 'null 应拒绝');
    // 预期 8：未登记命令返回 null，没有可用于注入的命令对象
    assert.equal(mgr.command('no-such-cmd'), null, '未登记命令不应返回配置对象');
  } finally {
    done();
  }
});

/** 场景：用户级临时命令 register——落 /mock/bin、PATH 序在系统命令之前可遮蔽、卷复位即清。 */
test('register：用户级临时命令可执行、遮蔽系统同名、卷复位即清', async () => {
  // 输入：建卷（setup 统一 mock lite-fs + lite-child_process）后注册用户级 hello 与遮蔽系统的 node
  const done = setup();
  try {
    mgr.defineUserCommand('hello', { runSync: () => ({ status: 0, stdout: 'hi from user\n' }) });
    const shadow = mgr.defineUserCommand('node', { runSync: () => ({ status: 0, stdout: 'shadowed\n' }) });
    const hello = liteChildProcess.spawnSync('hello', [], { encoding: 'utf8' });
    // 预期 1：用户级命令经 PATH 解析可执行
    assert.equal(hello.status, 0, '用户级命令应可执行');
    // 预期 2：回包来自用户实现
    assert.equal(hello.stdout, 'hi from user\n', '回包应来自用户实现');
    // 输入：请求系统命令 node -v（被用户级遮蔽）
    const masked = liteChildProcess.spawnSync('node', ['-v'], { encoding: 'utf8' });
    // 预期 3：PATH 用户级在前——同名系统命令被遮蔽
    assert.equal(masked.stdout, 'shadowed\n', '用户级应遮蔽同名系统命令');
    // 预期 4：用户命令文件落 /mock/bin（非 /mock-cmd 系统卷）
    assert.equal(liteFs.existsSync('/mock/bin/hello'), true, '用户命令文件应落 /mock/bin');
    assert.equal(liteFs.existsSync('/mock-cmd/usr/local/bin/node'), true, '系统卷 node 文件不受影响');
    // 输入：卷复位（unmock+mock 重建用户数据域）
    liteFs.unmock();
    liteFs.mock({ exclude: [EXCLUDED] });
    // 预期 5：系统卷存活（node 恢复系统实现）
    const restored = liteChildProcess.spawnSync('node', ['-v'], { encoding: 'utf8' });
    assert.equal(restored.stdout.trim(), process.version, '卷复位后系统 node 应恢复（遮蔽解除）');
    // 预期 6：用户级命令文件已清（resolve 未命中 → ENOENT）
    const gone = liteChildProcess.spawnSync('hello', [], {});
    assert.equal(gone.status, null, '卷复位后用户命令应 ENOENT（临时注册随卷清除）');
    assert.equal(gone.error.code, 'ENOENT', '错误应为 ENOENT');
    // 清理：遮蔽条目残留注册表但文件已清——惰性失活，无须额外清理
  } finally {
    done();
  }
});

/** 场景：register 前置校验——裸名、impl 对象、须先 mock lite-fs。 */
test('register 校验：裸名/impl/先 mock lite-fs', async () => {
  // 输入：带路径的名字注册
  // 预期 1：拒绝（须裸命令名）
  assert.throws(() => mgr.defineUserCommand('/mock/bin/x', {}), /裸命令名/, '带路径名应拒绝');
  // 输入：未 mock lite-fs 时注册
  liteFs.unmock();
  // 预期 2：拒绝（命令文件落内存卷）
  assert.throws(() => mgr.defineUserCommand('x', {}), /先 mock/, '未 mock lite-fs 应拒绝');
});

