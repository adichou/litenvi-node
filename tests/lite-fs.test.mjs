// lite-fs 门面用例（node:test 形态，可 `node --test` 或直跑）：默认全量转发真实 node:fs；
// mock({ exclude }) 黑名单制——排除目录（模块源码等系统本体）走真实 fs，其余全部落内存卷
//（真实 fs 错误语义，越界写不可能穿透真实磁盘）；inject 注入 fs 错误；unmock 回真实实现。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import liteFs from '../lite-fs.mjs';
import os from 'node:os';
import path from 'node:path';

const selfFile = new URL(import.meta.url).pathname; // 系统本体文件（真实磁盘）
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/')); // 排除目录：本测试目录（真实磁盘）
const ROOT = '/data/lite-fs-root'; // 内存卷路径（真实磁盘不存在的绝对路径）

/** 场景：相同文件操作分别交给真实 fs 与内存卷，核对返回值、错误字段、字节与文件状态。 */
test('真实 FS 对照：读写、目录、fd、读流与错误字段', async () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-fs-reference-'));
  const root = realFs.realpathSync(temporary);
  const scenario = async (fs, directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const output = [];
    const normalize = value => typeof value === 'string' ? value.replaceAll(directory, '<root>') : value;
    const run = (name, ...args) => {
      try { const value = fs[name](...args); output.push({ name, value: normalize(value) }); return value; }
      catch (error) { output.push({ name, error: { code: error.code, syscall: error.syscall, path: normalize(error.path) } }); }
    };
    // 输入：递归建目录、字符串/字节写入、覆盖复制、重命名和同步 fd 写入
    run('mkdirSync', directory + '/a/b', { recursive: true });
    run('mkdirSync', directory + '/a/b', { recursive: true });
    run('writeFileSync', directory + '/a/file', '中文');
    run('appendFileSync', directory + '/a/file', Buffer.from([0, 255, 128]));
    run('readFileSync', directory + '/a/file');
    run('readFileSync', directory + '/a/file', { encoding: 'hex' });
    run('copyFileSync', directory + '/a/file', directory + '/copy');
    run('renameSync', directory + '/copy', directory + '/renamed');
    const fd = fs.openSync(directory + '/log', 'w');
    fs.writeFileSync(fd, 'old'); fs.closeSync(fd);
    const replacement = fs.openSync(directory + '/log', 'w'); fs.closeSync(replacement);
    run('readFileSync', directory + '/log', 'utf8');
    const append = fs.openSync(directory + '/log', 'a'); fs.writeFileSync(append, 'new'); fs.closeSync(append);
    run('readFileSync', directory + '/log', 'utf8');
    run('mkdirSync', directory + '/a');
    run('readFileSync', directory + '/missing');
    run('readFileSync', directory + '/a');
    run('readdirSync', directory + '/a/file');
    run('rmdirSync', directory + '/a');
    run('realpathSync', directory + '/missing');
    run('openSync', directory + '/missing', 'r');
    run('rmSync', directory + '/a');
    // 输入：读流只比较最终字节，分块数量与平台目录 size/时间戳不作为固定值
    const bytes = await new Promise((resolve, reject) => {
      const chunks = [], stream = fs.createReadStream(directory + '/a/file');
      stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    output.push({ stream: bytes });
    const stat = fs.statSync(directory + '/a/file');
    output.push({ file: stat.isFile(), directory: stat.isDirectory(), size: stat.size, entries: fs.readdirSync(directory).sort() });
    run('rmSync', directory + '/a', { recursive: true });
    output.push({ removed: !fs.existsSync(directory + '/a') });
    return output;
  };
  try {
    const expected = await scenario(realFs, root + '/native');
    liteFs.mock({ exclude: [EXCLUDED] });
    try {
      const actual = await scenario(liteFs, '/mock/fs-reference');
      // 预期 1：规范化独有根目录后，返回值、字节、副作用与错误 code/syscall/path 均一致
      assert.deepEqual(actual, expected, '内存 FS 应与原生 FS 的已测行为一致');
    } finally { liteFs.unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：默认真实实现——未 mock 时门面全量转发真实 node:fs。 */
test('默认真实实现：未 mock 时读系统本体文件与 node:fs 完全一致', () => {
  // 输入：未 mock 状态下对系统本体文件做存在性检查与读取
  // 预期 1：真实文件 existsSync 可见
  assert.equal(liteFs.existsSync(selfFile), true, '真实文件应可见');
  // 预期 2：readFileSync 内容与真实 node:fs 逐字一致
  assert.equal(liteFs.readFileSync(selfFile, 'utf8'), realFs.readFileSync(selfFile, 'utf8'), '内容应与真实 fs 一致');
});

/** 场景：作用域参数前置校验——exclude 必填、已废弃的 roots 白名单口径拒绝。 */
test('exclude 必填：mock() 不带 exclude（含仅传已废弃的 roots）应拒绝', () => {
  // 输入：mock() 不带任何参数
  // 预期 1：拒绝并提示 exclude
  assert.throws(() => liteFs.mock(), /exclude/, '无排除目录应拒绝 mock');
  // 输入：mock() 仅传已废弃的 roots 白名单
  // 预期 2：拒绝并提示 exclude（白名单口径已废弃）
  assert.throws(() => liteFs.mock({ roots: [ROOT] }), /exclude/, '白名单口径已废弃应拒绝并提示 exclude');
});

/** 场景：卷内内存卷基本面——黑名单外路径的读写/追加/清单/stat 自洽。 */
test('卷内内存卷基本面：mkdir/write/read/append/readdir/stat 自洽', () => {
  // 输入：mock 黑名单后递归建目录、写入并追加内容
  liteFs.mock({ exclude: [EXCLUDED] });
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
  } finally {
    liteFs.unmock();
  }
});

/** 场景：真实错误语义——卷内操作按 node:fs 同款错误码失败，不静默成功。 */
test('真实错误语义：ENOENT/EEXIST/ENOTDIR/ERR_FS_EISDIR/EISDIR', () => {
  // 输入：建目录并写入一个文件，作为后续错误操作的现场
  liteFs.mock({ exclude: [EXCLUDED] });
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
    liteFs.unmock();
  }
});

/** 场景：黑名单边界——排除目录内走真实 fs，排除外落内存卷，两侧互不串扰。 */
test('排除目录系统本体：mock 后读源码文件原样走真实 fs、不经内存卷', () => {
  // 输入：mock 黑名单（排除本测试目录）后读排除目录内的源码文件、查卷内路径
  liteFs.mock({ exclude: [EXCLUDED] });
  try {
    // 预期 1：排除目录内真实文件可见（走真实 fs）
    assert.equal(liteFs.existsSync(selfFile), true, '排除目录内真实文件应仍可见');
    // 预期 2：排除目录读取内容与真实 fs 一致
    assert.equal(liteFs.readFileSync(selfFile, 'utf8'), realFs.readFileSync(selfFile, 'utf8'), '排除目录读取应与真实 fs 一致');
    // 预期 3：排除外路径走内存卷（真实磁盘本无此文件，卷内也未创建）
    assert.equal(liteFs.existsSync(`${ROOT}/x`), false, '排除外路径应走内存卷（真实磁盘本无此文件）');
  } finally {
    liteFs.unmock();
  }
});

/** 场景：树操作——rename/copyFile/cp 递归/rm 递归在卷内自洽。 */
test('移动/复制/递归删除：rename/copyFile/cp -r/rm -r 树操作自洽', () => {
  // 输入：建子树（子目录含文件 + 根下另一文件）后依次 rename、copyFile、cp 递归、rm 递归
  liteFs.mock({ exclude: [EXCLUDED] });
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
    liteFs.unmock();
  }
});

/** 场景：fd 面——openSync 打开即建、closeSync 释放、重复 close 报 EBADF。 */
test('fd 面：openSync(a)/closeSync、内容可读、坏 fd EBADF', () => {
  // 输入：建根目录后 openSync('a') 打开新文件、追加一行、close 释放
  liteFs.mock({ exclude: [EXCLUDED] });
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
    liteFs.unmock();
  }
});

/** 场景：错误注入——inject 只拦命中操作与路径，撤销后恢复。 */
test('错误注入：对写入路径注入 EACCES 只拦写入、读取不受影响、撤销恢复', () => {
  // 输入：建文件写入种子内容，对 writeFileSync+该路径注入 EACCES
  liteFs.mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(ROOT, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/f`, 'seed');
    const remove = liteFs.inject({ op: 'writeFileSync', path: `${ROOT}/f`, code: 'EACCES' });
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
    liteFs.unmock();
  }
});

/** 场景：未实现面与前置约束——卷内未覆盖操作明确报错，未 mock 时注入拒绝。 */
test('卷内未实现面与前置约束：truncateSync 明确报错、未 mock 即 inject 拒绝', () => {
  // 输入：mock 后调用内存卷未实现的 truncateSync
  liteFs.mock({ exclude: [EXCLUDED] });
  try {
    // 预期 1：明确报错「未覆盖」，不静默落真实磁盘
    assert.throws(() => liteFs.truncateSync(`${ROOT}/f`), /未覆盖/, '卷内未实现操作应明确报错而非落真实磁盘');
  } finally {
    liteFs.unmock();
  }
  // 输入：未 mock 状态下调用 inject
  // 预期 2：拒绝并提示先 mock
  assert.throws(() => liteFs.inject({ code: 'EACCES' }), /先 mock/, '未设置内存实现时注入应拒绝');
});

/** 场景：幂等与恢复——重复 mock 复用既有卷，unmock 后回真实 fs 语义。 */
test('幂等与恢复：重复 mock 保留卷、unmock 后卷内路径按真实 fs 语义', () => {
  // 输入：mock 后写入文件，再次 mock（幂等）
  liteFs.mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync(ROOT, { recursive: true });
  liteFs.writeFileSync(`${ROOT}/keep`, 'x');
  liteFs.mock({ exclude: [EXCLUDED] }); // 幂等：复用当前内存实现，不丢卷
  // 预期 1：重复 mock 不丢弃内存卷内容
  assert.equal(liteFs.readFileSync(`${ROOT}/keep`, 'utf8'), 'x', '重复 mock 不应丢弃内存卷');
  // 输入：unmock 后检查同一路径
  liteFs.unmock();
  // 预期 2：回到真实 fs（该路径真实磁盘不存在）
  assert.equal(liteFs.existsSync(`${ROOT}/keep`), false, 'unmock 后应回到真实 fs（该路径真实磁盘不存在）');
});
