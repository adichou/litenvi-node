// lite-cmd-mgr 门面用例（node:test 形态，可 `node --test` 或直跑）：命令模拟内核——/mock-cmd/
// 命名空间的命令登记（defineCommand：完整路径 + impl 句柄）、系统卷安装（install 幂等 /
// resolve 惰性安装 / lite-fs 持久根跨卷复位存活）、PATH 解析与绝对路径前缀映射、统一故障注入
//（exit 替换 / wait 闸门 / once 自毁 / 非法 fault 拒绝 / 移除函数）。命令集 lite-cmd-git/
// -node/-os 导入即登记（本文件导入以覆盖真实命令面）；试验命令 tst 为本文件专用（故障挂
// 在条目上跨用例共享，专用命令不污染真实命令）。用例注释格式：方法级写测试场景；语句中
//「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mgr from '../lite-cmd-mgr.mjs';
import liteFs from '../lite-fs.mjs';
import liteChildProcess from '../lite-child_process.mjs';
import '../lite-cmd-git.mjs'; // 导入即登记

const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));

// 试验命令（本文件专用）：故障注入与解析用例不落在真实命令条目上
const TST_PATH = '/mock-cmd/bin/tst';
const tstCommand = mgr.defineCommand(TST_PATH, {
    run(_argv, _ctx, child) {
        queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('tst-ok\n'));
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
        });
    },
    runSync() { return { status: 0, stdout: 'tst-ok\n', stderr: '' }; },
});

// 逐用例装配：内存卷 + spawn 边界（命令执行寻址须卷内 /mock-cmd 系统卷——惰性安装覆盖）
function setup() {
  liteFs.mock({ exclude: [EXCLUDED] });
  liteChildProcess.mock();
  return () => {
    liteChildProcess.unmock();
    liteFs.unmock();
  };
}

/** 场景：条目只领取故障配置，once 在领取时消费，持续故障保留至显式移除。 */
test('takeFault：只领取配置、once 立即消费、持续故障按序保留', () => {
  const done = setup();
  try {
    // 输入：为用户命令依次安装一次性 wait 故障与持续故障
    const entry = mgr.defineUserCommand('take-fault-probe', { runSync() { return { status: 0 }; } });
    const gate = new Promise(() => {});
    const once = { wait: gate, exit: 4, once: true };
    const persistent = { exit: 5 };
    const removeOnce = entry.inject(once);
    const removePersistent = entry.inject(persistent);
    // 预期 1：领取返回原始故障对象，不等待未完成的闸门
    assert.equal(entry.takeFault(), once, '应直接返回故障配置');
    // 预期 2：once 已在领取时消费，下一次立即领取后续故障
    assert.equal(entry.takeFault(), persistent, 'once 应只被领取一次');
    // 输入：移除已经领取的 once，不应误删后续配置
    removeOnce();
    // 预期 3：持续故障仍可再次领取
    assert.equal(entry.takeFault(), persistent, '持续故障应保留至移除');
    // 输入：显式移除持续故障
    removePersistent();
    // 预期 4：配置清空后领取结果为 null
    assert.equal(entry.takeFault(), null, '无故障时应返回 null');
    // 预期 5：条目不再承担异步调度
    assert.equal(entry.run, undefined, '异步调度应集中在 child_process');
  } finally {
    done();
  }
});

/** 场景：命令登记——defineCommand 落注册表，command() 按名/完整路径寻址同一句柄；命名空间外路径拒绝。 */
test('命令登记：defined() 含完整路径、command() 名字与路径寻址同句柄、命名空间外拒绝', () => {
  // 输入：defineCommand 已在模块装载时登记试验命令；读注册表与句柄
  // 预期 1：defined() 名单含完整路径
  assert.ok(mgr.defined().includes(TST_PATH), '登记名单应含完整路径');
  // 预期 2：裸名按 PATH 解析到同一句柄（bin 目录）
  assert.equal(mgr.command('tst'), tstCommand, '裸名应寻址到登记句柄');
  // 预期 3：完整路径直接命中同一句柄
  assert.equal(mgr.command(TST_PATH), tstCommand, '完整路径应寻址到登记句柄');
  // 预期 4：impl 双面在句柄上可寻址（run/runSync）
  assert.equal(typeof tstCommand.impl.run, 'function', 'impl.run 应可寻址');
  assert.equal(typeof tstCommand.impl.runSync, 'function', 'impl.runSync 应可寻址');
  // 输入：命名空间外的路径与非法 impl 登记尝试
  // 预期 5：命名空间外路径拒绝
  assert.throws(() => mgr.defineCommand('/usr/local/bin/nope', { runSync() {} }), /mock-cmd/, '命名空间外路径应拒绝');
  // 预期 6：非 impl 对象拒绝
  assert.throws(() => mgr.defineCommand('/mock-cmd/bin/nope2', null), /impl/, '非法 impl 应拒绝');
});

