// lite-fs 门面用例（node:test 形态，可 `node --test` 或直跑）：默认全量转发真实 node:fs；
// mock({ exclude }) 黑名单制——排除目录（模块源码等系统本体）走真实 fs，其余全部落内存卷
//（真实 fs 错误语义，越界写不可能穿透真实磁盘）；inject 注入 fs 错误；unmock 回真实实现。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteFs, { t_stageStdin, t_releaseStdin } from '../../lite-fs.mjs';

const selfFile = new URL(import.meta.url).pathname; // 系统本体文件（真实磁盘）
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/')); // 排除目录：本测试目录（真实磁盘）
const ROOT = '/data/lite-fs-root'; // 内存卷路径（真实磁盘不存在的绝对路径）

/** 场景：作用域参数前置校验——exclude 必填、已废弃的 roots 白名单口径拒绝。 */
test('exclude 必填：mock() 不带 exclude（含仅传已废弃的 roots）应拒绝', () => {
  // 输入：mock() 不带任何参数
  // 预期 1：拒绝并提示 exclude
  assert.throws(() => liteFs.t_mock(), /exclude/, '无排除目录应拒绝 mock');
  // 输入：mock() 仅传已废弃的 roots 白名单
  // 预期 2：拒绝并提示 exclude（白名单口径已废弃）
  assert.throws(() => liteFs.t_mock({ roots: [ROOT] }), /exclude/, '白名单口径已废弃应拒绝并提示 exclude');
});