/** 场景：系统卷安装——install() 在卷内建全部命令文件节点；幂等重装不抛错；lite-fs 未 mock 时拒绝。 */
test('install：卷内落命令文件、幂等、未 mock 时拒绝', () => {
  // 输入：未 mock 状态直接 install
  // 预期 1：拒绝并提示先 mock（防向真实磁盘根写 /mock-cmd）
  assert.throws(() => mgr.install(), /先 mock/, '未 mock 时 install 应拒绝');
  const done = setup();
  try {
    // 输入：mock 后显式 install
    mgr.install();
    // 预期 2：试验命令文件在卷内（普通文件）
    assert.equal(liteFs.statSync(TST_PATH).isFile(), true, 'install 后命令文件应存在');
    // 预期 3：真实命令集文件同样落卷（git 在 usr/bin、node 在 usr/local/bin、ls 在 bin）
    assert.equal(liteFs.statSync('/mock-cmd/usr/bin/git').isFile(), true, 'git 命令文件应在卷');
    assert.equal(liteFs.statSync('/mock-cmd/usr/local/bin/node').isFile(), true, 'node 命令文件应在卷');
    assert.equal(liteFs.statSync('/mock-cmd/bin/ls').isFile(), true, 'ls 命令文件应在卷');
    // 输入：重复 install（幂等口径：卷内已有 /mock-cmd 即 no-op）
    mgr.install();
    // 预期 4：幂等重装不抛错且文件仍在
    assert.equal(liteFs.existsSync(TST_PATH), true, '重复 install 应幂等无害');
  } finally {
    done();
  }
});

/** 场景：惰性安装——resolve 首次未命中且卷内尚无 /mock-cmd 时自动 install 后重试，世界无须显式装。 */
test('惰性安装：新卷首次 resolve 自动落系统卷并命中', () => {
  const done = setup();
  try {
    // 输入：新卷（未显式 install）直接 resolve git
    const hit = mgr.resolve('git');
    // 预期 1：resolve 命中（惰性安装后重试成功）
    assert.equal(hit?.path, '/mock-cmd/usr/bin/git', '惰性安装后 resolve 应命中');
    // 预期 2：系统卷文件确已落卷
    assert.equal(liteFs.existsSync('/mock-cmd/usr/bin/git'), true, '系统卷应已惰性安装');
  } finally {
    done();
  }
});

/** 场景：PATH 解析与前缀映射——裸名按 usr/local/bin → usr/bin → bin 顺序搜；绝对路径映射进命名空间。 */
test('PATH 解析：裸名按目录序命中、usr/bin 先于 bin、绝对路径前缀映射、/mock-cmd 原样', () => {
  const done = setup();
  try {
    // 输入：对真实命令集各目录层的裸名 resolve
    // 预期 1：node 在 usr/local/bin（PATH 首位目录）
    assert.equal(mgr.resolve('node')?.path, '/mock-cmd/usr/local/bin/node', 'node 应命中 usr/local/bin');
    // 预期 2：git 在 usr/bin
    assert.equal(mgr.resolve('git')?.path, '/mock-cmd/usr/bin/git', 'git 应命中 usr/bin');
    // 预期 3：ls 在 bin
    assert.equal(mgr.resolve('ls')?.path, '/mock-cmd/bin/ls', 'ls 应命中 bin');
    // 预期 4：同名命令按 PATH 序取靠前目录（专用名两处登记：usr/bin 先于 bin 命中）
    mgr.defineCommand('/mock-cmd/usr/bin/path-order-probe', { runSync() { return { status: 0, stdout: '', stderr: '' }; } });
    mgr.defineCommand('/mock-cmd/bin/path-order-probe', { runSync() { return { status: 0, stdout: '', stderr: '' }; } });
    assert.equal(mgr.resolve('path-order-probe')?.path, '/mock-cmd/usr/bin/path-order-probe', 'PATH 序应取靠前目录');
    // 输入：绝对路径形态 resolve
    // 预期 5：'/usr/bin/open' 前缀映射到 /mock-cmd/usr/bin/open
    assert.equal(mgr.resolve('/usr/bin/open')?.path, '/mock-cmd/usr/bin/open', '绝对路径应前缀映射');
    // 预期 6：'/mock-cmd/usr/bin/git' 原样命中
    assert.equal(mgr.resolve('/mock-cmd/usr/bin/git')?.path, '/mock-cmd/usr/bin/git', '命名空间内路径应原样命中');
  } finally {
    done();
  }
});