/** 场景：卷内内存卷基本面——黑名单外路径的读写/追加/清单/stat 自洽。 */
test('卷内内存卷基本面：mkdir/write/read/append/readdir/stat 自洽', () => {
  // 输入：mock 黑名单后递归建目录、写入并追加内容
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(`${ROOT}/a/b`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/a/b/x.txt`, 'hello');
    liteFs.appendFileSync(`${ROOT}/a/b/x.txt`, ' lite-fs');
    // 预期 1：字符串读回写入+追加的完整内容
    assert.equal(liteFs.readFileSync(`${ROOT}/a/b/x.txt`, 'utf8'), 'hello lite-fs', '字符串读写应自洽');
    // 预期 2：无 encoding 时返回 Buffer（对齐真实 fs）
    assert.ok(Buffer.isBuffer(liteFs.readFileSync(`${ROOT}/a/b/x.txt`)), '无 encoding 应返回 Buffer');
    // 预期 3：目录清单只含写入的文件
    assert.deepEqual(liteFs.readdirSync(`${ROOT}/a/b`), ['x.txt'], '目录清单应只含写入文件');
    // 输入：对文件与目录分别 stat
    const st = liteFs.statSync(`${ROOT}/a/b/x.txt`);
    // 预期 4：文件 stat 判定 isFile
    assert.equal(st.isFile(), true, '文件 stat 应 isFile');
    // 预期 5：size 等于内容长度
    assert.equal(st.size, 'hello lite-fs'.length, 'size 应为内容长度');
    // 预期 6：目录 stat 判定 isDirectory
    assert.equal(liteFs.statSync(`${ROOT}/a/b`).isDirectory(), true, '目录 stat 应 isDirectory');
    // 预期 7：时间面与真实 fs.Stats 同构——mtime/atime/birthtime 为 Date（业务侧
    // st.mtime.toISOString() 等消费依赖；mtimeMs 数值面与 Date 毫秒一致）
    for (const key of ['mtime', 'atime', 'birthtime', 'ctime']) {
      assert.ok(st[key] instanceof Date, `stat.${key} 应为 Date（真实 Stats 同构）`);
    }
    assert.equal(st.mtime.toISOString(), new Date(st.mtimeMs).toISOString(), 'mtime 应与 mtimeMs 同时刻');
    assert.ok(typeof st.ctimeMs === 'number', 'ctimeMs 应为数值');
    const dirStat = liteFs.statSync(`${ROOT}/a/b`);
    assert.ok(dirStat.mtime instanceof Date, '目录 stat 时间面同样应为 Date');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：真实错误语义——卷内操作按 node:fs 同款错误码失败，不静默成功。 */
test('真实错误语义：ENOENT/EEXIST/ENOTDIR/ERR_FS_EISDIR/EISDIR', () => {
  // 输入：建目录并写入一个文件，作为后续错误操作的现场
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(`${ROOT}/d`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/d/f`, 'x');
    // 输入：读不存在的文件
    // 预期 1：ENOENT
    assert.throws(() => liteFs.readFileSync(`${ROOT}/missing`), e => e.code === 'ENOENT', '读缺失文件应 ENOENT');
    // 输入：向无父目录的路径写入
    // 预期 2：ENOENT
    assert.throws(() => liteFs.writeFileSync(`${ROOT}/no-such/f`, 'x'), e => e.code === 'ENOENT', '缺父目录写入应 ENOENT');
    // 输入：非递归重复建已存在目录
    // 预期 3：EEXIST
    assert.throws(() => liteFs.mkdirSync(`${ROOT}/d`), e => e.code === 'EEXIST', '非递归重复建目录应 EEXIST');
    // 输入：对文件 readdir
    // 预期 4：ENOTDIR
    assert.throws(() => liteFs.readdirSync(`${ROOT}/d/f`), e => e.code === 'ENOTDIR', '对文件 readdir 应 ENOTDIR');
    // 输入：非递归 rm 非空目录
    // 预期 5：Node 的 rmSync 未开启 recursive 时对目录报 ERR_FS_EISDIR
    assert.throws(() => liteFs.rmSync(`${ROOT}/d`), e => e.code === 'ERR_FS_EISDIR', '非递归 rm 目录应 ERR_FS_EISDIR');
    // 输入：对目录 unlink
    // 预期 6：EISDIR
    assert.throws(() => liteFs.unlinkSync(`${ROOT}/d`), e => e.code === 'EISDIR', '对目录 unlink 应 EISDIR');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：树操作——rename/copyFile/cp 递归/rm 递归在卷内自洽。 */
test('移动/复制/递归删除：rename/copyFile/cp -r/rm -r 树操作自洽', () => {
  // 输入：建子树（子目录含文件 + 根下另一文件）后依次 rename、copyFile、cp 递归、rm 递归
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(`${ROOT}/t/sub`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/t/sub/a`, '1');
    liteFs.writeFileSync(`${ROOT}/t/b`, '2');
    liteFs.renameSync(`${ROOT}/t/b`, `${ROOT}/t/c`);
    // 预期 1：rename 后目标路径内容保留
    assert.equal(liteFs.readFileSync(`${ROOT}/t/c`, 'utf8'), '2', 'rename 后内容应保留');
    // 输入：copyFile 单文件复制、cpSync 递归复制子树
    liteFs.copyFileSync(`${ROOT}/t/c`, `${ROOT}/t/d`);
    liteFs.cpSync(`${ROOT}/t/sub`, `${ROOT}/t/copy`);
    // 预期 2：cp 递归复制了子树内容
    assert.equal(liteFs.readFileSync(`${ROOT}/t/copy/a`, 'utf8'), '1', 'cp 递归应复制子树');
    // 输入：rm 递归删除整棵子树
    liteFs.rmSync(`${ROOT}/t`, { recursive: true, force: true });
    // 预期 3：递归删除后根路径不存在
    assert.equal(liteFs.existsSync(`${ROOT}/t`), false, '递归删除后应不存在');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：fd 面——openSync 打开即建、closeSync 释放、重复 close 报 EBADF。 */
test('fd 面：openSync(a)/closeSync、内容可读、坏 fd EBADF', () => {
  // 输入：建根目录后 openSync('a') 打开新文件、追加一行、close 释放
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    const fd = liteFs.openSync(`${ROOT}/log.txt`, 'a');
    // 预期 1：openSync 返回数字 fd
    assert.equal(typeof fd, 'number', 'openSync 应返回 fd');
    // 输入：经 appendFileSync 追加内容后关闭 fd
    liteFs.appendFileSync(`${ROOT}/log.txt`, 'line');
    liteFs.closeSync(fd);
    // 预期 2：打开即建的文件可读回追加内容
    assert.equal(liteFs.readFileSync(`${ROOT}/log.txt`, 'utf8'), 'line', '打开即建的文件应可读写');
    // 输入：对已关闭的 fd 再次 closeSync
    // 预期 3：EBADF
    assert.throws(() => liteFs.closeSync(fd), e => e.code === 'EBADF', '重复 close 应 EBADF');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：fd 定位读——readSync 按显式 position 从卷内文件切片回填，坏 fd EBADF。 */
test('fd 面：readSync 按 position 定位读、越界截断与坏 fd EBADF', () => {
  // 输入：写入 10 字节种子文件，openSync('r') 取 fd
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/data.bin`, '0123456789');
    const fd = liteFs.openSync(`${ROOT}/data.bin`, 'r');
    // 预期 1：position 4 读 3 字节返回 '456'（字节偏移从 0 起），返回值为实际读取长度
    const buf1 = Buffer.alloc(8);
    assert.equal(liteFs.readSync(fd, buf1, 0, 3, 4), 3, 'readSync 应返回实际读取字节数');
    assert.equal(buf1.subarray(0, 3).toString(), '456', 'position 定位读应取到指定切片');
    // 预期 2：position 越界读 0 字节（对齐真实 fs 文件末尾语义）
    const buf2 = Buffer.alloc(3);
    assert.equal(liteFs.readSync(fd, buf2, 0, 3, 99), 0, '越界 position 应读 0 字节');
    // 输入：close 后对坏 fd 再读
    liteFs.closeSync(fd);
    // 预期 3：EBADF
    assert.throws(() => liteFs.readSync(fd, Buffer.alloc(3), 0, 3, 0), e => e.code === 'EBADF', '坏 fd 读取应 EBADF');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：错误注入——inject 只拦命中操作与路径，撤销后恢复。 */
test('错误注入：对写入路径注入 EACCES 只拦写入、读取不受影响、撤销恢复', () => {
  // 输入：建文件写入种子内容，对 writeFileSync+该路径注入 EACCES
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/f`, 'seed');
    const remove = liteFs.t_inject({ op: 'writeFileSync', path: `${ROOT}/f`, code: 'EACCES' });
    // 预期 1：命中注入的写入抛 EACCES
    assert.throws(() => liteFs.writeFileSync(`${ROOT}/f`, 'x'), e => e.code === 'EACCES', '命中注入的写入应抛 EACCES');
    // 预期 2：读取不受写入注入影响（种子内容仍在）
    assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'seed', '读取不受写入注入影响');
    // 输入：调用移除函数撤销注入后重新写入
    remove();
    liteFs.writeFileSync(`${ROOT}/f`, 'ok');
    // 预期 3：撤销后写入恢复正常
    assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'ok', '撤销注入后写入应恢复');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：谓词注入——matches(target) 动态判定命中面，撤销后恢复（exact path 之外的动态口径）。 */
test('错误注入：matches 谓词按目标动态命中、其余目标不受影响', () => {
  // 输入：两个文件，注入仅命中 /hit 前缀的谓词
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    liteFs.mkdirSync(`${ROOT}/hit`, { recursive: true });
    liteFs.mkdirSync(`${ROOT}/miss`, { recursive: true });
    const remove = liteFs.t_inject({ op: 'writeFileSync', matches: (target) => String(target).startsWith(`${ROOT}/hit`), code: 'EIO' });
    // 预期 1：命中谓词的写入抛 EIO
    assert.throws(() => liteFs.writeFileSync(`${ROOT}/hit/a`, 'x'), e => e.code === 'EIO', '谓词命中的写入应抛注入错误');
    // 预期 2：未命中谓词的写入正常
    liteFs.writeFileSync(`${ROOT}/miss/a`, 'ok');
    assert.equal(liteFs.readFileSync(`${ROOT}/miss/a`, 'utf8'), 'ok', '谓词未命中的写入应正常');
    // 输入：撤销谓词注入
    remove();
    liteFs.writeFileSync(`${ROOT}/hit/a`, 'ok');
    // 预期 3：撤销后命中路径写入恢复
    assert.equal(liteFs.readFileSync(`${ROOT}/hit/a`, 'utf8'), 'ok', '撤销谓词后写入应恢复');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：error 实例注入——预制错误按原样抛出（自定义文案与 code 字段保留），code 与 error 二选一。 */
test('错误注入：error 实例按原样抛出、code 与 error 二选一', () => {
  // 输入：mock 后写种子文件，注入仅携带 error 实例（无 code 字段）
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/f`, 'seed');
    const injected = Object.assign(new Error('注入的文件写入失败'), { code: 'EIO', syscall: 'writeFileSync' });
    const remove = liteFs.t_inject({ op: 'writeFileSync', path: `${ROOT}/f`, error: injected });
    // 预期 1：命中注入的写入原样抛出同一错误实例（文案、code 与附加字段均保留）
    assert.throws(() => liteFs.writeFileSync(`${ROOT}/f`, 'x'), e => e === injected, '命中注入的写入应原样抛出预制错误实例');
    assert.equal(injected.message, '注入的文件写入失败', '自定义文案应原样保留');
    // 预期 2：读取不受写入注入影响（种子内容仍在）
    assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'seed', '读取不受写入注入影响');
    // 输入：撤销注入后重新写入
    remove();
    liteFs.writeFileSync(`${ROOT}/f`, 'ok');
    // 预期 3：撤销后写入恢复正常
    assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'ok', '撤销注入后写入应恢复');
    // 输入：既无 code 也无 error 的注入
    // 预期 4：装配校验拒绝（code 与 error 二选一，缺两样即拒）
    assert.throws(() => liteFs.t_inject({ op: 'writeFileSync', path: `${ROOT}/f` }),
      /code（如 EACCES \/ EIO \/ ENOSPC）或预制 error 实例/, '缺 code 与 error 的注入应被拒绝');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：未实现面与前置约束——卷内未覆盖操作明确报错，未 mock 时 inject 拒绝。 */
test('卷内未实现面与前置约束：truncateSync 明确报错、未 mock 即 inject 拒绝', () => {
  // 输入：mock 后调用内存卷未实现的 truncateSync
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 预期 1：明确报错「未覆盖」，不静默落真实磁盘
    assert.throws(() => liteFs.truncateSync(`${ROOT}/f`), /未覆盖/, '卷内未实现操作应明确报错而非落真实磁盘');
  } finally {
    liteFs.t_unmock();
  }
  // 输入：未 mock 状态下调用 inject
  // 预期 2：拒绝并提示先 mock
  assert.throws(() => liteFs.t_inject({ code: 'EACCES' }), /先 t_mock/, '未设置内存实现时注入应拒绝');
});

/** 场景：幂等与恢复——重复 mock 复用既有卷，unmock 后回真实 fs 语义。 */
test('幂等与恢复：重复 mock 保留卷、unmock 后卷内路径按真实 fs 语义', () => {
  // 输入：mock 后写入文件，再次 mock（幂等）
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync(ROOT, { recursive: true });
  liteFs.writeFileSync(`${ROOT}/keep`, 'x');
  liteFs.t_mock({ exclude: [EXCLUDED] }); // 幂等：复用当前内存实现，不丢卷
  // 预期 1：重复 mock 不丢弃内存卷内容
  assert.equal(liteFs.readFileSync(`${ROOT}/keep`, 'utf8'), 'x', '重复 mock 不应丢弃内存卷');
  // 输入：unmock 后检查同一路径
  liteFs.t_unmock();
  // 预期 2：回到真实 fs（该路径真实磁盘不存在）
  assert.equal(liteFs.existsSync(`${ROOT}/keep`), false, 'unmock 后应回到真实 fs（该路径真实磁盘不存在）');
});


/** 场景：嵌套持久目录在复位后恢复父链，非持久目录不会保留。 */
test('嵌套持久根：复位后恢复目录父链与文件内容', () => {
  liteFs.markPersistent('/coverage-persistent/parent/data');
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 输入：持久根的父目录原先不存在，写入后重建内存卷
    liteFs.mkdirSync('/coverage-persistent/parent/data', { recursive: true });
    liteFs.writeFileSync('/coverage-persistent/parent/data/value', 'retained');
    liteFs.mkdirSync('/coverage-temporary');
    liteFs.t_unmock();
    liteFs.t_mock({ exclude: [EXCLUDED] });
    // 预期：仅配置的子树恢复，父链由文件接口可访问
    assert.equal(liteFs.readFileSync('/coverage-persistent/parent/data/value', 'utf8'), 'retained', '嵌套持久根内容应恢复');
    assert.equal(liteFs.statSync('/coverage-persistent/parent').isDirectory(), true, '父目录链应恢复');
    assert.equal(liteFs.existsSync('/coverage-temporary'), false, '非持久目录不应保留');
  } finally { liteFs.t_unmock(); }
});


/** 场景：utimesSync 更新卷内文件 mtimeMs，目录 no-op，缺失与非法参数按既有错误语义明确报错。 */
test('utimesSync：文件时间回写、目录 no-op、缺失 ENOENT 与非法参数 TypeError', () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 输入：卷内新文件与目录
    liteFs.mkdirSync(`${ROOT}/utimes`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/utimes/file`, 'x');
    // 输入：Date / 毫秒数 / 日期字符串三种时间形态
    liteFs.utimesSync(`${ROOT}/utimes/file`, new Date(0), new Date(946684800000));
    assert.equal(liteFs.statSync(`${ROOT}/utimes/file`).mtimeMs, 946684800000, '预期 1：Date 形态回写 mtimeMs');
    liteFs.utimesSync(`${ROOT}/utimes/file`, 0, 1234567890123);
    assert.equal(liteFs.statSync(`${ROOT}/utimes/file`).mtimeMs, 1234567890123, '预期 2：毫秒数形态回写');
    liteFs.utimesSync(`${ROOT}/utimes/file`, '2000-01-01T00:00:00Z', '2001-09-09T01:46:40.000Z');
    assert.equal(liteFs.statSync(`${ROOT}/utimes/file`).mtimeMs, 1000000000000, '预期 3：字符串形态回写');
    // 输入：目录目标
    liteFs.utimesSync(`${ROOT}/utimes`, 0, 0);
    assert.equal(liteFs.statSync(`${ROOT}/utimes`).mtimeMs, 0, '预期 4：目录时间面维持纪元 0（no-op 不抛错）');
    // 输入：缺失目标与非法时间参数
    assert.throws(() => liteFs.utimesSync(`${ROOT}/utimes/missing`, 0, 0), err => err.code === 'ENOENT', '预期 5：缺失目标 ENOENT');
    assert.throws(() => liteFs.utimesSync(`${ROOT}/utimes/file`, 0, 'not-a-date'), TypeError, '预期 6：非法 mtime TypeError');
  } finally { liteFs.t_unmock(); }
});

/** 场景：fd 0 管道型暂存——readFileSync/readSync 同步消费输入快照，写侧 EBADF，重复暂存覆盖。 */
test('fd 0 暂存：stdin 快照同步可读、写侧 EBADF、重复暂存以最后一次为准', () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 输入：t_stageStdin 登记输入快照
    t_stageStdin(Buffer.from('payload-1\n'));
    assert.equal(liteFs.readFileSync(0, 'utf8'), 'payload-1\n', '预期 1：readFileSync(0) 返回暂存输入');
    assert.equal(liteFs.readFileSync(0).toString(), 'payload-1\n', '预期 2：缺省编码返回 Buffer');
    const sink = Buffer.alloc(4);
    assert.equal(liteFs.readSync(0, sink, 0, 4, 0), 4, '预期 3：readSync 回填字节数');
    assert.equal(sink.toString(), 'payl', '预期 4：readSync 切片内容正确');
    assert.throws(() => liteFs.writeFileSync(0, 'x'), err => err.code === 'EBADF', '预期 5：只读管道写侧 EBADF');
    // 输入：二次暂存覆盖（虚拟命令串行模型下最后一次生效）
    t_stageStdin('payload-2');
    assert.equal(liteFs.readFileSync(0, 'utf8'), 'payload-2', '预期 6：重复暂存覆盖旧快照');
    // 输入：null 暂存等价空输入
    t_releaseStdin();
    t_stageStdin(null);
    assert.equal(liteFs.readFileSync(0, 'utf8'), '', '预期 7：空输入暂存读得空串');
  } finally { t_releaseStdin(); liteFs.t_unmock(); }
});

/** 场景：realpathSync 解析符号链接链（目录别名/文件链接/中间段），循环 ELOOP、缺失 ENOENT。 */
test('realpathSync：软链解析与原生一致、循环 ELOOP、缺失 ENOENT', () => {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 输入：目录别名指向深层目录、文件链接指向既有文件
    liteFs.mkdirSync(`${ROOT}/rp/target`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/rp/target/file`, 'x');
    liteFs.symlinkSync(`${ROOT}/rp/target`, `${ROOT}/rp/alias`, 'dir');
    liteFs.symlinkSync(`${ROOT}/rp/target/file`, `${ROOT}/rp/file-link`, 'file');
    assert.equal(liteFs.realpathSync(`${ROOT}/rp/alias/file`), `${ROOT}/rp/target/file`, '预期 1：目录别名链解析到真实路径');
    assert.equal(liteFs.realpathSync(`${ROOT}/rp/file-link`), `${ROOT}/rp/target/file`, '预期 2：文件链接解析到真实路径');
    assert.equal(liteFs.realpathSync(`${ROOT}/rp/alias`), `${ROOT}/rp/target`, '预期 3：别名目录本身解析');
    // 输入：自指循环链接与悬空链接
    liteFs.symlinkSync(`${ROOT}/rp/loop`, `${ROOT}/rp/loop`, 'file');
    assert.throws(() => liteFs.realpathSync(`${ROOT}/rp/loop`), err => err.code === 'ELOOP', '预期 4：循环链接 ELOOP');
    liteFs.symlinkSync(`${ROOT}/rp/nowhere`, `${ROOT}/rp/dangling`, 'file');
    assert.throws(() => liteFs.realpathSync(`${ROOT}/rp/dangling`), err => err.code === 'ENOENT', '预期 5：悬空链接 ENOENT');
  } finally { liteFs.t_unmock(); }
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-fs.mjs 导入的
 * 门面与库内部相对导入必须是同一实例，否则内存世界会静默分裂（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async () => {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('../../lite-fs.mjs');
  assert.equal(selfRef.default, liteFs, '同一模块经不同 specifier 应共享同一实例');
});