/** 场景：未注册解析 null——未定义命令（裸名/绝对路径）与文件被删的已定义命令都未命中。 */
test('未命中 null：未定义命令与文件缺失的已定义命令', () => {
  const done = setup();
  try {
    // 输入：resolve 未定义的裸名（惰性安装已触发后仍未命中）
    // 预期 1：裸名未定义 → null
    assert.equal(mgr.resolve('whatever'), null, '未定义裸名应返回 null');
    // 预期 2：绝对路径未定义 → null
    assert.equal(mgr.resolve('/usr/bin/whatever'), null, '未定义绝对路径应返回 null');
    // 输入：删除已定义命令的卷内文件后按完整路径 resolve
    liteFs.rmSync(TST_PATH);
    // 预期 3：文件缺失的已定义命令未命中（命中须文件存在且已定义——系统卷已在卷内，不重装）
    assert.equal(mgr.resolve(TST_PATH), null, '文件缺失的已定义命令应未命中');
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
    mgr.install();
    liteFs.mkdirSync('/mock/data', { recursive: true });
    liteFs.writeFileSync('/mock/data/x.txt', 'user');
    liteFs.unmock();
    liteFs.mock({ exclude: [EXCLUDED] });
    // 预期 1：/mock-cmd 命令文件跨卷复位存活（持久根语义——核心断言）
    assert.equal(liteFs.existsSync('/mock-cmd/usr/bin/git'), true, '/mock-cmd 应跨卷复位存活');
    // 预期 2：用户数据目录被清空（由世界自播种）
    assert.equal(liteFs.existsSync('/mock/data'), false, '非持久根的用户数据应被清空');
    // 预期 3：命令继续可执行（执行寻址直接命中，无须重装）
    const r = liteChildProcess.spawnSync('tst', [], { encoding: 'utf8' });
    assert.equal(r.status, 0, '卷复位后命令应继续可执行');
    assert.equal(r.stdout, 'tst-ok\n', '命令回包应为内置实现内容');
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
    remove = mgr.inject('tst', { exit: 5, stderr: 'boom\n' });
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
    remove = mgr.inject('tst', { wait: gate, exit: 4 });
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
    mgr.inject('tst', { exit: 7, once: true });
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
    // 输入：句柄形态注入 A（持续），再经 mgr.inject 注入 B（持续）
    removeA = mgr.command(TST_PATH).inject({ exit: 5 });
    const removeB = mgr.inject('tst', { exit: 8 });
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
    assert.throws(() => mgr.inject('tst', {}), /exit.*wait|wait.*exit/, '空对象应拒绝');
    // 预期 2：exit 0 拒绝（不允许成功回包替换）
    assert.throws(() => mgr.inject('tst', { exit: 0 }), /≥1/, 'exit 0 应拒绝');
    // 预期 3：exit 负数拒绝
    assert.throws(() => mgr.inject('tst', { exit: -2 }), /≥1/, 'exit 负数应拒绝');
    // 预期 4：exit 非整数拒绝
    assert.throws(() => mgr.inject('tst', { exit: 'x' }), /≥1/, 'exit 非整数应拒绝');
    // 预期 5：wait 非 Promise 拒绝
    assert.throws(() => mgr.inject('tst', { wait: 5 }), /Promise/, 'wait 非 Promise 应拒绝');
    // 预期 6：stderr 非字符串拒绝
    assert.throws(() => mgr.inject('tst', { exit: 3, stderr: 5 }), /stderr/, 'stderr 非字符串应拒绝');
    // 预期 7：非对象拒绝
    assert.throws(() => mgr.inject('tst', null), /fault/, 'null 应拒绝');
    // 预期 8：未定义命令注入拒绝
    assert.throws(() => mgr.inject('no-such-cmd', { exit: 3 }), /未定义命令/, '未定义命令应拒绝');
  } finally {
    done();
  }
});

/** 场景：晚定义命令落卷——系统卷已装的世界内 defineCommand 即刻落文件，可立即执行寻址。 */
test('晚定义落卷：已装系统卷内 defineCommand 即刻可见', () => {
  const done = setup();
  try {
    // 输入：系统卷已惰性安装后，再定义新命令并立即 resolve
    mgr.resolve('git'); // 触发惰性安装
    mgr.defineCommand('/mock-cmd/bin/late', { runSync() { return { status: 3, stdout: 'late\n', stderr: '' }; } });
    // 预期 1：晚定义命令文件即刻在卷（无须下次安装）
    assert.equal(liteFs.existsSync('/mock-cmd/bin/late'), true, '晚定义命令文件应即刻落卷');
    // 预期 2：立即执行寻址命中并可执行
    const r = liteChildProcess.spawnSync('late', [], { encoding: 'utf8' });
    assert.equal(r.status, 3, '晚定义命令应立即可执行');
    assert.equal(r.stdout, 'late\n', '晚定义命令回包应为自身实现');
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

