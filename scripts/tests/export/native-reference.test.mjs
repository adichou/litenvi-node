// 原生对照用例集（native reference）：各模块门面的「真实 XX 对照」双跑用例与真实透传锚定用例
// （默认真实实现/原生对照环境/diff --no-index 逐字节对照）统一收口于此文件，与各模块主测试文件
// （mock 世界语义）分离——真实子进程、真实 fs、真实网络等原生 I/O 不再进入业务用例进程。
// 子进程环境经 native-reference-env.mjs 固定；世界装配沿用各来源文件体例（本文件内局部副本，
// 随用例自包含）。Git 对照使用的仓库根在本文件内声明。本文件不承载包自引用
// 单例检查（该检查仍留在各模块主测试文件）。
// 用例注释格式：方法级写测试场景；语句中「输入」部分标记输入；断言按「预期 1/2/…」逐条注释。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync as nativeSpawnSync, spawn as nativeSpawn } from 'node:child_process';
import nativeFs from 'node:fs'; // 原生 fs（沿用来源用例命名）
import { readFileSync as nativeReadFileSync, writeFileSync as nativeWriteFileSync, existsSync as nativeExistsSync } from 'node:fs'; // 具名身份绑定（lite-cmd-node 来源用例的接口身份对照）
import net from 'node:net'; // 端口探测（lite-server 来源用例的 f_freePort）
import { i_urlInjectionRequest } from '../lite-http-helpers.mjs';
import realFs from 'node:fs'; // 同一模块的别名：保留 lite-fs/lite-cmd-node 来源用例的既有命名
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { i_nativeReferenceEnv } from '../native-reference-env.mjs';
import liteFs from '../../lite-fs.mjs';
import liteChildProcess from '../../lite-child_process.mjs';
import mgr from '../../lite-cmd-mgr.mjs';
// 内存对照场景 spawn node 与 cat/echo/ls/pwd 等 OS 命令：显式安装两套系统命令集
//（导入不登记，mgr 不自动加载命令集）
import { t_install as t_installNodeCommands } from '../../lite-cmd-node.mjs';
import { t_install as t_installOsCommands } from '../../lite-cmd-os.mjs';
t_installNodeCommands();
t_installOsCommands();
import { liteProcess } from '../../lite-process.mjs';
import { ProcessExitError } from '../../lite-process-exit-error.mjs';
import { t_install as t_installGit } from '../../lite-cmd-git.mjs';
import liteHttp from '../../lite-http.mjs';
import liteServer from '../../lite-server.mjs';
import liteTimer, { setTimeout as liteSetTimeout, clearTimeout as liteClearTimeout, setInterval as liteSetInterval, clearInterval as liteClearInterval } from '../../lite-timer.mjs';

// 共享常量：系统本体文件与排除目录（真实磁盘）——各来源文件的 EXCLUDED 口径同值同名
const selfFile = new URL(import.meta.url).pathname;
const EXCLUDED = selfFile.slice(0, selfFile.lastIndexOf('/'));
const REAL_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

// ---------- lite-fs：真实 fs 对照（自 lite-fs.test.mjs 迁入） ----------

const ROOT = '/data/lite-fs-root'; // 内存卷路径（真实磁盘不存在的绝对路径）

/** 场景：黑名单边界——排除目录内走真实 fs，排除外落内存卷，两侧互不串扰。 */
test('排除目录系统本体：mock 后读源码文件原样走真实 fs、不经内存卷', () => {
  // 输入：mock 黑名单（排除本测试目录）后读排除目录内的源码文件、查卷内路径
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    // 预期 1：排除目录内真实文件可见（走真实 fs）
    assert.equal(liteFs.existsSync(selfFile), true, '排除目录内真实文件应仍可见');
    // 预期 2：排除目录读取内容与真实 fs 一致
    assert.equal(liteFs.readFileSync(selfFile, 'utf8'), realFs.readFileSync(selfFile, 'utf8'), '排除目录读取应与真实 fs 一致');
    // 预期 3：排除外路径走内存卷（真实磁盘本无此文件，卷内也未创建）
    assert.equal(liteFs.existsSync(`${ROOT}/x`), false, '排除外路径应走内存卷（真实磁盘本无此文件）');
  } finally {
    liteFs.t_unmock();
  }
});

/** 场景：目录项类型与排除目录复制行为在内存卷与真实文件系统间一致。 */
test('目录项类型和从排除目录复制到内存卷与真实文件系统一致', () => {
  // 输入：构造混合类型目录项并从排除目录复制入卷。
  const actualDirectory = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-copy-isolation-'));
  realFs.mkdirSync(path.join(actualDirectory, 'dir'));
  realFs.writeFileSync(path.join(actualDirectory, 'file'), '内容');
  realFs.symlinkSync('file', path.join(actualDirectory, 'link'));
  liteFs.t_mock({ exclude: [EXCLUDED] });
  try {
    liteFs.mkdirSync(`${ROOT}/dir`, { recursive: true });
    liteFs.writeFileSync(`${ROOT}/file`, '内容');
    liteFs.symlinkSync('file', `${ROOT}/link`);
    const entries = liteFs.readdirSync(ROOT, { withFileTypes: true });
    const summary = list => list.map(entry => [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(summary(entries), summary(realFs.readdirSync(actualDirectory, { withFileTypes: true })), '目录项名称与类型应与原生 fs 一致');
    const typeOf = name => { const item = entries.find(entry => entry.name === name); return [item.isFile(), item.isDirectory(), item.isSymbolicLink()]; };
    assert.deepEqual(typeOf('dir'), [false, true, false], '目录项应保留目录类型');
    assert.deepEqual(typeOf('file'), [true, false, false], '目录项应保留文件类型');
    assert.deepEqual(typeOf('link'), [false, false, true], '目录项应保留符号链接类型');
    assert.ok(liteFs.readdirSync(ROOT, { withFileTypes: true, encoding: 'buffer' }).every(entry => Buffer.isBuffer(entry.name)), 'buffer 编码应保留目录项名称的字节形态');
    liteFs.copyFileSync(selfFile, `${ROOT}/copied`);
    assert.deepEqual(liteFs.readFileSync(`${ROOT}/copied`), realFs.readFileSync(selfFile), '排除目录中的真实文件应复制到内存卷');
    liteFs.mkdirSync(actualDirectory, { recursive: true });
    liteFs.copyFileSync(selfFile, path.join(actualDirectory, 'copy.mjs'));
    assert.equal(realFs.existsSync(path.join(actualDirectory, 'copy.mjs')), false, '内存目标不能穿透到真实磁盘');
    assert.throws(() => liteFs.copyFileSync(selfFile, `${ROOT}/copied`, realFs.constants.COPYFILE_EXCL), { code: 'EEXIST' }, '排他复制不能覆盖目标');
    assert.throws(() => liteFs.copyFileSync(`${EXCLUDED}/missing-copy-source`, `${ROOT}/copied`, realFs.constants.COPYFILE_EXCL), { code: 'ENOENT', syscall: 'copyfile' }, '源文件缺失应优先报错');
    const remove = liteFs.t_inject({ op: 'copyFileSync', path: selfFile, code: 'EACCES' });
    assert.throws(() => liteFs.copyFileSync(selfFile, `${ROOT}/copied`), { code: 'EACCES' }, '跨卷复制应遵守复制故障注入');
    remove();
  } finally { liteFs.t_unmock(); realFs.rmSync(actualDirectory, { recursive: true, force: true }); }
});

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
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      const actual = await scenario(liteFs, '/mock/fs-reference');
      // 预期 1：规范化独有根目录后，返回值、字节、副作用与错误 code/syscall/path 均一致
      assert.deepEqual(actual, expected, '内存 FS 应与原生 FS 的已测行为一致');
    } finally { liteFs.t_unmock(); }
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

/** 场景：目录、链接与访问操作的成功/失败结果与真实 fs 一致，不读取内存实现。 */
test('真实 FS 对照：目录改名与删除、访问失败、符号链接和读流', async () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-fs-extra-'));
  const scenario = async (fileSystem, root) => {
    const observed = [];
    const errorCode = operation => { try { operation(); return null; } catch (error) { return error.code; } };
    // 输入：用普通文件阻断 mkdir，再移动目录并通过公共接口访问文件与链接
    fileSystem.mkdirSync(root + '/directory');
    fileSystem.writeFileSync(root + '/file', 'stream-body');
    observed.push(errorCode(() => fileSystem.mkdirSync(root + '/file')));
    observed.push(errorCode(() => fileSystem.mkdirSync(root + '/file/child', { recursive: true })));
    fileSystem.renameSync(root + '/directory', root + '/moved');
    observed.push(fileSystem.statSync(root + '/moved').isDirectory());
    fileSystem.rmdirSync(root + '/moved');
    observed.push(fileSystem.existsSync(root + '/moved'));
    observed.push(errorCode(() => fileSystem.accessSync(root + '/file')));
    observed.push(errorCode(() => fileSystem.accessSync(root + '/missing')));
    observed.push(fileSystem.realpathSync(root + '/file') === root + '/file');
    fileSystem.symlinkSync(root + '/file', root + '/link');
    observed.push(fileSystem.lstatSync(root + '/link').isSymbolicLink());
    observed.push(errorCode(() => fileSystem.symlinkSync('target', root + '/missing/link')));
    const read = filename => new Promise(resolve => {
      let output = '';
      fileSystem.createReadStream(filename).on('data', chunk => { output += chunk; })
        .on('end', () => resolve({ output })).on('error', error => resolve({ code: error.code }));
    });
    observed.push(await read(root + '/file'));
    observed.push(await read(root + '/missing'));
    const { Writable } = await import('node:stream');
    observed.push(await new Promise((resolve, reject) => {
      let output = '';
      const dest = new Writable({ write(chunk, _encoding, next) { output += chunk; next(); } });
      dest.on('finish', () => resolve(output)).on('error', reject);
      fileSystem.createReadStream(root + '/file').on('error', reject).pipe(dest);
    }));
    fileSystem.unlinkSync(root + '/link');
    observed.push(fileSystem.existsSync(root + '/link'));
    return observed;
  };
  try {
    const expected = await scenario(realFs, realFs.realpathSync(temporary));
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      liteFs.mkdirSync('/mock/fs-extra', { recursive: true });
      // 预期：同一输入得到相同的错误码、文件状态和流数据
      assert.deepEqual(await scenario(liteFs, '/mock/fs-extra'), expected, '扩展文件操作应与真实 fs 一致');
    } finally { liteFs.t_unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：符号链接读取的字节、编码和错误结果与原生 fs 一致。 */
test('真实 FS 对照：符号链接读取支持相对路径、链式链接、目录链接与循环报错', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-fs-symlink-'));
  const scenario = (fileSystem, root) => {
    fileSystem.mkdirSync(root + '/folder');
    fileSystem.writeFileSync(root + '/target', Buffer.from('target-content\0中文'));
    fileSystem.writeFileSync(root + '/folder/value', 'nested-content');
    // 输入：绝对、相对、多级链接，以及路径中间的目录链接
    for (const [target, name] of [[root + '/target', 'absolute'], ['target', 'relative'],
      ['relative', 'chain'], ['../chain', 'folder/up'], ['folder', 'directory'],
      ['missing', 'dangling'], ['self', 'self'], ['cycle-b', 'cycle-a'], ['cycle-a', 'cycle-b']]) {
      fileSystem.symlinkSync(target, root + '/' + name);
    }
    const read = (name, encoding) => {
      try { return { value: fileSystem.readFileSync(root + '/' + name, encoding) }; }
      catch (error) { return { code: error.code, syscall: error.syscall }; }
    };
    return [read('absolute'), read('relative', 'utf8'), read('chain', { encoding: 'hex' }),
      read('folder/up', 'utf8'), read('directory/value', 'utf8'), read('dangling'), read('self'), read('cycle-a'),
      read('directory'), read('target/child'), read('missing/child'), read('')];
  };
  try {
    const expected = scenario(realFs, realFs.realpathSync(temporary));
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      liteFs.mkdirSync('/mock/link-reference', { recursive: true });
      // 预期：文件字节、编码、ENOENT/ELOOP/EISDIR/ENOTDIR 均与原生一致
      assert.deepEqual(scenario(liteFs, '/mock/link-reference'), expected, '符号链接读取应与原生结果一致');
    } finally { liteFs.t_unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：mkdir/rename/append/rm 的边缘口径与真实 fs 对照（node:fs 文档 mkdirSync/renameSync/
 * appendFileSync/rmSync：https://nodejs.org/api/fs.html#fsmkdirsyncpath-options /
 * https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath /
 * https://nodejs.org/api/fs.html#fsappendfilesyncpath-data-options /
 * https://nodejs.org/api/fs.html#fsrmsyncpath-options）——recursive 返回首个新建目录、
 * 非递归 EEXIST、rename 覆盖既有目标的 EISDIR/ENOTDIR/ENOTEMPTY、append 对缺失路径建文件、
 * rm 的 ERR_FS_EISDIR/force 静默。 */
test('真实 FS 对照：mkdir 返回值、rename 覆盖口径、append 建文件与 rm 边缘', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-fs-doc-mkdir-'));
  const scenario = (fileSystem, root) => {
    const observed = [];
    const normalize = value => typeof value === 'string' ? value.replaceAll(root, '<root>') : value;
    const run = (name, ...args) => {
      try { observed.push({ name, value: normalize(fileSystem[name](...args)) }); }
      catch (error) { observed.push({ name, code: error.code, syscall: error.syscall }); }
    };
    fileSystem.mkdirSync(root, { recursive: true }); // 建根（不记账：mock 与原生根的建立时机不同源）
    // 输入：recursive 建目录的返回值与幂等重放、非递归 EEXIST、缺失父目录 ENOENT、对文件 mkdir
    run('mkdirSync', root + '/a/b/c', { recursive: true });
    run('mkdirSync', root + '/a/b/c', { recursive: true });
    run('mkdirSync', root + '/a/b/c');
    run('mkdirSync', root + '/x/y');
    fileSystem.writeFileSync(root + '/a/file', 'data');
    run('mkdirSync', root + '/a/file');
    // 输入：append 到缺失路径应建文件（文档：appendFileSync 文件不存在时创建）
    run('appendFileSync', root + '/appended', 'x');
    run('readFileSync', root + '/appended', 'utf8');
    // 输入：rename 文件到缺失目标（成功）、文件覆盖既有文件（静默替换）、文件落到目录（EISDIR）、
    // 目录落到文件（ENOTDIR）、空目录并入空目录（成功）、非空目录落到非空目录（ENOTEMPTY）
    fileSystem.writeFileSync(root + '/v1', 'v1');
    run('renameSync', root + '/v1', root + '/moved');
    fileSystem.writeFileSync(root + '/replaced', 'old');
    run('renameSync', root + '/moved', root + '/replaced');
    run('readFileSync', root + '/replaced', 'utf8');
    fileSystem.mkdirSync(root + '/adir');
    fileSystem.writeFileSync(root + '/adir/inner', 'i');
    run('renameSync', root + '/replaced', root + '/adir');
    fileSystem.writeFileSync(root + '/plain', 'p');
    fileSystem.mkdirSync(root + '/srcdir');
    fileSystem.writeFileSync(root + '/srcdir/inner', 'i');
    run('renameSync', root + '/srcdir', root + '/plain');
    fileSystem.mkdirSync(root + '/empty');
    fileSystem.mkdirSync(root + '/empty2');
    run('renameSync', root + '/empty', root + '/empty2');
    fileSystem.mkdirSync(root + '/occupied');
    fileSystem.writeFileSync(root + '/occupied/keep', 'k');
    fileSystem.mkdirSync(root + '/occupied2');
    fileSystem.writeFileSync(root + '/occupied2/mine', 'm');
    run('renameSync', root + '/occupied', root + '/occupied2');
    // 输入：rm 空目录非递归（ERR_FS_EISDIR，force 亦然）、缺失路径（ENOENT，force 静默）、递归删除
    fileSystem.mkdirSync(root + '/rmme');
    run('rmSync', root + '/rmme');
    run('rmSync', root + '/rmme', { force: true });
    run('rmSync', root + '/missing-rm');
    run('rmSync', root + '/missing-rm', { force: true });
    run('rmSync', root + '/adir', { recursive: true });
    run('existsSync', root + '/adir');
    return observed;
  };
  try {
    const expected = scenario(realFs, realFs.realpathSync(temporary));
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      // 预期：返回值、错误 code/syscall 与副作用均与真实 fs 一致
      assert.deepEqual(scenario(liteFs, '/mock/fs-mkdir'), expected, 'mkdir/rename/append/rm 边缘口径应与真实 fs 一致');
    } finally { liteFs.t_unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：stat/lstat/utimes/access/copyFile 与真实 fs 对照（node:fs 文档 fs.Stats/utimesSync/
 * accessSync/copyFileSync：https://nodejs.org/api/fs.html#class-fsstats /
 * https://nodejs.org/api/fs.html#fsutimessyncpath-atime-mtime /
 * https://nodejs.org/api/fs.html#fsaccesssyncpath-mode /
 * https://nodejs.org/api/fs.html#fscopyfilesyncsrc-dest-mode）——statSync 跟随符号链接
 * （size 为目标内容长、中段目录链接可穿）、lstat 保留链接条目且 size 为目标字符串字节长、
 * utimes 回写 mtimeMs、EXCL 复制 EEXIST。 */
test('真实 FS 对照：stat 跟随链接、lstat 链接条目、utimes 回写与 EXCL 复制', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-fs-doc-stat-'));
  const scenario = (fileSystem, root) => {
    const observed = [];
    const run = (name, ...args) => {
      try { observed.push({ name, value: fileSystem[name](...args) }); }
      catch (error) { observed.push({ name, code: error.code, syscall: error.syscall }); }
    };
    const shape = get => {
      try { const st = get(); return { isFile: st.isFile(), isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(),
        size: st.size, mtimeIsDate: st.mtime instanceof Date, mtimeMsIsNumber: typeof st.mtimeMs === 'number' }; }
      catch (error) { return { code: error.code, syscall: error.syscall }; }
    };
    fileSystem.mkdirSync(root, { recursive: true });
    fileSystem.writeFileSync(root + '/file', '12345');
    // 输入：常规文件 stat 形状（类型谓词、size、时间字段类型）
    observed.push({ stat: shape(() => fileSystem.statSync(root + '/file')) });
    // 输入：utimes 以 Date 形态回写后 stat mtimeMs 精确可读（数字形态原生按秒、卷内按毫秒，为
    // 头注释声明的偏差口径，不纳入对照）
    fileSystem.utimesSync(root + '/file', new Date(0), new Date(1234567890123));
    const written = fileSystem.statSync(root + '/file');
    // 预期：毫秒精度一致即可（原生经 APFS 纳秒存储回读带 <1ms 浮点噪声，取整归一）
    observed.push({ mtimeMs: Math.round(written.mtimeMs),
      iso: new Date(Math.round(written.mtimeMs)).toISOString() });
    run('utimesSync', root + '/missing-utimes', 0, 0);
    // 输入：statSync 跟随链接链（末段文件链接、中段目录链接、悬空、自指循环），lstat 保留链接条目
    // （链接目标用相对串：lstat size 为目标字符串字节长，两侧目标串须等长才可比）
    fileSystem.symlinkSync('file', root + '/link');
    observed.push({ statLink: shape(() => fileSystem.statSync(root + '/link')), lstatLink: shape(() => fileSystem.lstatSync(root + '/link')) });
    fileSystem.mkdirSync(root + '/dir');
    fileSystem.writeFileSync(root + '/dir/inner', 'abcde');
    fileSystem.symlinkSync('dir', root + '/dlink');
    observed.push({ statThroughDirLink: shape(() => fileSystem.statSync(root + '/dlink/inner')) });
    fileSystem.symlinkSync('nowhere', root + '/dangling');
    observed.push({ statDangling: shape(() => fileSystem.statSync(root + '/dangling')), lstatDangling: shape(() => fileSystem.lstatSync(root + '/dangling')) });
    fileSystem.symlinkSync('cycle', root + '/cycle');
    observed.push({ statCycle: shape(() => fileSystem.statSync(root + '/cycle')), lstatCycle: shape(() => fileSystem.lstatSync(root + '/cycle')) });
    // 输入：accessSync 既有文件/目录与缺失路径（W_OK/R_OK 模式参数两侧同传）
    run('accessSync', root + '/file');
    run('accessSync', root + '/dir', fileSystem.constants.W_OK);
    run('accessSync', root + '/missing-access', fileSystem.constants.R_OK);
    // 输入：copyFileSync 无标志覆盖、EXCL 目标已存在 EEXIST、源缺失 ENOENT
    run('copyFileSync', root + '/file', root + '/copy');
    run('readFileSync', root + '/copy', 'utf8');
    run('copyFileSync', root + '/file', root + '/copy', fileSystem.constants.COPYFILE_EXCL);
    run('copyFileSync', root + '/missing-copy-source', root + '/copy2');
    return observed;
  };
  try {
    const expected = scenario(realFs, realFs.realpathSync(temporary));
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      // 预期：stat 类型/size、链接解析、错误 code/syscall 与复制覆盖语义均一致
      assert.deepEqual(scenario(liteFs, '/mock/fs-stat'), expected, 'stat/utimes/access/copyFile 口径应与真实 fs 一致');
    } finally { liteFs.t_unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：fd 读面与真实 fs 对照（node:fs 文档 openSync/readSync/closeSync：
 * https://nodejs.org/api/fs.html#fsopensyncpath-flags-mode /
 * https://nodejs.org/api/fs.html#fsreadsyncfd-buffer-offset-length-position /
 * https://nodejs.org/api/fs.html#fsclosesyncfd）——显式 position 定位读、EOF 返回 0、
 * 关闭后读写 EBADF、wx 排他创建 EEXIST。（lite fd 不维护游标为头注释声明的偏差口径，
 * 缺省 position 不纳入对照。） */
test('真实 FS 对照：fd 定位读、EOF、关闭后 EBADF 与 wx 排他创建', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-fs-doc-fd-'));
  const scenario = (fileSystem, root) => {
    const observed = [];
    const run = (name, ...args) => {
      try { observed.push({ name, value: fileSystem[name](...args) }); }
      catch (error) { observed.push({ name, code: error.code, syscall: error.syscall }); }
    };
    fileSystem.mkdirSync(root, { recursive: true });
    // 输入：w+ 打开缺失文件（创建）、经 fd 写入、显式 position 定位读与 EOF 读
    const fd = fileSystem.openSync(root + '/log', 'w+');
    fileSystem.writeFileSync(fd, 'abcdef');
    const buffer = Buffer.alloc(8);
    const read = (length, position) => {
      const taken = fileSystem.readSync(fd, buffer, 0, length, position);
      return [taken, buffer.toString('utf8', 0, taken)];
    };
    observed.push({ read0: read(3, 0), read3: read(5, 3), readFar: read(5, 100) });
    // 输入：关闭后再读/写（EBADF）、wx 排他创建（EEXIST 与成功创建）
    fileSystem.closeSync(fd);
    observed.push({ readClosed: (() => { try { fileSystem.readSync(fd, buffer, 0, 3, 0); return 'ok'; } catch (error) { return error.code; } })() });
    run('writeFileSync', fd, 'x');
    run('openSync', root + '/log', 'wx');
    const exclusive = fileSystem.openSync(root + '/exclusive', 'wx');
    fileSystem.writeFileSync(exclusive, 'z');
    fileSystem.closeSync(exclusive);
    run('readFileSync', root + '/exclusive', 'utf8');
    run('openSync', root + '/missing-open', 'r');
    return observed;
  };
  try {
    const expected = scenario(realFs, realFs.realpathSync(temporary));
    liteFs.t_mock({ exclude: [EXCLUDED] });
    try {
      // 预期：定位读字节与内容、EOF 0、EBADF/EEXIST/ENOENT 均与真实 fs 一致（fd 数值本身不比）
      assert.deepEqual(scenario(liteFs, '/mock/fs-fd'), expected, 'fd 读面口径应与真实 fs 一致');
    } finally { liteFs.t_unmock(); }
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

// ---------- lite-child_process：真实 child_process/Node 对照（自 lite-child_process.test.mjs 迁入） ----------

const EXEC_MEMORY_ROOT = '/mock/exec-reference';
function f_setupExecReference() {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync(EXEC_MEMORY_ROOT + '/sub', { recursive: true });
  liteFs.writeFileSync(EXEC_MEMORY_ROOT + '/input.txt', 'input\n');
  liteChildProcess.t_mock();
  return () => { liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：同一组操作分别运行原生 Node 与内存实现，对比参数错误、输入回包和暂停恢复。 */
test('真实 child_process 对照：参数校验、输入流、暂停恢复与退出状态', async () => {
  // 输入：真实临时目录内准备输入文件，记录原生接口在各场景的完整错误和结果形状
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-child-parity-'));
  const root = nativeFs.realpathSync(temporary);
  const filename = path.join(root, 'input.txt');
  nativeFs.writeFileSync(filename, 'file-input\n');
  const scenario = async backend => {
    const errorShape = error => ({ name: error.name, code: error.code, message: error.message });
    const resultShape = result => ({ status: result.status, signal: result.signal, output: result.output,
      stdout: result.stdout, stderr: result.stderr, pid: result.pid > 0,
      error: result.error && errorShape(result.error) });
    const invalid = [[], [null], [1], [{}], [[]], [() => {}], [''], ['a\0b'],
      ['echo', 'bad'], ['echo', ['a\0b']], ['echo', [], null], ['echo', [], []],
      ['echo', [], { cwd: 42 }], ['echo', [], { cwd: [] }], ['echo', [], { cwd: 'a\0b' }],
      ['echo', [], { cwd: Buffer.from('a\0b') }]];
    const validation = invalid.map(args => {
      try { return { returned: resultShape(backend.spawnSync(...args)) }; }
      catch (error) { return { thrown: errorShape(error) }; }
    });
    const storage = Uint8Array.from([0, 65, 66, 67, 0]);
    const inputs = ['text-input\n', 'a\0b', Buffer.from([0, 255, 65]),
      storage.subarray(1, 4), new DataView(storage.buffer, 1, 3), '', false, 0, null];
    const input = inputs.map(value => resultShape(backend.spawnSync('cat', [], { input: value })));
    for (const value of [42, {}, true]) {
      try { input.push({ returned: resultShape(backend.spawnSync('cat', [], { input: value })) }); }
      catch (error) { input.push({ thrown: errorShape(error) }); }
    }
    input.push(resultShape(backend.spawnSync('cat', [filename, '-'], { input: 'stdin-input\n', encoding: 'utf8' })));
    input.push(resultShape(backend.spawnSync('cat', [], { input: 'ignored-input', stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })));
    input.push(resultShape(backend.spawnSync('pwd', [], { cwd: pathToFileURL(root), encoding: 'utf8' })));
    input.push(resultShape(backend.spawnSync('pwd', [], { cwd: Buffer.from(root), encoding: 'utf8' })));
    const observe = child => {
      const state = { stdout: '', stderr: '', close: null, errors: [] };
      child.stdout.on('data', chunk => { state.stdout += chunk; });
      child.stderr.on('data', chunk => { state.stderr += chunk; });
      child.stdin.on('error', error => state.errors.push(error.code));
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { state.close = { code, signal }; resolve(); });
      });
      return { state, done };
    };
    // 输入：通过 stdin 写入两段数据并发送 EOF，命令应将数据回写 stdout 后退出
    const streamed = backend.spawn('cat');
    const stream = observe(streamed);
    streamed.stdin.write('stream-');
    streamed.stdin.end('input\n');
    await stream.done;
    // 输入：暂停 cat 后写入数据，确认无输出；恢复后结束输入并等待正常退出
    const paused = backend.spawn('cat');
    const signal = observe(paused);
    await new Promise(resolve => paused.once('spawn', () => queueMicrotask(resolve)));
    const stop = paused.kill('SIGSTOP');
    paused.stdin.write('paused-');
    await Promise.race([signal.done, new Promise(resolve => setTimeout(resolve, 40))]);
    const stopped = { stdout: signal.state.stdout, close: signal.state.close,
      exitCode: paused.exitCode, signalCode: paused.signalCode, exists: paused.kill(0) };
    let continued = false;
    if (!signal.state.close) {
      continued = paused.kill('SIGCONT');
      paused.stdin.end('input\n');
    }
    await signal.done;
    // 输入：暂停后分别投递普通终止信号与 SIGKILL，对照本机原生的终止时机
    const pausedExit = [];
    for (const fatal of ['SIGTERM', 'SIGKILL']) {
      const child = backend.spawn('cat');
      const observed = observe(child);
      await new Promise(resolve => child.once('spawn', () => queueMicrotask(resolve)));
      child.kill('SIGSTOP');
      child.kill(fatal);
      await Promise.race([observed.done, new Promise(resolve => setTimeout(resolve, 20))]);
      const beforeContinue = { close: observed.state.close, exists: child.kill(0) };
      if (fatal !== 'SIGKILL') child.kill('SIGCONT');
      await observed.done;
      pausedExit.push({ fatal, beforeContinue, ...observed.state });
    }
    return { validation, input, stream: stream.state, signal: { stop, stopped, continued, ...signal.state }, pausedExit };
  };
  try {
    const expected = await scenario({ spawn: nativeSpawn, spawnSync: nativeSpawnSync });
    liteFs.t_mock({ exclude: [EXCLUDED, root] });
    liteChildProcess.t_mock();
    try {
      const actual = await scenario(liteChildProcess);
      // 预期 1：相同输入下，错误名称、错误码、文案、回包、流数据与暂停恢复状态均一致
      assert.deepEqual(actual, expected, '内存 child_process 应与原生对应行为一致');
    } finally {
      liteChildProcess.t_unmock();
      liteFs.t_unmock();
    }
  } finally {
    nativeFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：独立测试进程观察 ref/unref 是否真正影响退出时机，而非只比较方法返回值。 */
test('真实 child_process 对照：ref/unref 控制运行引用，unmock 释放引用', () => {
  const childUrl = new URL('../../lite-child_process.mjs', import.meta.url).href;
  const fsUrl = new URL('../../lite-fs.mjs', import.meta.url).href;
  const mgrUrl = new URL('../../lite-cmd-mgr.mjs', import.meta.url).href;
  const driver = (memory, mode) => {
    const code = memory ? `
      import cp from ${JSON.stringify(childUrl)};
      import fs from ${JSON.stringify(fsUrl)};
      import mgr from ${JSON.stringify(mgrUrl)};
      fs.t_mock({ exclude: [process.cwd()] });
      cp.t_mock();
      mgr.t_defineUserCommand('lifetime-probe', {
        i_run(_args, _ctx, child) {
          setTimeout(() => {
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          }, 80).unref();
        },
      });
      const child = cp.spawn('lifetime-probe', [], { stdio: 'ignore' });
    ` : `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], { stdio: 'ignore' });
    `;
    const operation = mode === 'unref' ? 'child.unref();'
      : mode === 'reref' ? 'child.unref(); child.ref();'
        : mode === 'dispose' ? 'cp.t_unmock();' : '';
    const result = nativeSpawnSync(process.execPath, ['--input-type=module', '-e', `${code}
      child.on('close', () => console.log('closed'));
      ${operation}
      console.log('started');
    `], { encoding: 'utf8', timeout: 3000, env: i_nativeReferenceEnv() });
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.code };
  };
  // 输入：默认持有引用、主动 unref、unref 后重新 ref，分别运行原生与内存驱动
  for (const mode of ['default', 'unref', 'reref']) {
    const expected = driver(false, mode);
    // 预期 1：原生测试驱动正常退出，排除超时或夹具自身错误
    assert.equal(expected.status, 0, `原生 ${mode} 驱动应正常退出`);
    // 预期 2：是否等待子进程 close，与原生运行引用行为一致
    assert.deepEqual(driver(true, mode), expected, `${mode} 的实际退出行为应与原生一致`);
  }
  // 输入：内存子进程仍持有引用时卸载整个 mock 世界
  // 预期 3：unmock 释放引用，测试驱动立即正常结束，不残留运行资源
  assert.deepEqual(driver(true, 'dispose'), { status: 0, signal: null, stdout: 'started\n', stderr: '', error: undefined }, 'unmock 应释放全部运行引用');
});

/** 场景：同步边界与真实 Node 对照——编码、stdio、启动失败及结果对象字段一致。 */
test('真实 Node 对照：spawnSync 编码、stdio、ENOENT 与 ENOTDIR', () => {
  // 输入：真实临时目录内建立一个普通文件，分别执行成功、缺失命令和无效 cwd 场景
  const root = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-child-reference-'));
  const file = path.join(root, 'file');
  nativeFs.writeFileSync(file, 'file');
  const samples = [
    ['echo', ['reference'], {}],
    ['echo', ['reference'], { encoding: 'utf8' }],
    ['echo', ['reference'], { stdio: 'ignore' }],
    ['echo', ['reference'], { stdio: ['ignore', 'pipe', 'ignore'] }],
    ['pwd', [], { cwd: nativeFs.realpathSync(root), encoding: 'utf8' }],
    ['litenvi-missing-command', ['argument'], {}],
    ['echo', ['reference'], { cwd: path.join(root, 'missing') }],
    ['echo', ['reference'], { cwd: file }],
  ];
  const shape = result => ({
    status: result.status, signal: result.signal, output: result.output,
    stdout: result.stdout, stderr: result.stderr, pid: result.pid > 0,
    error: result.error && {
      message: result.error.message, code: result.error.code, errno: result.error.errno,
      syscall: result.error.syscall, path: result.error.path, spawnargs: result.error.spawnargs,
    },
  });
  const expected = samples.map(([command, args, options]) => shape(nativeSpawnSync(command, args, options)));
  liteFs.t_mock({ exclude: [EXCLUDED, root, nativeFs.realpathSync(root)] });
  liteChildProcess.t_mock();
  try {
    for (const [index, [command, args, options]] of samples.entries()) {
      // 预期 1：每个场景的输出类型、状态、stdio、PID 形状和错误字段与真实 Node 相同
      assert.deepEqual(shape(liteChildProcess.spawnSync(command, args, options)), expected[index], `同步场景 ${index} 应与真实 Node 一致`);
    }
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
    nativeFs.rmSync(root, { recursive: true, force: true });
  }
});

/** 场景：异步启动失败与真实 Node 对照——spawn 返回子进程，随后触发 error、close，无 exit。 */
test('真实 Node 对照：spawn 缺失命令的错误字段与事件顺序', async () => {
  const observe = child => new Promise(resolve => {
    const events = [];
    let error;
    child.on('spawn', () => events.push('spawn'));
    child.on('error', value => {
      events.push('error');
      error = { code: value.code, errno: value.errno, path: value.path, spawnargs: value.spawnargs };
    });
    child.on('exit', () => events.push('exit'));
    child.on('close', (code, signal) => { events.push('close'); resolve({ events, code, signal, error, pid: child.pid }); });
  });
  // 输入：真实与内存 spawn 分别执行同一个不存在的命令
  const command = 'litenvi-missing-child';
  const expected = await observe(nativeSpawn(command, ['argument']));
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/app', { recursive: true });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  try {
    // 预期 1：spawn 不同步抛错，异步错误和关闭事件与真实 Node 一致
    assert.deepEqual(await observe(liteChildProcess.spawn(command, ['argument'])), expected, '异步启动失败应与真实 Node 一致');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：命令与参数校验、options 重载和 null args 的行为与真实 Node 对照。 */
test('真实 Node 对照：参数校验与 options 重载', () => {
  // 输入：无效命令、无效参数、null options，以及合法的 options 重载与 null args
  const invalid = [[1], [''], ['x\0'], ['echo', 'bad'], ['echo', [], null]];
  const codes = invalid.map(args => {
    try { nativeSpawnSync(...args); } catch (error) { return error.code; }
  });
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  try {
    for (const [index, args] of invalid.entries()) {
      // 预期 1：同步参数校验使用与真实 Node 相同的错误码
      assert.throws(() => liteChildProcess.spawnSync(...args), { code: codes[index] }, `非法参数 ${index} 应拒绝`);
    }
    // 预期 2：第二参数为 options 时正常执行并应用编码
    assert.equal(liteChildProcess.spawnSync('echo', { encoding: 'utf8' }).stdout, '\n', 'options 重载应生效');
    // 预期 3：null args 表示空参数数组
    assert.equal(liteChildProcess.spawnSync('echo', null, { encoding: 'utf8' }).stdout, '\n', 'null args 应按空参数处理');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：真实 Node 与内存子进程均支持信号 0、数值信号及非法信号校验。 */
test('真实 Node 对照：信号探测、SIGKILL、退出状态与 ref/unref', async () => {
  const observe = child => new Promise(resolve => {
    child.on('spawn', () => {
      const refs = [child.ref(), child.unref()];
      child.ref();
      const exists = child.kill(0);
      let invalid;
      try { child.kill('UNKNOWN_SIGNAL'); } catch (error) { invalid = error.code; }
      const delivered = child.kill(9);
      child.once('close', (code, signal) => resolve({ refs, exists, invalid, delivered, code, signal,
        killed: child.killed, exitCode: child.exitCode, signalCode: child.signalCode, again: child.kill() }));
    });
  });
  // 输入：真实 Node 保持运行，待 spawn 事件后依次探测、校验并发送 SIGKILL
  const expected = await observe(nativeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  try {
    mgr.t_defineUserCommand('signal-reference', { i_run() {} });
    // 预期 1：信号返回值、关闭事件及退出字段与真实子进程一致
    assert.deepEqual(await observe(liteChildProcess.spawn('signal-reference')), expected, '信号与生命周期状态应与真实 Node 一致');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});

/** 场景：默认真实实现——未 mock 时 spawn 真实子进程。 */
test('默认真实实现：未 mock 时 spawn 真实 node 空脚本退出码 0', async () => {
  // 输入：未 mock 状态下 spawn 真实 node 执行空脚本，经门面 waitForClose 等终态
  const child = liteChildProcess.spawn(process.execPath, ['-e', '']);
  const { code } = await liteChildProcess.waitForClose(child);
  // 预期 1：真实子进程以 0 退出
  assert.equal(code, 0, '真实 spawn 应执行真实子进程并以 0 退出');
});

/** 场景：恢复默认——unmock 后 spawn 与 spawnSync 都回到真实实现。 */
test('恢复默认：unmock 后 spawn/spawnSync 回真实子进程语义', async () => {
  // 输入：mock 后立即 unmock，再 spawn 真实 node 空脚本
  liteChildProcess.t_mock();
  liteChildProcess.t_unmock();
  const child = liteChildProcess.spawn(process.execPath, ['-e', '']);
  const { code } = await liteChildProcess.waitForClose(child);
  // 预期 1：真实 spawn 以 0 退出
  assert.equal(code, 0, 'unmock 后应回到真实 spawn');
  // 输入：unmock 后 spawnSync 真实 node -v
  const ver = liteChildProcess.spawnSync(process.execPath, ['-v'], { encoding: 'utf8' });
  // 预期 2：真实执行成功
  assert.equal(ver.status, 0, 'unmock 后 spawnSync 应回真实执行');
  // 预期 3：版本与 process.version 一致
  assert.equal(ver.stdout.trim(), process.version, '真实 node -v 应与 process.version 一致');
});

function f_normalizeExecReference(value, root) {
  if (typeof value === 'string') return value.replaceAll(root, '<root>');
  if (Array.isArray(value)) return value.map(item => f_normalizeExecReference(item, root));
  return value;
}
function f_execErrorShape(error, root, sync = false) {
  if (!error) return null;
  const fields = sync ? ['name', 'message', 'code', 'status', 'signal', 'stdout', 'stderr', 'output', 'path', 'spawnargs']
    : ['name', 'message', 'code', 'signal', 'killed', 'cmd', 'path', 'spawnargs'];
  return Object.fromEntries(fields.map(key => [key, f_normalizeExecReference(error[key], root)]));
}

/** 场景：execFile 的 argv 保持字面值，exec 经 shell 解释命令文本，同步/异步响应对齐原生。 */
test('真实 exec 对照：参数、编码、shell、输入、失败回包与 Promise', async () => {
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-exec-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  nativeFs.mkdirSync(realRoot + '/sub'); nativeFs.writeFileSync(realRoot + '/input.txt', 'input\n');
  const scenario = async root => {
    const results = [];
    const options = { cwd: root, env: i_nativeReferenceEnv({ EXEC_VALUE: 'value with spaces' }) };
    const run = (method, args, extra = {}, input) => new Promise(resolve => {
      const child = liteChildProcess[method](...args, { ...options, ...extra }, (error, stdout, stderr) => {
        results.push({ method, error: f_execErrorShape(error, root), stdout: f_normalizeExecReference(stdout, root), stderr: f_normalizeExecReference(stderr, root), pid: child.pid > 0 });
        resolve();
      });
      if (input !== undefined) child.stdin.end(input);
    });
    const sync = (method, args, extra = {}) => {
      try { results.push({ method, value: f_normalizeExecReference(liteChildProcess[method](...args, { ...options, stdio: 'pipe', ...extra }), root) }); }
      catch (error) { results.push({ method, error: f_execErrorShape(error, root, true) }); }
    };
    // 输入：execFile 不解释 argv 内的空格、变量及分号；回包支持字符串和 Buffer
    await run('execFile', ['echo', ['a b', '$EXEC_VALUE', 'literal;value']]);
    await run('execFile', ['echo', ['汉字']], { encoding: 'buffer' });
    await run('execFile', ['cat', []], {}, 'stdin\n');
    await run('exec', ['cat'], {}, 'shell-stdin\n');
    await run('exec', ['echo before; cat'], {}, 'after\n');
    await run('execFile', ['ls', ['missing']]);
    await run('execFile', ['litenvi-exec-missing', []]);
    await run('execFile', ['echo', ['abcdef']], { maxBuffer: 3 });
    await run('execFile', ['echo', ['first', '&&', 'echo', 'second']], { shell: true });
    // 输入：引号、环境变量、条件串联、管道、重定向、局部 cd 与退出码
    for (const command of ['echo "a b" "$EXEC_VALUE"', 'echo one && echo two',
      'false && echo skipped || echo recovered', 'echo one\necho two', 'echo before # comment\necho after', 'echo piped | cat',
      'cat < input.txt > copy.txt; cat copy.txt', 'echo more >> copy.txt; cat copy.txt',
      'cd sub && pwd; pwd', 'echo err 1>&2; exit 7', 'litenvi-exec-missing']) await run('exec', [command]);
    for (const extra of [{}, { encoding: 'utf8' }, { encoding: 'utf8', stdio: 'ignore' }]) sync('execFileSync', ['echo', ['sync']], extra);
    sync('execFileSync', ['echo', ['abcdef']], { encoding: 'utf8', maxBuffer: 3 });
    sync('execFileSync', ['ls', ['missing']], { encoding: 'utf8' });
    sync('execFileSync', ['litenvi-exec-missing', []], { encoding: 'utf8' });
    sync('execFileSync', ['cat', []], { encoding: 'utf8', input: 'sync-input\n' });
    sync('execSync', ['echo "sync value" | cat'], { encoding: 'utf8' });
    sync('execSync', ['echo failure 1>&2; exit 6'], { encoding: 'utf8' });
    sync('execSync', ['litenvi-exec-missing'], { encoding: 'utf8' });
    // 输入：promisify 的返回值和子进程句柄；失败 Promise 携带完整 stdout/stderr
    for (const method of ['exec', 'execFile']) {
      const args = method === 'exec' ? ['echo promise'] : ['echo', ['promise']];
      const promise = promisify(liteChildProcess[method])(...args, options);
      results.push({ method, promiseChild: promise.child.pid > 0, resolved: await promise });
    }
    try { await promisify(liteChildProcess.exec)('echo out; echo err 1>&2; exit 4', options); }
    catch (error) { results.push({ promiseFailure: f_execErrorShape(error, root), stdout: error.stdout, stderr: error.stderr }); }
    return results;
  };
  try {
    const expected = await scenario(realRoot);
    const done = f_setupExecReference();
    try {
      // 预期 1：除独有目录和 PID 外，四个接口的正常、失败、shell 及 Promise 结果与原生一致
      assert.deepEqual(await scenario(EXEC_MEMORY_ROOT), expected, '内存 exec 系列应与原生的已测响应一致');
      // 预期 2：shell 与其中的命令调用均由内存运行账本记录
      assert.ok(liteChildProcess.t_calls().some(call => call.command === '/bin/sh'), 'exec 应通过内存 shell 执行');
      assert.ok(liteChildProcess.t_calls().some(call => call.command === 'echo'), 'shell 内命令应走内存分派');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：超时与 AbortSignal 终止异步执行，错误字段和回调次数对齐原生。 */
test('真实 execFile 对照：超时、取消和回调仅一次', async () => {
  // 输入：经 lite 门面与原生 child_process 分别执行带超时与取消的 execFile。
  const scenario = async memory => {
    const results = [];
    for (const abort of [false, true]) {
      const controller = new AbortController();
      let callbacks = 0, closed;
      const promise = new Promise(resolve => {
        const child = liteChildProcess.execFile(memory ? 'node' : process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { env: i_nativeReferenceEnv(), ...(abort ? { signal: controller.signal } : { timeout: 20 }) }, (error, stdout, stderr) => {
            callbacks++;
            results.push({ code: error.code, name: error.name, killed: error.killed, signal: error.signal, stdout, stderr });
            resolve(child);
          });
        closed = new Promise(resolveClose => child.once('close', resolveClose));
      });
      if (abort) controller.abort();
      const child = await promise;
      await closed;
      results.push({ callbacks, killed: child.killed });
    }
    return results;
  };
  const expected = await scenario(false);
  const done = f_setupExecReference();
  try {
    // 预期 1：超时、取消的错误、子进程状态和回调次数与原生一致
    assert.deepEqual(await scenario(true), expected, '异步执行终止行为应与原生一致');
  } finally { done(); }
});

/** 场景：可选 args/options/callback 重载及非法参数，按原生接口在执行前校验。 */
test('真实 exec 对照：可选参数重载与非法参数', async () => {
  // 输入：exec 各参数重载与非法参数经 lite 门面与原生对照执行。
  const scenario = async () => {
    const output = [];
    const options = { env: i_nativeReferenceEnv() };
    for (const [name, args] of [['execFile', ['echo']], ['execFile', ['echo', options]],
      ['execFile', ['echo', ['args']]], ['exec', ['echo overload', options]]]) {
      await new Promise(resolve => liteChildProcess[name](...args, (error, stdout, stderr) => { output.push({ error: error?.code, stdout, stderr }); resolve(); }));
    }
    for (const [name, args] of [['exec', [null]], ['execSync', [null]], ['execFile', ['']], ['execFileSync', ['']],
      ['execFile', ['echo', [], { timeout: -1 }]], ['execSync', ['echo value', { maxBuffer: -1 }]],
      ['execFile', ['echo', [], { signal: {} }]], ['execFile', ['echo', [], { killSignal: 'INVALID' }]],
      ['execFile', ['echo', [], {}, 42]]]) {
      try { liteChildProcess[name](...args); output.push({ accepted: true }); }
      catch (error) { output.push({ name: error.name, code: error.code }); }
    }
    return output;
  };
  const expected = await scenario();
  const done = f_setupExecReference();
  try {
    // 预期 1：重载输出与错误类型/错误码和原生一致
    assert.deepEqual(await scenario(), expected, 'exec 参数重载和校验应对齐原生');
  } finally { done(); }
});

/** 场景：spawn 的 options.timeout 与 stdio ignore 与真实 Node 对照（node:child_process 文档
 * spawn options.timeout/killSignal/stdio：
 * https://nodejs.org/api/child_process.html#child_processspawncommand-args-options）——
 * 超时到期以 killSignal 终止（exit/close 带信号、无 error 事件、killed 置位、提前退出撤销
 * 定时器），stdio 'ignore' 公开流为 null。 */
test('真实 Node 对照：spawn 超时 killSignal 终止与 stdio ignore', async () => {
  const scenario = async backend => {
    const events = [];
    // 输入：常驻子进程 + 20ms 超时 + SIGKILL，观察事件序与 killed 标记
    const timed = backend.spawn('node', ['-e', 'setInterval(() => {}, 1000)'],
      { timeout: 20, killSignal: 'SIGKILL', env: i_nativeReferenceEnv() });
    timed.on('spawn', () => events.push('spawn'));
    timed.on('error', () => events.push('error'));
    const timedClose = new Promise(resolve => timed.once('close', (code, signal) => { events.push(['close', code, signal]); resolve(); }));
    timed.once('exit', (code, signal) => events.push(['exit', code, signal]));
    await timedClose;
    events.push({ killed: timed.killed });
    // 输入：stdio 'ignore' 的快速命令——公开流为 null，正常退出
    const ignored = backend.spawn('echo', ['done'], { stdio: 'ignore', env: i_nativeReferenceEnv() });
    const ignoredClose = new Promise(resolve => ignored.once('close', (code, signal) => resolve({ code, signal })));
    const ignoredShape = { stdin: ignored.stdin, stdout: ignored.stdout, stderr: ignored.stderr };
    const ignoredExit = await ignoredClose;
    return { timed: events, ignored: { ...ignoredShape, ...ignoredExit } };
  };
  try {
    const expected = await scenario({ spawn: nativeSpawn });
    liteFs.t_mock({ exclude: [EXCLUDED] });
    liteChildProcess.t_mock();
    try {
      // 预期 1：超时终止的事件序（无 error）、SIGKILL 信号、killed 与 ignore 流形状均一致
      assert.deepEqual(await scenario(liteChildProcess), expected, 'spawn 超时与 stdio ignore 应与原生一致');
    } finally { liteChildProcess.t_unmock(); liteFs.t_unmock(); }
  } finally { liteChildProcess.t_unmock(); liteFs.t_unmock(); }
});

// ---------- lite-cmd-node：真实 Node 对照（自 lite-cmd-node.test.mjs 迁入） ----------

/** 场景：原生对照隔离调试器预加载和强制颜色，业务环境变量与脚本自身 stderr 保持可见。 */
test('原生对照环境：调试器与颜色设置不污染输出，业务 stderr 保留', () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-reference-env-'));
  const preload = path.join(temporary, 'debug-preload.cjs');
  const marker = path.join(temporary, 'preloaded');
  // 输入：模拟 IDE 的 NODE_OPTIONS 预加载和强制颜色，预加载若执行就会创建标记文件
  realFs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); console.error('injected-debugger');`);
  const inherited = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    VSCODE_INSPECTOR_OPTIONS: '{"autoAttachMode":"always"}', FORCE_COLOR: '1', CLICOLOR_FORCE: '1', LITE_REFERENCE_PROBE: 'kept' };
  delete inherited.NO_COLOR;
  delete inherited.NODE_DISABLE_COLORS;
  try {
    const response = liteChildProcess.spawnSync(process.execPath, ['-e', `console.log(42, process.env.LITE_REFERENCE_PROBE); console.error('Debugger attached.');`],
      { env: i_nativeReferenceEnv({}, inherited), encoding: 'utf8', timeout: 3000 });
    // 预期 1：子进程正常结束，保留业务环境变量，数字输出不带 ANSI 色码
    assert.equal(response.error, undefined, '原生对照子进程应能启动');
    assert.equal(response.status, 0, '原生对照子进程应正常退出');
    assert.equal(response.stdout, '42 kept\n', '业务变量应保留且输出不应强制着色');
    // 预期 2：通过启动环境阻止调试预加载，脚本自身的同名诊断文本仍被完整断言
    assert.equal(realFs.existsSync(marker), false, '对照子进程不应加载 IDE 的调试预载模块');
    assert.equal(response.stderr, 'Debugger attached.\n', '不得通过过滤 stderr 文本掩盖业务输出');
    // 预期 3：同样的固定环境也适用于系统 ls，目录项不受 macOS 强制着色变量影响
    const listing = liteChildProcess.spawnSync('ls', ['-a', temporary], { env: i_nativeReferenceEnv({}, inherited), encoding: 'utf8' });
    assert.equal(listing.status, 0, '系统 ls 对照应正常执行');
    assert.equal(listing.stderr, '', '系统 ls 对照不应额外输出诊断');
    assert.equal(listing.stdout, '.\n..\ndebug-preload.cjs\n', '目录项不应包含强制颜色的 ANSI 色码');
    // 预期 4：输入环境和宿主环境保持独立，不为测试修改调用方配置
    assert.equal(inherited.FORCE_COLOR, '1', '不得修改传入的环境对象');
    assert.equal(inherited.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`, '不得修改传入的预加载配置');
  } finally { realFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：同一组 Node 命令分别由真实 Node 与内存实现执行，核对输出、参数、环境与退出。 */
test('真实 Node 对照：版本、脚本输出、argv/env、模块加载与退出码', async () => {
  // 输入：真实临时目录内准备入口、相对依赖、顶层 await 与错误脚本
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-node-reference-'));
  const root = realFs.realpathSync(temporary);
  realFs.writeFileSync(path.join(root, 'dependency.mjs'), `globalThis.nodeProbeCount = (globalThis.nodeProbeCount || 0) + 1; export const count = globalThis.nodeProbeCount;`);
  realFs.writeFileSync(path.join(root, 'entry.mjs'), `
    import process from 'node:process';
    import { log, error } from 'node:console';
    import { count } from './dependency.mjs';
    log(JSON.stringify({ argv: process.argv.slice(1), env: process.env.LITE_NODE_REFERENCE, cwd: process.cwd(), count }));
    error('entry-stderr');
  `);
  realFs.writeFileSync(path.join(root, 'await.mjs'), `await new Promise(resolve => setTimeout(resolve, 5)); console.log('await-done');`);
  realFs.writeFileSync(path.join(root, 'exit-code.mjs'), `import process from 'node:process'; process.exitCode = 7;`);
  realFs.writeFileSync(path.join(root, 'failure.mjs'), `throw new Error('node-reference-failure');`);
  const scenario = async memory => {
    const responses = [];
    const options = { cwd: root, env: i_nativeReferenceEnv({ LITE_NODE_REFERENCE: 'child-value' }), encoding: 'utf8' };
    const normalize = text => String(text).replaceAll(root, '<root>').replaceAll(process.execPath, '<node>');
    const run = async (command, args, errorOnly = false) => {
      const child = liteChildProcess.spawn(command, args, options);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = liteChildProcess.waitForClose(child);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        const result = await closed;
        // 预期 1：所测有限命令应自行退出，不能靠测试超时终止
        assert.notEqual(result.signal, 'SIGKILL', `${command} ${args[0]} 应正常完成`);
        responses.push({ code: result.code, signal: result.signal, stdout: normalize(stdout),
          stderr: normalize(errorOnly ? stderr.match(/(?:SyntaxError|TypeError|Error):[^\n]*/)?.[0] || stderr : stderr) });
      } finally {
        clearTimeout(deadline);
      }
    };
    const node = memory ? 'node' : process.execPath;
    for (const args of [['-v'], ['--version']]) {
      const result = liteChildProcess.spawnSync(node, args, options);
      responses.push({ code: result.status, stdout: result.stdout, stderr: result.stderr });
      await run(node, args);
    }
    await run(node, ['-e', `console.log('stdout'); console.error('stderr');`]);
    await run(node, ['-e', `console.log(JSON.stringify(process.argv.slice(1)));`, 'argument.mjs']);
    await run(node, ['-e', `console.log(process.env.LITE_NODE_REFERENCE); process.exitCode = 3;`]);
    await run(node, ['-e', `console.log('before-exit'); process.exit(4); console.log('after-exit');`]);
    await run(node, ['-e', `setTimeout(() => console.log('later'), 5); console.log('now');`]);
    await run(node, ['./entry.mjs', '--after']);
    await run(node, ['--trace-warnings', './entry.mjs', '--again']);
    await run(node, ['./await.mjs']);
    await run(node, ['./exit-code.mjs']);
    await run(node, ['-p', '6 * 7']);
    await run(node, ['-e', `
      const child = require('node:child_process').spawn('echo', ['nested']);
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.on('close', code => console.log('nested-exit', code));
    `]);
    await run(node, ['-e', `
      const { createServer } = require('node:http');
      const server = createServer((request, response) => response.end('ok'));
      server.listen(0, '127.0.0.1', () => {
        console.log('listening');
        setTimeout(() => server.close(() => console.log('closed')), 5);
      });
    `]);
    // 错误栈的运行器帧不同，仅归一化栈帧，仍比较错误类型、消息、stdout 与退出码。
    await run(node, ['./failure.mjs'], true);
    await run(node, ['./missing.mjs'], true);
    return responses;
  };
  try {
    const expected = await scenario(false);
    liteFs.t_mock({ exclude: [EXCLUDED, root] });
    liteChildProcess.t_mock();
    try {
      const actual = await scenario(true);
      // 预期 2：相同命令输入下，版本、输出、argv/env、重复加载及终态与真实 Node 一致
      assert.deepEqual(actual, expected, 'Node 命令实现应与真实 Node 的已测行为一致');
    } finally {
      liteChildProcess.t_unmock();
      liteFs.t_unmock();
    }
  } finally {
    realFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：stdin 脚本与 -p 求值打印与真实 Node 对照（node CLI 文档：无参数时从 stdin 读脚本、
 * -p 打印求值结果：https://nodejs.org/api/cli.html#-eval-script /
 * https://nodejs.org/api/cli.html#-print-script）——stdin 代码经 EOF 后执行并按结果退出，
 * -p 的对象打印走 util.inspect 同源格式。（node 同步面仅支持 -v 为头注释声明的偏差口径，
 * 不纳入对照。） */
test('真实 Node 对照：stdin 脚本执行与 -p 求值打印', async () => {
  const scenario = async memory => {
    const responses = [];
    const options = { env: i_nativeReferenceEnv(), encoding: 'utf8' };
    const run = async (args, input) => {
      const child = liteChildProcess.spawn(memory ? 'node' : process.execPath, args, options);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      if (input !== undefined) child.stdin.end(input);
      const closed = await liteChildProcess.waitForClose(child);
      responses.push({ code: closed.code, signal: closed.signal, stdout, stderr });
    };
    // 输入：无参数时从 stdin 读脚本（EOF 后执行），表达式与对象字面量的 -p 打印
    await run([], 'console.log("stdin-ran", 6 * 7);\n');
    await run(['-p', '({a: 1, b: [1, 2]})']);
    await run(['-p', '1 + 1']);
    await run(['-p', 'undefined']);
    return responses;
  };
  try {
    const expected = await scenario(false);
    liteFs.t_mock({ exclude: [EXCLUDED] });
    liteChildProcess.t_mock();
    try {
      // 预期：stdin 脚本输出/退出码与 -p 的 inspect 打印均与真实 Node 一致
      assert.deepEqual(await scenario(true), expected, 'node stdin 与 -p 行为应与真实 Node 一致');
    } finally { liteChildProcess.t_unmock(); liteFs.t_unmock(); }
  } finally { liteChildProcess.t_unmock(); liteFs.t_unmock(); }
});


// ---------- lite-cmd-node：原生 fs 身份对照与端口观察（自 lite-cmd-node.test.mjs 迁入） ----------

// 逐用例装配：命令集安装（幂等，模块顶部已装）+ 内存卷（命令执行寻址依赖）+ spawn 边界
function f_setup() {
  t_installNodeCommands();
  t_installOsCommands();
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteChildProcess.t_mock();
  return () => {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  };
}

// 夹具工厂：真实目录提供入口源码，共享 liteFs 门面承接内存文件副作用。
const liteFsUrl = new URL('../../lite-fs.mjs', import.meta.url).href;
let fixtureSeq = 0;
function f_writeFixture(code) {
  const name = path.join(EXCLUDED, `lite-cmd-node-fixture-${process.pid}-${++fixtureSeq}.mjs`);
  realFs.writeFileSync(name, `import liteFs from '${liteFsUrl}';\n${code}\n`);
  return name;
}

/** 场景：覆盖率范围旗标把统计限定在指定 glob 内——范围外真实模块不计入覆盖率表，等号与空格取值均可。 */
test('node --test 覆盖率范围：include/exclude glob 生效', async () => {
  const foreignDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'lite-cov-foreign-'));
  const foreign = path.join(foreignDir, 'foreign.mjs');
  realFs.writeFileSync(foreign, 'export const v = 1;\n');
  const fixture = f_writeFixture(`
    import { test } from 'node:test';
    import { v } from '${pathToFileURL(foreign).href}';
    test('scope', function scope() { if (v !== 1) throw new Error('范围外模块应真实加载'); });
  `);
  const done = f_setup();
  const run = async args => {
    const child = liteChildProcess.spawn('node', args);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    return { ...closed, stdout, stderr };
  };
  try {
    const dir = path.dirname(fixture);
    const foreignReal = realFs.realpathSync(foreignDir); // 覆盖率按 realpath 匹配（/var → /private/var）
    // 输入：默认运行、include 锚定夹具目录（等号取值）、exclude 排除范围外目录（空格取值，真实路径）。
    const all = await run(['--test', '--experimental-test-coverage', fixture]);
    const scoped = await run(['--test', '--experimental-test-coverage', `--test-coverage-include=${dir}/**`, fixture]);
    const excluded = await run(['--test', '--experimental-test-coverage', '--test-coverage-exclude', `${foreignReal}/**`, fixture]);
    // 预期 1：默认运行把加载到的范围外真实模块计入覆盖率表。
    assert.equal(all.code, 0, `范围用例应通过：${all.stderr}`);
    assert.match(all.stdout, /foreign\.mjs/, '默认运行应把范围外真实模块计入覆盖率');
    // 预期 2：include 锚定后范围外模块消失，夹具自身仍被统计。
    assert.doesNotMatch(scoped.stdout, /foreign\.mjs/, 'include 应把范围外模块排除出覆盖率');
    assert.match(scoped.stdout, /lite-cmd-node-fixture-[^.]*\.mjs/, 'include 后夹具自身仍应统计');
    // 预期 3：exclude（空格取值）同样把范围外模块排除。
    assert.doesNotMatch(excluded.stdout, /foreign\.mjs/, 'exclude 应把范围外模块排除出覆盖率');
    assert.match(excluded.stdout, /lite-cmd-node-fixture-[^.]*\.mjs/, 'exclude 不应波及夹具自身统计');
  } finally { done(); realFs.unlinkSync(fixture); realFs.rmSync(foreignDir, { recursive: true, force: true }); }
});

/** 场景：普通 import 在宿主中加载源码，入口可重复执行，并发命令各自使用参数与输出管道。 */
test('普通 import：共享宿主全局、重复入口执行、并发输出与宿主环境恢复', async () => {
  const marker = Symbol.for('litenvi-node-native-import');
  globalThis[marker] = { count: 0 };
  const original = { argv: process.argv, env: process.env, cwd: process.cwd(), exitCode: process.exitCode,
    log: console.log, timer: setTimeout, readFile: realFs.readFileSync, exit: process.exit };
  const fixture = f_writeFixture(`
    const state = globalThis[Symbol.for('litenvi-node-native-import')];
    state.count++;
    await new Promise(resolve => setTimeout(resolve, Number(process.argv[2])));
    console.log(JSON.stringify({ tag: process.env.LITE_IMPORT_TAG, arg: process.argv[3], count: state.count }));
  `);
  const done = f_setup();
  const launch = (tag, delay) => {
    const child = liteChildProcess.spawn('node', [fixture, String(delay), tag], { env: { LITE_IMPORT_TAG: tag } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    return liteChildProcess.waitForClose(child).then(closed => ({ closed, output }));
  };
  try {
    // 输入：同一入口连续执行两次，再并发执行两次，ES 模块源码直接访问宿主全局标记
    const first = await launch('first', 1);
    const second = await launch('second', 1);
    const parallel = await Promise.all([launch('slow', 10), launch('fast', 1)]);
    // 预期 1：每次入口真实执行且正常退出
    for (const result of [first, second, ...parallel]) assert.deepEqual(result.closed, { code: 0, signal: null }, '普通 import 应成功执行');
    assert.equal(globalThis[marker].count, 4, '入口应共享宿主全局且每次重新执行');
    // 预期 2：并发命令的参数、env 与 stdout 不串到其他命令
    assert.deepEqual([first, second, ...parallel].map(result => {
      const { tag, arg } = JSON.parse(result.output);
      return [tag, arg];
    }), [['first', 'first'], ['second', 'second'], ['slow', 'slow'], ['fast', 'fast']], '并发输出与参数应对应各自命令');
    // 预期 3：宿主的 process 字段保持原来的值与对象
    assert.equal(process.argv, original.argv, '宿主 argv 应恢复');
    assert.equal(process.env, original.env, '宿主 env 应恢复');
    assert.equal(process.cwd(), original.cwd, '宿主 cwd 应保持不变');
    assert.equal(process.exitCode, original.exitCode, '宿主退出码应保持不变');
    assert.equal(console.log, original.log, '宿主 console 方法应恢复');
    assert.equal(setTimeout, original.timer, '宿主定时器方法应恢复');
    assert.equal(realFs.readFileSync, original.readFile, '宿主 fs 方法应恢复');
    assert.equal(process.exit, original.exit, '宿主 exit 方法应恢复');
  } finally {
    done();
    realFs.unlinkSync(fixture);
    delete globalThis[marker];
  }
});

/** 场景：虚拟 Node 命令运行期间不替换原生 fs，CJS、ESM 默认和具名导入保持同一原生接口。
 * 夹具只观测原生接口身份，不通过原生 fs 读写业务文件；stdin 闸门保持命令运行以检查中间状态。 */
test('显式文件边界：运行中原生 fs 保持不变', { timeout: 5000 }, async () => {
  liteChildProcess.t_unmock();
  liteFs.t_unmock();
  const original = { read: realFs.readFileSync, write: realFs.writeFileSync, exists: realFs.existsSync };
  const fixture = f_writeFixture(`
    import fs from 'node:fs';
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { createRequire } from 'node:module';
    const cjsFs = createRequire(import.meta.url)('fs');
    console.log(JSON.stringify({
      esm: readFileSync === fs.readFileSync && writeFileSync === fs.writeFileSync && existsSync === fs.existsSync,
      cjs: cjsFs.readFileSync === fs.readFileSync && cjsFs.writeFileSync === fs.writeFileSync && cjsFs.existsSync === fs.existsSync,
    }));
    await new Promise(resolve => process.stdin.once('data', resolve));
    console.log('released');
  `);
  const done = f_setup();
  let child, closed;
  try {
    // 输入：启动夹具，收到接口观测结果后仍阻塞于 stdin，不使用固定睡眠猜测运行阶段。
    child = liteChildProcess.spawn('node', [fixture]);
    closed = liteChildProcess.waitForClose(child);
    let output = '';
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.split('\n')[0])); }
          catch (error) { reject(error); }
        }
      });
      child.once('error', reject);
      child.once('close', () => reject(new Error('夹具未报告接口身份便提前退出')));
    });
    const imports = await ready;
    // 预期 1：命令确实仍在运行，原生默认对象和 ESM 具名导出均未被换成包装函数。
    assert.equal(child.exitCode, null, 'stdin 闸门释放前虚拟 Node 应保持运行');
    assert.equal(realFs.readFileSync, original.read, '命令运行中不得替换原生 readFileSync');
    assert.equal(realFs.writeFileSync, original.write, '命令运行中不得替换原生 writeFileSync');
    assert.equal(realFs.existsSync, original.exists, '命令运行中不得替换原生 existsSync');
    assert.equal(nativeReadFileSync, original.read, '命令运行中不得改写 ESM 具名 readFileSync');
    assert.equal(nativeWriteFileSync, original.write, '命令运行中不得改写 ESM 具名 writeFileSync');
    assert.equal(nativeExistsSync, original.exists, '命令运行中不得改写 ESM 具名 existsSync');
    assert.deepEqual(imports, { esm: true, cjs: true }, '脚本中的 CJS 与 ESM 导入应保持一致的原生 fs 接口');

    // 输入：显式释放 stdin 闸门，等待命令通过正常生命周期结束。
    child.stdin.end('release');
    // 预期 2：命令正常退出，期间保留的原生接口在退出后仍保持原样。
    assert.deepEqual(await closed, { code: 0, signal: null }, '释放闸门后虚拟 Node 应正常结束');
    assert.ok(output.endsWith('released\n'), '脚本应在闸门释放后继续执行到结尾');
    assert.equal(realFs.readFileSync, original.read, '命令结束后原生 readFileSync 应保持原样');
    assert.equal(nativeReadFileSync, original.read, '命令结束后 ESM 具名 readFileSync 应保持原样');
  } finally {
    child?.stdin.end('cleanup');
    if (closed) await closed;
    done();
    realFs.unlinkSync(fixture);
  }
});

/** 场景：终止持有监听服务的脚本时，服务资源也随命令释放。 */
test('活动服务清理：终止 Node 后关闭其监听端口', async () => {
  const done = f_setup();
  liteServer.t_mock();
  const serverUrl = new URL('../../lite-server.mjs', import.meta.url).href;
  const fixture = f_writeFixture(`
    import server from '${serverUrl}';
    server.createServer((_req, res) => res.end('active')).listen(0, () => console.log('ready'));
  `);
  try {
    // 输入：脚本保持服务监听，从公共子进程句柄终止它
    const child = liteChildProcess.spawn('node', [fixture]);
    const closed = liteChildProcess.waitForClose(child);
    await new Promise(resolve => child.stdout.once('data', resolve));
    const port = liteServer.t_port();
    assert.ok(port > 0, '终止前服务应有实际监听端口');
    child.kill();
    // 预期：子进程以信号结束，服务监听已解除
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' }, '终止信号应反映在子进程结果上');
    const { default: http } = await import('node:http');
    const connection = await new Promise(resolve => {
      http.get({ hostname: '127.0.0.1', port }, response => { response.resume(); resolve('connected'); })
        .on('error', error => resolve(error.code));
    });
    assert.equal(connection, 'ECONNREFUSED', '命令结束后原端口应拒绝新连接');
  } finally { done(); liteServer.t_unmock(); realFs.unlinkSync(fixture); }
});

// ---------- lite-cmd-os：真实 OS 命令对照（自 lite-cmd-os.test.mjs 迁入） ----------

function f_setupOs() {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteChildProcess.t_mock();
  return () => { liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：在真实目录和内存卷重放文件命令，对比同步/异步输出、退出码与目录内容。 */
test('真实 OS 对照：文件命令、相对路径、错误输出与同步/异步退出码', async () => {
  // 输入：隔离真实临时目录，固定 C 语言环境与非终端输出；每轮使用全新工作目录
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-os-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = i_nativeReferenceEnv();
  const scenario = async (root, fileSystem, asynchronous) => {
    fileSystem.mkdirSync(root, { recursive: true });
    fileSystem.writeFileSync(path.join(root, 'source.txt'), 'alpha\n');
    fileSystem.writeFileSync(path.join(root, 'second.txt'), 'beta');
    fileSystem.writeFileSync(path.join(root, '.hidden'), 'secret');
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '<root>');
    const run = async (command, args = [], input) => {
      const options = { cwd: root, env, encoding: 'utf8' };
      let response;
      if (asynchronous) {
        const child = liteChildProcess.spawn(command, args, options);
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = liteChildProcess.waitForClose(child);
        child.stdin.end(input);
        const { code, signal } = await closed;
        response = { status: code, signal, stdout, stderr };
      } else {
        const result = liteChildProcess.spawnSync(command, args, { ...options, input });
        assert.equal(result.error, undefined, `${command} 应能启动`);
        response = { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
      }
      responses.push({ command, args, ...response, stdout: normalize(response.stdout), stderr: normalize(response.stderr) });
    };
    const tree = (directory = root, prefix = '') => fileSystem.readdirSync(directory).sort().flatMap(name => {
      const filename = path.join(directory, name), relative = prefix + name;
      return fileSystem.statSync(filename).isDirectory() ? [[relative, 'directory'], ...tree(filename, relative + '/')]
        : [[relative, fileSystem.readFileSync(filename, 'utf8')]];
    });
    await run('echo', ['memory', 'echo']);
    await run('echo', ['-n', 'no-newline']);
    await run('echo', ['before', '-n', 'after']);
    await run('pwd');
    await run('ls', ['.']);
    await run('ls', ['-a', '.']);
    await run('ls', ['-A', '.']);
    await run('ls', ['source.txt']);
    await run('ls', ['missing']);
    await run('mkdir', ['-p', 'tree/sub']);
    await run('mkdir', ['-p', 'tree/sub']);
    await run('mkdir', ['tree']);
    await run('mkdir', ['one', 'two']);
    await run('mkdir', ['tree', 'three']);
    await run('touch', ['empty.txt', 'source.txt']);
    await run('touch', ['missing/file', 'after-error.txt']);
    await run('cp', ['source.txt', 'copied.txt']);
    await run('cp', ['source.txt', 'one']);
    await run('cp', ['second.txt', 'tree/sub/value']);
    await run('cp', ['-R', 'tree', 'tree-copy']);
    await run('cp', ['-R', 'tree', 'two']);
    await run('cp', ['missing', 'unused']);
    await run('cp', ['tree', 'unused']);
    await run('cp', ['-R', 'tree', 'missing/dest']);
    await run('cp', ['source.txt', 'missing/dest']);
    await run('mv', ['copied.txt', 'renamed.txt']);
    await run('mv', ['renamed.txt', 'two']);
    await run('mv', ['missing', 'unused']);
    await run('cat', ['source.txt', 'second.txt']);
    await run('cat', ['source.txt', 'missing', 'second.txt']);
    await run('cat', ['tree']);
    await run('cat', ['-', 'second.txt', '-'], 'stdin\n');
    await run('test', ['-f', 'source.txt']);
    await run('test', ['-d', 'source.txt']);
    await run('test', ['-d', 'tree']);
    await run('test', ['-e', 'missing']);
    await run('test');
    await run('rm', ['tree']);
    await run('rm', ['missing', 'after-error.txt']);
    await run('rm', ['-f', 'missing']);
    await run('rm', ['-f']);
    responses.push({ stage: 'before-remove', tree: tree() });
    await run('rm', ['-rf', 'tree', 'tree-copy', 'one', 'two']);
    responses.push({ stage: 'after-remove', tree: tree() });
    return responses;
  };
  try {
    const expectedSync = await scenario(path.join(realRoot, 'sync'), nativeFs, false);
    const expectedAsync = await scenario(path.join(realRoot, 'async'), nativeFs, true);
    const done = f_setupOs();
    try {
      const actualSync = await scenario('/mock/reference/sync', liteFs, false);
      const actualAsync = await scenario('/mock/reference/async', liteFs, true);
      // 预期 1：同步命令的完整响应与文件副作用和原生命令一致
      assert.deepEqual(actualSync, expectedSync, '同步 OS 命令应与本机原生命令一致');
      // 预期 2：异步命令经 stdout/stderr/close 得到相同结果，文件副作用也一致
      assert.deepEqual(actualAsync, expectedAsync, '异步 OS 命令应与本机原生命令一致');
    } finally {
      done();
    }
  } finally {
    nativeFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：只向本用例启动的进程发信号，退出码借原生 shell 内建 exit 作对照。 */
test('真实 OS 对照：kill 探测、信号终止、失效 PID 与 exit 退出码', async () => {
  const env = i_nativeReferenceEnv();
  const scenario = async (memory, asynchronous) => {
    const responses = [];
    const target = liteChildProcess.spawn(memory ? 'node' : process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env });
    const targetClosed = liteChildProcess.waitForClose(target);
    await new Promise(resolve => target.once('spawn', resolve));
    const deadline = setTimeout(() => target.kill('SIGKILL'), 2000);
    const run = async (command, args) => {
      const executable = !memory && command === 'exit' ? '/bin/sh' : command;
      // exit 是 shell 内建，原生侧由 shell 解释，内存侧由命令条目执行。
      const argv = !memory && command === 'exit' ? ['-c', 'exit "$1"', 'reference', args[0]] : args;
      let result;
      if (asynchronous) {
        const child = liteChildProcess.spawn(executable, argv, { env });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const closed = await liteChildProcess.waitForClose(child);
        result = { status: closed.code, signal: closed.signal, stdout, stderr };
      } else {
        const response = liteChildProcess.spawnSync(executable, argv, { env, encoding: 'utf8' });
        assert.equal(response.error, undefined, `${command} 应能启动`);
        result = { status: response.status, signal: response.signal, stdout: response.stdout, stderr: response.stderr };
      }
      responses.push({ command, args: args.map(arg => arg === String(target.pid) ? '<pid>' : arg), ...result,
        stderr: result.stderr.replaceAll(String(target.pid), '<pid>') });
      return result;
    };
    try {
      // 输入：信号 0 仅探测存活，再发送 TERM，最后对已退出的自有 PID 探测和终止
      const probe = await run('kill', ['-0', String(target.pid)]);
      assert.equal(probe.status, 0, '信号 0 应成功探测本用例的活动进程');
      await run('kill', ['-s', '0', String(target.pid)]);
      await run('kill', ['-s', 'TERM', String(target.pid)]);
      responses.push({ targetClosed: await targetClosed });
      await run('kill', ['-0', String(target.pid)]);
      await run('kill', [String(target.pid)]);
      for (const code of ['0', '3', '255', '256', '-1']) await run('exit', [code]);
      return responses;
    } finally {
      clearTimeout(deadline);
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      await targetClosed;
    }
  };
  const expectedSync = await scenario(false, false);
  const expectedAsync = await scenario(false, true);
  const done = f_setupOs();
  try {
    // 预期 1：同步 kill 回包、目标进程终态与 exit 的 8 位退出码对齐原生
    assert.deepEqual(await scenario(true, false), expectedSync, '同步 kill/exit 应与原生命令一致');
    // 预期 2：异步执行得到相同输出和终态
    assert.deepEqual(await scenario(true, true), expectedAsync, '异步 kill/exit 应与原生命令一致');
  } finally {
    done();
  }
});

// ---------- lite-cmd-git：真实 Git 对照（自 lite-cmd-git.test.mjs 迁入） ----------

function f_setupGit() {
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  t_installGit(); // 卷建立后再安装——持久卷已存在时不依赖惰性安装时序
  liteFs.mkdirSync('/mock/project', { recursive: true });
  liteFs.mkdirSync('/mock/root', { recursive: true });
  liteFs.mkdirSync('/mock/elsewhere', { recursive: true });
  liteChildProcess.t_mock();
  mgr.command('git').t_onRun(null);
  return () => { mgr.command('git').t_onRun(null); liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：合并提交的 log 和 diff-tree 文件清单与真实 Git 一致。 */
test('真实 Git 对照：合并提交默认不输出变更路径', () => {
  // 输入：内存卷与真实仓库各构造一次合并提交并读取输出。
  const temp = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-git-merge-reference-'));
  const root = nativeFs.realpathSync(temp);
  const env = { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const config = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null'];
  const scenario = (cwd, fs) => {
    const run = args => {
      const r = liteChildProcess.spawnSync('git', [...config, ...args], { cwd, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `Git ${args.join(' ')} 应成功：${r.stderr}`);
      return r.stdout;
    };
    run(['init', '-q', '-b', 'main']);
    fs.writeFileSync(`${cwd}/base.txt`, 'base');
    run(['add', '--', 'base.txt']); run(['commit', '-q', '-m', 'base']);
    run(['switch', '-c', 'dev']); run(['switch', '-c', 'side']);
    fs.writeFileSync(`${cwd}/README.md`, '文档');
    run(['add', '--', 'README.md']); run(['commit', '-q', '-m', 'doc']);
    run(['switch', 'dev']); run(['merge', '--no-ff', '-m', 'merge', 'side']);
    return [run(['log', '-1', '--format=%s', '--name-only']), run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])];
  };
  try {
    const expected = scenario(root, nativeFs);
    const done = f_setupGit();
    try { assert.deepEqual(scenario('/mock/project', liteFs), expected, '合并提交文件清单应与真实 Git 一致'); }
    finally { done(); }
  } finally { nativeFs.rmSync(temp, { recursive: true, force: true }); }
});

/** 场景：真实 Git 与内存 Git 对照删除、路径不匹配和限定提交的返回值及仓库状态。 */
test('真实 Git 对照：暂存删除、无匹配 add 与限定提交', () => {
  // 输入：内存卷与真实仓库依次执行暂存删除、空匹配 add 与限定提交。
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-git-rm-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const config = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null'];
  const scenario = (root, filesystem) => {
    const observed = [];
    const run = args => {
      const result = liteChildProcess.spawnSync('git', [...config, ...args], { cwd: root, env, encoding: 'utf8' });
      observed.push({ command: args.join(' '), status: result.status, stdout: result.stdout, stderr: result.stderr });
      return result;
    };
    const put = (name, content) => filesystem.writeFileSync(path.join(root, name), content);
    run(['init', '-q', '-b', 'main']);
    put('shared.txt', 'shared\n');
    put('other.txt', 'old\n');
    run(['add', '--', 'shared.txt', 'other.txt']);
    run(['commit', '-q', '-m', 'baseline']);
    put('other.txt', 'local change\n');
    run(['rm', '--', 'other.txt']);
    run(['status', '--porcelain']);
    put('other.txt', 'old\n');
    put('other.txt', 'staged change\n');
    run(['add', '--', 'other.txt']);
    run(['rm', '--', 'other.txt']);
    run(['status', '--porcelain']);
    put('other.txt', 'old\n');
    run(['add', '--', 'other.txt']);
    run(['rm', '--', 'missing.txt']);
    run(['add', '-A', '--', 'shared.txt', 'missing.txt']);
    run(['status', '--porcelain']);
    put('other.txt', 'changed\n');
    run(['add', '--', 'other.txt']);
    run(['rm', '--', 'shared.txt']);
    run(['status', '--porcelain']);
    run(['add', '-A', '--', 'shared.txt']);
    run(['commit', '-q', '--only', '-m', 'delete', '--', 'shared.txt']);
    run(['status', '--porcelain']);
    run(['show', 'HEAD:other.txt']);
    run(['ls-tree', '--name-only', '-r', 'HEAD']);
    observed.push({ sharedExists: filesystem.existsSync(path.join(root, 'shared.txt')) });
    return observed;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      const actual = scenario('/mock/project', liteFs);
      assert.deepEqual(actual, expected, '删除、失败输出、提交快照和剩余暂存项应与真实 Git 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：同一组操作分别交给真实 Git 与内存 Git，对比返回字段与工作树效果。 */
test('真实 Git 对照：错误输出、分支切换、引用、写命令与退出码', () => {
  // 输入：隔离作者配置、签名与 hooks，在真实临时仓库重放同一组命令
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-git-reference-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const globalArgs = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '/repo').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>');
    const run = (args, fields = ['status', 'stdout', 'stderr'], cwd = root) => {
      const result = liteChildProcess.spawnSync('git', [...globalArgs, ...args], { cwd, env, encoding: 'utf8' });
      responses.push({ command: args[0], ...Object.fromEntries(fields.map(field =>
        [field, typeof result[field] === 'string' ? normalize(result[field]) : result[field]])) });
      return result;
    };
    run(['init', '-q', '-b', 'main']);
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    run(['add', 'a.txt']);
    run(['commit', '-q', '-m', 'baseline']);
    run(['commit', '-q', '-m', 'empty']);
    run(['symbolic-ref', 'HEAD']);
    run(['tag', 'v1']);
    run(['for-each-ref', 'refs/tags', '--format=%(refname:short)%09%(objectname)%09%(*objectname)']);
    run(['branch', 'dev']);
    run(['switch', '-q', 'dev']);
    fileSystem.writeFileSync(path.join(root, 'd.txt'), 'd\n');
    run(['add', 'd.txt']);
    run(['commit', '-q', '-m', 'dev']);
    run(['switch', '-q', 'main']);
    responses.push({ fileExistsAfterSwitch: fileSystem.existsSync(path.join(root, 'd.txt')) });
    run(['merge-base', 'main', 'dev']);
    const sha = run(['rev-parse', 'HEAD']).stdout.trim();
    run(['checkout', '-q', sha]);
    run(['symbolic-ref', '--short', 'HEAD']);
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    run(['checkout', '-q', 'main']);
    run(['merge', '--no-ff', '-m', 'merge', sha]);
    run(['cherry-pick', '-x', sha]);
    run(['reset', '--hard']);
    run(['push', 'origin', 'main']);
    run(['worktree', 'add', `${root}/linked`, 'main']);
    run(['worktree', 'remove', '--force', `${root}/linked`]);
    // revert 的摘要包含提交时间与行统计，另以状态、文件和历史验证其副作用。
    run(['revert', 'HEAD'], ['status', 'stderr']);
    responses.push({ fileExistsAfterRevert: fileSystem.existsSync(path.join(root, 'a.txt')) });
    run(['rev-list', '--count', 'HEAD']);
    run(['stash']);
    // 输入：在另一个已存在分支建立工作树，提交后从主工作树查询共享引用
    run(['tag', 'v1']);
    run(['tag', '--list']);
    run(['remote', 'get-url', 'origin']);
    run(['remote', 'add', 'origin', '/mock-reference-remote']);
    run(['remote']);
    run(['remote', 'get-url', 'origin']);
    const linked = `${root}/linked`;
    run(['worktree', 'add', linked, 'dev']);
    responses.push({ linkedFileExists: fileSystem.existsSync(path.join(linked, 'd.txt')) });
    fileSystem.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');
    run(['add', 'linked.txt'], undefined, linked);
    run(['commit', '-q', '-m', 'linked'], undefined, linked);
    run(['rev-list', '--count', 'dev']);
    run(['worktree', 'add', `${root}/duplicate`, 'dev']);
    run(['worktree', 'remove', linked]);
    responses.push({ linkedExistsAfterRemove: fileSystem.existsSync(linked) });
    // 输入：检出将覆盖未跟踪文件时失败，原文件必须保留
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'local\n');
    run(['switch', '-q', 'dev'], ['status']);
    responses.push({ preservedLocalFile: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    fileSystem.rmSync(path.join(root, 'a.txt'));
    run(['reset', '--hard', 'dev']);
    // 输入：保存、恢复已跟踪修改，核实工作树内容与引用历史
    fileSystem.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    run(['stash']);
    responses.push({ fileAfterStash: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    run(['stash', 'pop'], ['status', 'stderr']);
    responses.push({ fileAfterPop: fileSystem.readFileSync(path.join(root, 'a.txt'), 'utf8') });
    run(['reset', '--hard']);
    // 输入：挑选另一分支的新提交，再反向提交，最后构造有两个父提交的合并
    run(['switch', '-q', '-c', 'feature']);
    fileSystem.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    run(['add', 'feature.txt']);
    run(['commit', '-q', '-m', 'feature']);
    const feature = run(['rev-parse', 'HEAD']).stdout.trim();
    run(['switch', '-q', 'main']);
    run(['cherry-pick', '-x', feature], ['status', 'stderr']);
    responses.push({ pickedFileExists: fileSystem.existsSync(path.join(root, 'feature.txt')) });
    run(['revert', 'HEAD'], ['status', 'stderr']);
    responses.push({ revertedFileExists: fileSystem.existsSync(path.join(root, 'feature.txt')) });
    run(['merge', '--no-ff', '-m', 'merged', 'feature'], ['status', 'stderr']);
    run(['log', '-n', '1', '--format=%P']);
    run(['rev-list', '--count', 'HEAD']);
    return responses;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      const memoryRoot = '/mock/reference';
      liteFs.mkdirSync(memoryRoot, { recursive: true });
      const actual = scenario(memoryRoot, liteFs);
      // 预期 1：除各仓库独有的路径与哈希外，已核验回包与文件效果全部一致
      assert.deepEqual(actual, expected, '内存 Git 应与真实 Git 的对应响应和文件效果一致');
    } finally {
      done();
    }
  } finally {
    nativeFs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** 场景：中文、重音字符与其他 Unicode 引用可创建、切换、解析和枚举，排序与真实 Git 一致。 */
test('真实 Git 对照：Unicode 分支与标签名称及引用排序', () => {
  // 输入：中文初始分支、中文文件与提交说明，混合大小写、重音、分层名称、私用字符和 emoji 引用
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-unicode-refs-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const options = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.precomposeUnicode=false',
    '-c', 'branch.sort=refname', '-c', 'tag.sort=refname'];
  const names = ['发布版', 'é', 'cafe\u0301', '功能/开发', '_draft', '+release', '版本-\ue000', '版本-😀', 'a', 'Z', 'z-last'];
  const scenario = (root, fileSystem) => {
    const responses = [];
    const run = args => {
      const result = liteChildProcess.spawnSync('git', [...options, ...args], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${JSON.stringify(args)} 应接受合法 Unicode 引用：${result.stderr}`);
      responses.push({ args, stdout: result.stdout.replace(/\b[0-9a-f]{40}\b/g, '<sha>') });
    };
    run(['init', '-q', '-b', '主分支']);
    fileSystem.writeFileSync(path.join(root, '中文.txt'), '中文正文\n');
    run(['add', '中文.txt']);
    run(['commit', '-q', '-m', 'feat: 中文提交说明']);
    for (const name of names) {
      run(['branch', name]);
      run(['switch', '-q', name]);
      run(['branch', '--show-current']);
      run(['rev-parse', name]);
    }
    run(['branch', '@']);
    run(['switch', '-q', '-c', '新建/开发']);
    run(['checkout', '-q', '主分支']);
    run(['branch', '--format=%(refname:short)']);
    for (const name of [...names, '@']) {
      run(['tag', name]);
      run(['rev-parse', `refs/tags/${name}`]);
    }
    run(['tag', '--list']);
    run(['for-each-ref', '--format=%(refname)']);
    return responses;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      // 输入：在内存仓库重放同一组操作，执行全部通过 child_process 公共入口
      const root = '/mock/unicode-refs';
      liteFs.mkdirSync(root, { recursive: true });
      const actual = scenario(root, liteFs);
      // 预期 1：引用名称完整保留，创建、切换和解析响应与真实 Git 一致
      assert.deepEqual(actual, expected, 'Unicode 引用应可用，枚举顺序应与真实 Git 相同且不受默认语言排序影响');
      // 预期 2：切换后仍可读取原始中文路径与正文
      assert.equal(liteFs.readFileSync(`${root}/中文.txt`, 'utf8'), '中文正文\n', 'Unicode 引用操作不能改变中文文件内容');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：放行 Unicode 引用后，Git 禁止的路径组件、控制字符和特殊序列仍被拒绝且不产生引用。 */
test('真实 Git 对照：非法分支与标签名称仍拒绝', () => {
  // 输入：空名、空白、点路径、锁文件组件、非法分隔符、修订表达式符号与控制字符
  const names = ['', 'bad name', 'a..b', '.hidden', 'a/.hidden', 'a.lock', 'a.lock/b', '/leading',
    'trailing/', 'double//slash', 'end.', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\u0001b', 'a\u007fb'];
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-invalid-refs-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const options = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null'];
  const scenario = (root, fileSystem) => {
    const run = args => liteChildProcess.spawnSync('git', [...options, ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(run(['init', '-q', '-b', 'main']).status, 0, '非法名称测试应先建立合法仓库');
    fileSystem.writeFileSync(path.join(root, 'seed'), 'seed');
    assert.equal(run(['add', 'seed']).status, 0, '基线文件应成功暂存');
    assert.equal(run(['commit', '-q', '-m', 'baseline']).status, 0, '基线提交应成功');
    const outcomes = names.map(name => ({ name, rejected: ['branch', 'tag'].map(command => run([command, name]).status !== 0),
      switchRejected: run(['switch', '-q', '-c', name]).status !== 0 }));
    return { outcomes, refs: run(['for-each-ref', '--format=%(refname)']).stdout,
      current: run(['branch', '--show-current']).stdout };
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    // 预期 1：输入矩阵中的每个名称都被真实 Git 的分支、标签和创建切换入口拒绝
    for (const { name, rejected, switchRejected } of expected.outcomes) {
      assert.deepEqual(rejected, [true, true], `${JSON.stringify(name)} 应为真实 Git 禁止的引用名`);
      assert.equal(switchRejected, true, `${JSON.stringify(name)} 不应能创建并切换分支`);
    }
    const done = f_setupGit();
    try {
      // 输入：在内存仓库重放非法名称矩阵
      const root = '/mock/invalid-refs';
      liteFs.mkdirSync(root, { recursive: true });
      const actual = scenario(root, liteFs);
      // 预期 2：拒绝结果与真实 Git 一致，没有新引用，当前分支仍为 main
      assert.deepEqual(actual, expected, 'Unicode 放行后仍应拒绝非法引用且不改变仓库引用状态');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：真实 Git 与内存 Git 重放祖先引用、路径恢复、混合重置、分离 HEAD 与快进合并。 */
test('真实 Git 对照：祖先引用、路径恢复、分离 HEAD 与快进合并', () => {
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-extra-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const config = ['-c', 'user.name=Coverage', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const output = [];
    const git = args => liteChildProcess.spawnSync('git', [...config, ...args], { cwd: root, env, encoding: 'utf8' });
    const run = args => { const result = git(args); output.push([args.join(' ').replaceAll(root, '<root>').replace(/\b[0-9a-f]{40}\b/g, '<sha>'), result.status]); return result; };
    const put = text => fileSystem.writeFileSync(root + '/tracked', text);
    // 输入：两个提交，第二次按显式路径提交；祖先表达式只对比关系，不依赖生成的提交号
    run(['init', '-q', '-b', 'main']); put('first\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'first']);
    const first = git(['rev-parse', 'HEAD']).stdout.trim();
    put('second\n'); run(['commit', '-q', '-m', 'second', 'tracked']);
    const second = git(['rev-parse', 'HEAD']).stdout.trim();
    output.push(['ancestors', git(['rev-parse', 'HEAD~1']).stdout.trim() === first,
      git(['rev-parse', 'HEAD^']).stdout.trim() === first, git(['rev-parse', 'HEAD^0']).stdout.trim() === second]);
    // 输入：按提交恢复路径，未匹配路径和未知引用必须报告失败
    run(['checkout', 'HEAD~1', '--', 'tracked']); output.push(['restored', fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    run(['checkout', 'HEAD', '--', 'absent']); run(['checkout', 'no-reference', '--', 'tracked']);
    run(['reset', 'HEAD']); output.push(['index', git(['diff', '--cached', '--name-only']).stdout]);
    run(['checkout', 'HEAD', '--', 'tracked']);
    output.push(['listed', run(['ls-files', '--cached', 'tracked']).stdout]);
    fileSystem.writeFileSync(root + '/.gitignore', 'ignored/\n');
    run(['check-ignore', 'ignored/child']); run(['check-ignore', '-q', 'tracked']);
    run(['add']); run(['rev-parse', 'no-reference']); run(['switch', '-c', 'invalid', 'no-reference']);
    // 输入：分离 HEAD 后提交、重置和重放提交；观察 HEAD 引用和文件内容
    run(['checkout', '--detach', first]); put('detached\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'detached']);
    output.push(['detached', git(['symbolic-ref', '-q', 'HEAD']).status]);
    run(['reset', '--soft', first]); run(['reset', '--hard', first]); run(['cherry-pick', second]);
    output.push(['replayed', fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    // 输入：在分支上推进一次提交，返回 main 做快进合并
    run(['switch', 'main']); run(['switch', '-c', 'feature']); put('feature\n'); run(['add', 'tracked']); run(['commit', '-q', '-m', 'feature']);
    run(['switch', 'main']); const merged = run(['merge', 'feature']);
    output.push(['fast-forward', /Fast-forward/.test(merged.stdout), fileSystem.readFileSync(root + '/tracked', 'utf8')]);
    // 输入：第二个独立工作树需在已有登记中查找分支占用，并继续创建
    run(['branch', 'linked-one']); run(['branch', 'linked-two']);
    run(['worktree', 'add', root + '/linked-one', 'linked-one']);
    run(['worktree', 'add', root + '/linked-two', 'linked-two']);
    output.push(['linked-content', fileSystem.readFileSync(root + '/linked-two/tracked', 'utf8')]);
    return output;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      liteFs.mkdirSync('/mock/git-extra', { recursive: true });
      // 预期：命令退出码、祖先关系、索引与文件效果与真实 Git 一致
      assert.deepEqual(scenario('/mock/git-extra', liteFs), expected, '扩展 Git 场景应与原生命令一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：log 占位符引擎与只读引用族与真实 Git 对照（git-scm 文档 git-log/pretty-formats、
 * git-rev-parse/git-rev-list/git-show/git-ls-tree/git-diff/git-check-ignore：
 * https://git-scm.com/docs/git-log / https://git-scm.com/docs/pretty-formats /
 * https://git-scm.com/docs/git-rev-parse / https://git-scm.com/docs/git-rev-list /
 * https://git-scm.com/docs/git-show / https://git-scm.com/docs/git-ls-tree /
 * https://git-scm.com/docs/git-diff / https://git-scm.com/docs/git-check-ignore /
 * https://git-scm.com/docs/git-fetch）——log 的 %H/%h/%P/%an/%ae/%aI/%s/%B、--skip、a..b
 * 范围与 --not 排除；rev-parse 选项族；rev-list 计数/拓扑序/根提交；show 的 -s --format 与
 * rev:path；ls-files/ls-tree/diff-tree 清单；diff --quiet/--cached --quiet 退出码；
 * check-ignore 判定与 fetch 失败块。提交时间与提交号两侧各自生成，按占位符归一（%at 在
 * 头注释声明的占位符集之外，不纳入对照）。 */
test('真实 Git 对照：log 格式引擎、只读引用族与忽略模型', () => {
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-readonly-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const config = ['-c', 'user.name=Coverage', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '<root>')
      .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)/g, '<date>');
    const run = (args, fields = ['status', 'stdout', 'stderr']) => {
      const result = liteChildProcess.spawnSync('git', [...config, ...args], { cwd: root, env, encoding: 'utf8' });
      responses.push({ command: args.join(' '), ...Object.fromEntries(fields.map(field =>
        [field, typeof result[field] === 'string' ? normalize(result[field]) : result[field]])) });
      return result;
    };
    const put = (rel, text) => fileSystem.writeFileSync(path.join(root, rel), text);
    // 输入：根 .gitignore 忽略 ignore-me.txt，两次提交形成可查询历史
    run(['init', '-q', '-b', 'main']);
    put('.gitignore', 'ignore-me.txt\n');
    put('base.txt', 'one\n');
    put('ignore-me.txt', 'hidden\n');
    run(['add', '.gitignore', 'base.txt']);
    run(['commit', '-q', '-m', 'base']);
    run(['status', '--porcelain', '--untracked-files=all']);
    put('base.txt', 'two\n');
    put('extra.txt', 'extra\n');
    run(['add', 'base.txt', 'extra.txt']);
    run(['commit', '-q', '-m', 'change']);
    // 输入：rev-parse 选项族与符号引用
    run(['rev-parse', '--is-inside-work-tree']);
    run(['rev-parse', '--show-toplevel']);
    run(['rev-parse', '--abbrev-ref', 'HEAD']);
    run(['rev-parse', '--verify', 'HEAD']);
    run(['rev-parse', '--verify', '--quiet', 'no-such-ref']);
    run(['rev-parse', '--verify', 'no-such-ref']);
    run(['symbolic-ref', '--short', 'HEAD']);
    // 输入：log 占位符、分页、范围与排除
    run(['log', '--format=%H|%P|%an|%ae|%aI|%cn|%ce|%cI|%s']);
    run(['log', '-n', '1', '--format=%h %s']);
    run(['log', '--skip=1', '--format=%s']);
    run(['log', '--format=%s', 'HEAD~1..HEAD']);
    run(['log', '--format=%s', '--not', 'HEAD~1']);
    run(['log', '-1', '--format=%B']);
    // 输入：rev-list 计数、顺序与根提交
    run(['rev-list', 'HEAD']);
    run(['rev-list', '--count', 'HEAD']);
    run(['rev-list', '--topo-order', '--reverse', 'HEAD']);
    run(['rev-list', '--max-parents=0', 'HEAD']);
    // 输入：show 的摘要格式与树内文件内容、缺失路径
    run(['show', '-s', '--format=%s', 'HEAD']);
    run(['show', 'HEAD:base.txt']);
    run(['show', 'HEAD:absent.txt']);
    // 输入：索引清单、树清单与提交差异路径
    run(['ls-files']);
    run(['ls-files', '--error-unmatch', 'base.txt']);
    run(['ls-files', '--error-unmatch', 'absent.txt']);
    run(['ls-tree', '--name-only', '-r', 'HEAD']);
    run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
    // 输入：diff 退出码——干净 0、工作树脏 1、暂存后 --cached 1、提交后归 0
    run(['diff', '--quiet']);
    put('base.txt', 'dirty\n');
    run(['diff', '--quiet']);
    run(['diff', '--cached', '--quiet']);
    run(['add', 'base.txt']);
    run(['diff', '--cached', '--quiet']);
    run(['commit', '-q', '-m', 'dirty']);
    run(['diff', '--quiet']);
    // 输入：check-ignore 判定与传输命令失败块（pull 的无远端口径为头注释声明的 128 偏差，
    // 原生无上游时报 1 + tracking 提示，不纳入对照）
    run(['check-ignore', '-q', 'ignore-me.txt']);
    run(['check-ignore', '-q', 'base.txt']);
    run(['fetch', '--all']);
    run(['fetch', 'origin']);
    return responses;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      liteFs.mkdirSync('/mock/git-readonly', { recursive: true });
      // 预期：占位符展开、引用解析、清单、退出码与忽略判定均与真实 Git 一致
      assert.deepEqual(scenario('/mock/git-readonly', liteFs), expected, '只读引用族应与真实 Git 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：合并冲突的回包口径与真实 Git 对照（git-scm 文档 git-merge：
 * https://git-scm.com/docs/git-merge）——分叉合并 status 1、
 * stdout 的 Auto-merging/CONFLICT (content)/Automatic merge failed 提示；解决冲突后提交成功、
 * 工作树恢复干净。冲突状态模型（解决前二次合并的 128、合并提交的双父历史、文件冲突标记与
 * porcelain UU）为头注释声明范围之外，不纳入对照。 */
test('真实 Git 对照：合并冲突回包与解决后恢复', () => {
  const temporary = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-conflict-'));
  const realRoot = nativeFs.realpathSync(temporary);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const config = ['-c', 'user.name=Coverage', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  const scenario = (root, fileSystem) => {
    const responses = [];
    const normalize = text => String(text).replaceAll(root, '<root>').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>');
    const run = (args, fields = ['status', 'stdout', 'stderr']) => {
      const result = liteChildProcess.spawnSync('git', [...config, ...args], { cwd: root, env, encoding: 'utf8' });
      responses.push({ command: args.join(' '), ...Object.fromEntries(fields.map(field =>
        [field, typeof result[field] === 'string' ? normalize(result[field]) : result[field]])) });
      return result;
    };
    const put = (rel, text) => fileSystem.writeFileSync(path.join(root, rel), text);
    // 输入：两个分支对同一文件的分叉修改，main 合并 dev 触发内容冲突
    run(['init', '-q', '-b', 'main']);
    put('shared.txt', 'base\n');
    run(['add', 'shared.txt']);
    run(['commit', '-q', '-m', 'base']);
    run(['switch', '-c', 'dev']);
    put('shared.txt', 'dev\n');
    run(['add', 'shared.txt']);
    run(['commit', '-q', '-m', 'dev-change']);
    run(['switch', 'main']);
    put('shared.txt', 'main\n');
    run(['add', 'shared.txt']);
    run(['commit', '-q', '-m', 'main-change']);
    run(['merge', 'dev']);
    // 输入：解决冲突后完成提交，工作树恢复干净
    put('shared.txt', 'resolved\n');
    run(['add', 'shared.txt']);
    run(['commit', '-m', 'resolved'], ['status']);
    run(['status', '--porcelain']);
    run(['diff', '--quiet']);
    return responses;
  };
  try {
    const expected = scenario(realRoot, nativeFs);
    const done = f_setupGit();
    try {
      liteFs.mkdirSync('/mock/git-conflict', { recursive: true });
      // 预期：冲突回包（status/stdout/stderr）与解决后干净状态与真实 Git 一致
      assert.deepEqual(scenario('/mock/git-conflict', liteFs), expected, '合并冲突回包应与真实 Git 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temporary, { recursive: true, force: true }); }
});

/** 场景：diff --no-index 与真实 git 逐字节对照（同一对真实文件、同一旗标）——输出格式
 * 忠实度由真实 /usr/bin/git 锚定（头路径去前导斜杠、index 7 位 blob 缩写、@@ 形态、
 * 无尾换行注记），退出码形态一致（差异 1 / 相同 0）。 */
test('diff --no-index：与真实 git 输出逐字节一致', async () => {
  const { spawnSync: realSpawnSync } = await import('node:child_process');
  const cleanup = f_setupGit();
  try {
    // 输入：仓库根下的真实临时目录（exclude 白名单内 → lite-fs 透传真实盘），四组输入对
    const probeDir = nativeFs.mkdtempSync(path.join(REAL_ROOT, 'scripts/tests', '.no-index-probe-'));
    const oldText = ['const a = 1;', 'const b = 2;', ...Array.from({ length: 20 }, (_, i) => `CTX${String(i + 1).padStart(2, '0')}`), 'old2', ...Array.from({ length: 6 }, (_, i) => `short${i + 1}`), 'tail'].join('\n');
    const freshText = oldText.replace('const b = 2;', 'const b = 3;\nconst c = 3;').replace('old2', 'new2').replace('tail', 'tail\n<b>bold</b>');
    nativeFs.writeFileSync(path.join(probeDir, 'left.js'), oldText);
    nativeFs.writeFileSync(path.join(probeDir, 'right.js'), freshText);
    nativeFs.writeFileSync(path.join(probeDir, 'single-old'), 'old');
    nativeFs.writeFileSync(path.join(probeDir, 'single-new'), 'new');
    try {
      const cases = [
        ['-U30', '--', path.join(probeDir, 'left.js'), path.join(probeDir, 'right.js')],
        ['--', path.join(probeDir, 'single-old'), path.join(probeDir, 'single-new')],
        ['--', path.join(probeDir, 'right.js'), path.join(probeDir, 'right.js')],
        ['--', path.join(probeDir, 'missing-left'), path.join(probeDir, 'single-new')],
      ];
      for (const argv of cases) {
        // 预期：lite 内存 git 与真实 git 在同一路径、同一旗标下输出与退出码逐字节一致
        const lite = liteChildProcess.spawnSync('git', ['diff', '--no-index', '--no-ext-diff', ...argv], { cwd: '/mock/elsewhere', encoding: 'utf8' });
        const real = realSpawnSync('/usr/bin/git', ['diff', '--no-index', '--no-ext-diff', ...argv], { encoding: 'utf8' });
        assert.equal(lite.status, real.status, `退出码应与真实 git 一致（${argv.join(' ')}）：lite=${lite.status} real=${real.status}`);
        assert.equal(lite.stdout, real.stdout, `输出应与真实 git 逐字节一致（${argv.join(' ')}）：\nlite=\n${lite.stdout}\nreal=\n${real.stdout}`);
        assert.equal(lite.stderr, real.stderr, `stderr 应与真实 git 一致（${argv.join(' ')}）`);
      }
    } finally {
      nativeFs.rmSync(probeDir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// ---------- lite-cmd-git-lock：索引锁对照（自 lite-cmd-git-lock.test.mjs 迁入） ----------

const lockEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const lockConfig = ['-c', 'user.name=Reference', '-c', 'user.email=reference@example.invalid', '-c', 'commit.gpgSign=false'];

function f_setupGitLock() {
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  t_installGit(); // 卷建立后再安装
  liteFs.mkdirSync('/mock/repo', { recursive: true });
  liteChildProcess.t_mock();
  mgr.command('git').t_onRun(null);
  return () => { mgr.command('git').t_onRun(null); liteChildProcess.t_unmock(); liteFs.t_unmock(); };
}

/** 场景：真实 Git 与内存 Git 在已有索引锁时读取和写入的行为一致。 */
test('真实 Git 对照：索引锁阻止写入但不阻止状态读取', () => {
  // 输入：预置 index.lock 后交替执行写入与状态读取。
  const temp = nativeFs.realpathSync(nativeFs.mkdtempSync(path.join(os.tmpdir(), 'lite-git-index-lock-')));
  function scenario(root, filesystem, execute) {
    const run = args => execute([...lockConfig, ...args]);
    assert.equal(run(['init', '-q', '-b', 'main']).status, 0, 'git init 应成功');
    filesystem.writeFileSync(`${root}/a.txt`, 'before\n');
    assert.equal(run(['add', '--', 'a.txt']).status, 0, 'git add 应成功');
    assert.equal(run(['commit', '-q', '-m', 'baseline']).status, 0, 'git commit 应成功');
    filesystem.writeFileSync(`${root}/a.txt`, 'after\n');
    filesystem.writeFileSync(`${root}/.git/index.lock`, '其他写入持锁');
    const regular = run(['status', '--porcelain']);
    const optional = run(['--no-optional-locks', 'status', '--porcelain']);
    const add = run(['add', '--', 'a.txt']);
    const commit = run(['commit', '-m', 'blocked']);
    const unchanged = filesystem.readFileSync(`${root}/.git/index.lock`, 'utf8');
    filesystem.unlinkSync(`${root}/.git/index.lock`);
    const after = run(['status', '--porcelain']);
    return { f_regular: [regular.status, regular.stdout], f_optional: [optional.status, optional.stdout],
      f_add: [add.status, /index\.lock.*File exists/.test(add.stderr)],
      f_commit: [commit.status, /index\.lock.*File exists/.test(commit.stderr)], f_unchanged: unchanged,
      f_after: [after.status, after.stdout] };
  }
  try {
    const expected = scenario(temp, nativeFs, args => nativeSpawnSync('git', args, { cwd: temp, lockEnv, encoding: 'utf8' }));
    const done = f_setupGitLock();
    try {
      const actual = scenario('/mock/repo', liteFs, args => liteChildProcess.spawnSync('git', args, { cwd: '/mock/repo', lockEnv, encoding: 'utf8' }));
      assert.deepEqual(actual, expected, '持锁时读写结果、索引和锁文件应与真实 Git 一致');
    } finally { done(); }
  } finally { nativeFs.rmSync(temp, { recursive: true, force: true }); }
});

// ---------- lite-process：真实 Process 对照（自 lite-process.test.mjs 迁入） ----------

const NODE_COMMAND_PATH = '/mock-cmd/usr/local/bin/node';

// 逐用例装配：内存卷 + spawn 边界 + 进程环境面（kill 透传与 cd 落点依赖）
function f_setupProcess(worldOptions = {}) {
  liteFs.t_mock({ exclude: [EXCLUDED] });
  liteFs.mkdirSync('/mock/project/sub', { recursive: true });
  liteChildProcess.t_mock();
  liteProcess.t_mock({ cwd: '/mock/project', ...worldOptions });
  return () => {
    liteProcess.t_unmock();
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  };
}

/** 场景：真实 process 与虚拟 process 重放目录、环境及信号操作，退出由原生 Node 结果作参照。 */
test('真实 Process 对照：cwd/chdir、argv/env、字段、信号与退出码', async () => {
  const temporary = realFs.mkdtempSync(path.join(os.tmpdir(), 'litenvi-process-reference-'));
  const root = realFs.realpathSync(temporary), originalCwd = process.cwd(), originalArgv = process.argv;
  const originalEnv = process.env.LITE_PROCESS_REFERENCE;
  const scenario = (proc, directory) => {
    const results = [];
    const normalize = value => typeof value === 'string' ? value.replaceAll(directory, '<root>') : value;
    results.push({ cwd: normalize(proc.cwd()), args: proc.argv.slice(1), platform: proc.platform, version: proc.version,
      pidIsInteger: Number.isInteger(proc.pid), executableAbsolute: path.isAbsolute(proc.execPath) });
    proc.env.LITE_PROCESS_REFERENCE = 'changed';
    results.push({ environment: proc.env.LITE_PROCESS_REFERENCE });
    delete proc.env.LITE_PROCESS_REFERENCE;
    results.push({ environmentDeleted: !('LITE_PROCESS_REFERENCE' in proc.env) });
    for (const target of ['sub', '..', 'missing', 'file']) {
      try { results.push({ target, result: proc.chdir(target), cwd: normalize(proc.cwd()) }); }
      catch (error) { results.push({ target, code: error.code, errno: error.errno, syscall: error.syscall, path: normalize(error.path), dest: error.dest, message: normalize(error.message), cwd: normalize(proc.cwd()) }); }
    }
    results.push({ alive: proc.kill(proc.pid, 0) });
    return results;
  };
  try {
    // 输入：真实 cwd 与 argv 的临时变更均在 finally 恢复；信号 0 只探测当前进程
    realFs.mkdirSync(root + '/sub'); realFs.writeFileSync(root + '/file', 'x');
    process.chdir(root); process.argv = [process.execPath, 'reference.mjs', '--flag'];
    const expected = scenario(process, root);
    process.chdir(originalCwd); process.argv = originalArgv;
    const exitResults = ['0', '7', '256', '-1'].map(code => liteChildProcess.spawnSync(process.execPath, ['-e', `process.exit(${code})`]));
    const nativeExits = exitResults.map(result => result.status);
    const signalError = proc => {
      try { proc.kill(exitResults.at(-1).pid, 0); }
      catch (error) { return { code: error.code, errno: error.errno, syscall: error.syscall, message: error.message }; }
    };
    const expectedSignalError = signalError(process);
    const done = f_setupProcess({ cwd: '/mock/process-reference', argv: [NODE_COMMAND_PATH, 'reference.mjs', '--flag'] });
    try {
      liteFs.mkdirSync('/mock/process-reference/sub', { recursive: true });
      liteFs.writeFileSync('/mock/process-reference/file', 'x');
      // 虚拟信号表以自有命令 PID 登记，替换 proc.pid 后探测同一个活动命令
      const target = liteChildProcess.spawn('node', ['-e', 'setInterval(() => {}, 1000)']);
      liteProcess.t_unmock();
      liteProcess.t_mock({ cwd: '/mock/process-reference', argv: [NODE_COMMAND_PATH, 'reference.mjs', '--flag'], pid: target.pid });
      await new Promise(resolve => target.once('spawn', resolve));
      try {
        // 预期 1：目录变化、环境读写、字段与信号探测结果一致；pid/execPath 只核对对应语义
        assert.deepEqual(scenario(liteProcess, '/mock/process-reference'), expected, '虚拟 Process 应与原生 Process 的已测行为一致');
        const exits = ['0', '7', '256', '-1'].map(code => {
          try { liteProcess.exit(Number(code)); } catch (error) { assert.ok(error instanceof ProcessExitError, 'exit 应抛出进程退出错误'); return error.exitCode; }
        });
        // 预期 2：记录退出意图的异常携带与原生 Node 退出相同的 8 位退出码
        assert.deepEqual(exits, nativeExits, '虚拟退出码应与原生退出码一致');
        // 预期 3：只探测本用例已退出的 PID，无此进程的错误字段与原生一致
        assert.equal(expectedSignalError.code, 'ESRCH', '已退出的自有进程应不存在');
        assert.deepEqual(signalError(liteProcess), expectedSignalError, '无此进程的信号错误应与原生一致');
      } finally { const closed = liteChildProcess.waitForClose(target); target.kill(); await closed; }
    } finally { done(); }
  } finally {
    process.chdir(originalCwd); process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.LITE_PROCESS_REFERENCE; else process.env.LITE_PROCESS_REFERENCE = originalEnv;
    realFs.rmSync(temporary, { recursive: true, force: true });
  }
});

// ---------- lite-timer：真实定时器对照（自 lite-timer.test.mjs 迁入；遮蔽绑定以 lite 别名导入） ----------

/** 场景：定时器派发语义与真实 Node 对照（node:timers 文档 setTimeout/setInterval/clear 系：
 * https://nodejs.org/api/timers.html#settimeoutcallback-delay-args /
 * https://nodejs.org/api/timers.html#setintervalcallback-delay-args /
 * https://nodejs.org/api/timers.html#cleartimeouttimeout）——同延迟按插入序派发（FIFO）、
 * 额外实参透传、interval 重复派发与 clear 幂等（clearInterval/clearTimeout 重复调用、对已
 * 触发/未知句柄均为 no-op）。原生侧用 globalThis 定时器跑同一场景脚本，虚拟侧以 advanceMs
 * 等效推进（冻结世界为头注释声明的口径差异，只比事件日志）。句柄形态（原生 Timeout 对象 vs
 * 虚拟句柄对象）亦为声明偏差，仅断言可选消费安全。 */
test('真实 Node 对照：同延迟 FIFO、setInterval 额外实参与 clear 幂等', async () => {
  // 输入：同延迟定时器与 interval 各形态经内存卷与真实 node 执行对比。
  const scenario = (world) => {
    const log = [];
    const finished = Promise.withResolvers();
    world.setTimeout(() => log.push('zero-1'), 0);
    world.setTimeout(() => log.push('zero-2'), 0);
    world.setTimeout((a, b) => log.push(['timeout-args', a, b]), 30, 'x', 2);
    const ghost = world.setTimeout(() => log.push('ghost'), 10);
    world.clearTimeout(ghost); // 未到期即取消（文档：clearTimeout 阻止触发）
    world.clearTimeout(ghost); // 重复 clear 幂等
    world.clearTimeout(undefined); // 未知句柄 no-op
    const ticks = [];
    const interval = world.setInterval((tag) => ticks.push(tag), 20, 'tick');
    world.setTimeout(() => { world.clearInterval(interval); world.clearInterval(interval); finished.resolve(); }, 45);
    return { log, ticks, done: finished.promise };
  };
  const waitFor = async (world) => {
    const { log, ticks, done } = scenario(world);
    if (world.settle) await world.settle(100);
    await done;
    return { log, ticks };
  };
  const nativeWorld = {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  };
  const expected = await waitFor(nativeWorld);
  liteTimer.t_unmock();
  liteTimer.t_mock({ now: 0 });
  try {
    const virtualWorld = {
      setTimeout: liteSetTimeout, clearTimeout: liteClearTimeout, setInterval: liteSetInterval, clearInterval: liteClearInterval,
      settle: ms => liteTimer.t_advanceMs(ms),
    };
    // 预期：事件日志（派发序、实参、取消效果）与真实 Node 一致
    assert.deepEqual(await waitFor(virtualWorld), expected, '定时器派发语义应与真实 Node 一致');
    // 预期 2：虚拟句柄 valueOf 为时钟内部数值 id（声明偏差），unref 可选消费安全短路
    const handle = liteSetTimeout(() => {}, 10);
    assert.match(String(handle), /^\d+$/, '虚拟句柄 valueOf 应为时钟内部数值 id');
    assert.doesNotThrow(() => handle.unref?.(), 'unref 可选消费应安全短路');
  } finally { liteTimer.t_unmock(); }
});

// ---------- lite-http：真实 HTTP 对照（自 lite-http.test.mjs 迁入） ----------

// probeHealth 形状的探活（回调式 http.request 消费门面）。
function f_probe(port, probePath = '/api/health') {
  return new Promise((resolve) => {
    const req = liteHttp.request(
      { hostname: '127.0.0.1', port, path: probePath, method: 'GET', timeout: 1500 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
      }
    );
    req.on('error', (error) => resolve({ ok: false, code: error.code }));
    req.end();
  });
}

/** 对照 handler：同一份请求/响应行为供客户端面、服务端面用例复用。 */
function f_referenceHandler(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('X-Reference', 'retained');
    if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Set-Cookie': ['a=1', 'b=2'] });
      res.write(Buffer.from([0, 255, 128]));
      res.end(Buffer.from([65, 0]));
    } else if (req.url === '/empty') {
      res.writeHead(204);
      res.end('ignored');
    } else {
      res.writeHead(req.url.startsWith('/missing') ? 404 : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url,
        type: req.headers['content-type'] ?? null, probe: req.headers['x-probe'] ?? null,
        body: Buffer.concat(chunks).toString('hex'), header: res.getHeader('X-Reference') }));
    }
  });
}

/** 对照请求：同一客户端观测面（多形态重载/事件序/字节与请求头快照）。 */
function f_requestSnapshot(client, port, { path = '/echo?q=%E4%B8%AD', method = 'POST', form = 'options', get = false, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const events = [], output = [];
    let deadline, snapshot;
    let buffers = true, writeBoolean = true;
    const options = { hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { 'X-Probe': 'forwarded', 'Content-Type': 'application/octet-stream' } };
    const callback = res => {
      events.push('callback');
      res.on('error', reject);
      res.on('data', chunk => { buffers &&= Buffer.isBuffer(chunk); output.push(Buffer.from(chunk)); });
      res.on('end', () => {
        events.push('end');
        snapshot = { status: res.statusCode, body: Buffer.concat(output).toString('hex'), buffers, writeBoolean, events,
          headers: Object.fromEntries(['content-type', 'x-reference', 'set-cookie'].filter(key => res.headers[key] !== undefined).map(key => [key, res.headers[key]])) };
      });
    };
    const send = get ? client.get.bind(client) : client.request.bind(client);
    const url = `http://127.0.0.1:${port}${path}`;
    const req = form === 'options' ? send(options, callback)
      : form === 'url-options' ? send(new URL(url), { method, headers: options.headers, agent: false }, callback)
      : send(form === 'url' ? new URL(url) : url, callback);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    deadline = setTimeout(() => { req.destroy(); reject(new Error('HTTP 对照请求超时')); }, 2000);
    req.on('response', () => events.push('response'));
    req.on('close', () => {
      if (snapshot) { clearTimeout(deadline); events.push('close'); resolve(snapshot); }
    });
    if (!get) {
      for (const chunk of chunks) { const returned = req.write(chunk); writeBoolean = writeBoolean && typeof returned === 'boolean'; }
      req.end();
    }
  });
}

/** 对照取消：destroy(error) 事件序与 destroyed 标记。 */
function f_destroySnapshot(client, port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const deadline = setTimeout(() => reject(new Error('HTTP destroy 对照超时')), 2000);
    const req = client.request({ hostname: '127.00.0.1', port });
    req.on('response', () => events.push('response'));
    req.on('error', error => events.push({ event: 'error', message: error.message, code: error.code }));
    req.on('close', () => { clearTimeout(deadline); resolve({ events: [...events, 'close'], destroyed: req.destroyed }); });
    req.destroy(Object.assign(new Error('reference-stop'), { code: 'REFERENCE_STOP' }));
  });
}

/** 场景：相同 HTTP 请求分别由原生与内存客户端执行，核对请求/响应、字节和事件。 */
test('真实 HTTP 对照：request/get、URL 重载、请求头、二进制正文与取消事件', async () => {
  const scenario = async memory => {
    if (memory) { liteHttp.t_mock(); liteServer.t_mock(); }
    const server = (memory ? liteServer : http).createServer(f_referenceHandler);
    server.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const port = memory ? server.port : server.address().port;
    const client = memory ? liteHttp : http;
    try {
      // 输入：对象、URL、URL+options、get 重载以及文本和原始二进制请求体
      const responses = [];
      for (const options of [
        { chunks: ['中文', Buffer.from([0, 255, 128])] },
        { form: 'url-options', chunks: ['body'] },
        { form: 'url', method: 'GET' }, { form: 'string', get: true, method: 'GET' },
        { get: true, method: 'POST' }, { path: '/binary', method: 'GET' },
        { path: '/empty', method: 'GET' }, { path: '/echo', method: 'HEAD' },
        { path: '/missing', method: 'GET' },
      ]) responses.push(await f_requestSnapshot(client, port, options));
      responses.push(await f_destroySnapshot(client, port));
      return responses;
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (memory) { liteHttp.t_unmock(); liteServer.t_unmock(); }
    }
  };
  // 预期 1：应用层请求/响应字段、原始字节、回调顺序及 destroy(error) 事件与原生一致
  const expected = await scenario(false);
  assert.deepEqual(await scenario(true), expected, '内存 HTTP 客户端应与原生客户端的对应行为一致');
});

/** 场景：默认真实实现——未 mock 时走真实 node:http 的 connect 语义。 */
test('默认真实实现：未 mock 时无人监听端口按真实 ECONNREFUSED 拒连', async () => {
  // 输入：未 mock 状态下探活无人监听的 1 号端口
  const refused = await f_probe(1);
  // 预期 1：探活失败
  assert.equal(refused.ok, false, '无人监听端口应探活失败');
  // 预期 2：错误码来自真实 node:http 的 ECONNREFUSED
  assert.equal(refused.code, 'ECONNREFUSED', '错误应来自真实 node:http connect 语义');
});

/** 场景：拒连与响应元数据与真实 node:http 对照（node:http 文档 ClientRequest 'error' 事件 /
 * IncomingMessage.headers/statusMessage：https://nodejs.org/api/http.html#http_http_request_options_callback /
 * https://nodejs.org/api/http.html#messageheaders /
 * https://nodejs.org/api/http.html#responsestatusmessage）——拒连错误对象（code/syscall/
 * address/port 与消息，端口数字归一）、响应头全量键小写（文档：headers 所有键为小写）、
 * statusMessage 取状态表。响应头键集合两侧不逐项比（原生含 date/keep-alive 等连接面，
 * 卷内为内存回包形态）。 */
test('真实 HTTP 对照：拒连错误字段、statusMessage 与响应头小写键', async () => {
  const scenario = async (memory, refusedPort) => {
    if (memory) { liteHttp.t_mock(); liteServer.t_mock(); }
    const client = memory ? liteHttp : http;
    const server = (memory ? liteServer : http).createServer(f_referenceHandler);
    server.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const port = memory ? server.port : server.address().port;
    try {
      // 输入：对无人监听端口发起请求，捕获错误对象字段
      const refused = await new Promise(resolve => {
        const req = client.request({ hostname: '127.0.0.1', port: refusedPort, path: '/echo', agent: false });
        req.on('error', error => resolve({ code: error.code, syscall: error.syscall, address: error.address,
          port: typeof error.port === 'number' ? '<port>' : error.port, message: error.message.replace(/\d+$/, '<port>') }));
        req.end();
        // socket 空闲兜底（内存门面无 setTimeout 方法时退回全局定时；本文件经例外登记）
        if (typeof req.setTimeout === 'function') req.setTimeout(2000, () => { req.destroy(); resolve({ timeout: true }); });
        else setTimeout(() => { req.destroy(); resolve({ timeout: true }); }, 2000);
      });
      // 输入：正常 GET，取状态码、statusMessage 与响应头键面
      const metadata = await new Promise((resolve, reject) => {
        client.request({ hostname: '127.0.0.1', port, path: '/missing', agent: false }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage,
            allLowercase: Object.keys(res.headers).every(key => key === key.toLowerCase()),
            contentType: res.headers['content-type'], xReference: res.headers['x-reference'], body }));
        }).on('error', reject).end();
        setTimeout(() => reject(new Error('元数据对照超时')), 2000);
      });
      return { refused, metadata };
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (memory) { liteHttp.t_unmock(); liteServer.t_unmock(); }
    }
  };
  // 预期：拒连错误字段、statusMessage、响应头小写键与稳定子集均与原生一致
  const expected = await scenario(false, 1);
  assert.deepEqual(await scenario(true, 57891), expected, '拒连与响应元数据应与原生客户端一致');
});

// ---------- lite-server：真实 Server 对照（自 lite-server.test.mjs 迁入） ----------

/** 场景：原生客户端访问相同 handler，核对原生与内存服务的响应及监听/关闭生命周期。 */
test('真实 Server 对照：监听地址、回调、响应头、字节与关闭事件', async () => {
  const scenario = async memory => {
    if (memory) { liteHttp.t_mock(); liteServer.t_mock(); }
    const events = [];
    const server = (memory ? liteServer : http).createServer(f_referenceHandler);
    const before = { listening: server.listening, address: server.address() };
    server.on('listening', () => events.push('listening'));
    const listening = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    // 输入：使用 listen(port, callback) 重载，经真实回环 socket 请求同一 handler
    server.listen(0, () => events.push('listen-callback'));
    await listening;
    const address = server.address();
    const responses = [];
    try {
      for (const options of [{ chunks: ['中', Buffer.from([0, 255])] }, { path: '/binary', method: 'GET' },
        { path: '/empty', method: 'GET' }, { path: '/echo', method: 'HEAD' }, { path: '/missing', method: 'GET' }])
        responses.push(await f_requestSnapshot(http, address.port, options));
      const during = { listening: server.listening, portValid: address.port > 0 };
      server.on('close', () => events.push('close'));
      await new Promise(resolve => server.close(() => { events.push('close-callback'); resolve(); }));
      return { before, during, after: { listening: server.listening, address: server.address() }, events, responses };
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (memory) { liteHttp.t_unmock(); liteServer.t_unmock(); }
    }
  };
  const expected = await scenario(false);
  // 预期 1：仅动态端口、自动 Date/连接头不参与比较，服务生命周期与应用回包完整对齐
  assert.deepEqual(await scenario(true), expected, '内存 Server 应与原生 Server 的对应行为一致');
});

/** 场景：未运行时 close 与 handler 抛错对照（node:http 文档 server.close / Server 事件：
 * https://nodejs.org/api/http.html#serverclosecallback）——未运行时 close 两侧都以
 * ERR_SERVER_NOT_RUNNING 作为回调错误且不发 error 事件；handler 抛错为头注释声明的偏差
 * 口径：原生同步抛出即 uncaughtException 崩溃进程（无法在共享测试进程内做原生对照），内存
 * 服务按声明回 500 JSON { error: message }——同步抛错经 f_handle 的 Promise executor 转
 * 拒绝、异步 handler 拒绝经 Promise.resolve(handled).catch，两条路径同口径（真回环 socket
 * 与进程内直调各验一次）。 */
test('真实 Server 对照：未运行 close 回调错误一致；handler 抛错按声明回 500 JSON', async () => {
  const scenario = async memory => {
    if (memory) { liteHttp.t_mock(); liteServer.t_mock(); }
    const factory = memory ? liteServer : http;
    const server = factory.createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    await new Promise(resolve => server.close(resolve));
    // 输入：未运行状态再次 close，捕获 error 事件与回调错误
    const again = await new Promise(resolve => {
      let errorEvent = null;
      server.once('error', error => { errorEvent = error.code; });
      server.close(error => resolve({ errorEvent, callback: error ? error.code : null }));
    });
    if (memory) { liteHttp.t_unmock(); liteServer.t_unmock(); }
    return { again };
  };
  // 预期 1：未运行时 close 的回调错误与事件面均与原生 Server 一致
  const expected = await scenario(false);
  assert.deepEqual(await scenario(true), expected, '未运行时 close 的回调错误应与原生 Server 一致');

  // 输入：handler 同步抛错与异步拒绝（内存服务，真回环 socket 与进程内直调两条路径）
  liteHttp.t_mock();
  liteServer.t_mock();
  try {
    for (const mode of ['sync-throw', 'async-reject']) {
      const handler = mode === 'sync-throw'
        ? () => { throw new Error('handler boom'); }
        : async () => { throw new Error('handler boom'); };
      const server = liteServer.createServer(handler).listen(0);
      await new Promise(resolve => server.once('listening', resolve));
      // 预期 2：真回环 socket 请求收到 500 与错误正文（保护共享进程的连接面，声明偏差）
      const socketView = await new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: server.port, path: '/boom', agent: false }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', error => resolve({ code: error.code }));
        req.end();
        // socket 空闲兜底（内存门面无 setTimeout 方法时退回全局定时；本文件经例外登记）
        if (typeof req.setTimeout === 'function') req.setTimeout(2000, () => { req.destroy(); resolve({ timeout: true }); });
        else setTimeout(() => { req.destroy?.(); resolve({ timeout: true }); }, 2000);
      });
      assert.equal(socketView.status, 500, `${mode} 真回环 socket 应收到 500`);
      assert.deepEqual(JSON.parse(socketView.body), { error: 'handler boom' }, `${mode} 真回环 socket 回包应为错误 JSON`);
      // 预期 3：进程内直调同口径收到 500 与错误正文
      const inProcess = await new Promise(resolve => {
        const req = liteHttp.request({ hostname: '127.0.0.1', port: server.port, path: '/boom' }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', error => resolve({ code: error.code }));
        req.end();
        // socket 空闲兜底（内存门面无 setTimeout 方法时退回全局定时；本文件经例外登记）
        if (typeof req.setTimeout === 'function') req.setTimeout(2000, () => { req.destroy(); resolve({ timeout: true }); });
        else setTimeout(() => { req.destroy?.(); resolve({ timeout: true }); }, 2000);
      });
      assert.equal(inProcess.status, 500, `${mode} 进程内直调应收到 500`);
      assert.deepEqual(JSON.parse(inProcess.body), { error: 'handler boom' }, `${mode} 进程内直调回包应为错误 JSON`);
      await new Promise(resolve => server.close(resolve));
    }
  } finally { liteHttp.t_unmock(); liteServer.t_unmock(); }
});

// ---------- lite-server：原生 HTTP 客户端独立观察（自 lite-server.test.mjs 迁入） ----------

// 内存路由客户端：与 lite-server 同路由域（不经 socket）
async function f_get(port, path) {
  return new Promise((resolve, reject) => {
    const req = liteHttp.request({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 真实 socket 客户端：浏览器等真实流量的最小替身——真 TCP 到达 socket 前端
function f_realGet(port, path, { destroyAfter = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (destroyAfter > 0) setTimeout(() => req.destroy(), destroyAfter);
  });
}

function f_realPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function f_withBoard(handler, run) {
  liteHttp.t_mock();
  liteServer.t_mock();
  const server = liteServer.createServer(handler).listen(0);
  await new Promise((resolve) => server.once('listening', resolve)); // 真实绑定异步：就绪后才取实际端口
  try {
    return await run(server.port);
  } finally {
    liteHttp.t_unmock();
    liteServer.t_unmock();
  }
}

const f_boardHandler = (req, res) => {
  const at = req.url.indexOf('?');
  const path = at === -1 ? req.url : req.url.slice(0, at);
  if (path === '/api/echo') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, url: req.url, echo: body || null }));
    });
    return;
  }
  if (path === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
    res.end('body{}');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '未知接口' }));
};

// 私有：等待只读观测条件；超时属于失败边界，不重试任何业务操作。
async function f_waitUntil(predicate) {
  const deadline = AbortSignal.timeout(5000);
  while (!predicate()) { deadline.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
}
const f_freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** 场景：多个服务实例按域名与端口隔离路由，单实例关闭不影响其余。 */
test('多个服务按域名和端口独立路由，关闭互不影响', async () => {
  // 输入：起多个不同域名/端口的服务，逐个关闭并发请求。
  liteHttp.t_mock();
  liteServer.t_mock();
  const board = liteServer.createServer((_req, res) => res.end('board')).listen(0);
  await new Promise(resolve => board.once('listening', resolve));
  const apple = liteServer.createServer((req, res) => res.end(`apple:${req.url}`));
  const ready = new Promise(resolve => apple.once('listening', resolve));
  apple.listen({ host: 'api.example.test', port: 80, virtual: true });
  await ready;
  try {
    assert.deepEqual(apple.address(), { address: 'api.example.test', family: 'virtual', port: 80 }, '虚拟服务应公开监听地址');
    assert.equal((await f_realGet(board.port, '/')).body, 'board', '真实回环请求应抵达看板');
    assert.equal((await i_urlInjectionRequest(liteHttp, { hostname: 'api.example.test', path: '/builds?x=1' })).body, 'apple:/builds?x=1', '指定域名应抵达模拟服务');
    const wrong = await new Promise(resolve => liteHttp.request({ hostname: 'other.example.test', port: 80, path: '/' }).on('error', error => resolve(error.code)).end());
    assert.equal(wrong, 'ECONNREFUSED', '其他域名不能误路由');
    await new Promise(resolve => apple.close(resolve));
    assert.equal(apple.address(), null, '虚拟服务关闭后不应保留监听地址');
    assert.equal((await f_get(board.port, '/')).body, 'board', '关闭模拟服务不能影响看板');
  } finally { liteServer.t_unmock(); liteHttp.t_unmock(); }
});

/** 场景：回环服务与同端口虚拟服务按域名隔离，互不串扰。 */
test('两个回环服务及同端口不同域名的虚拟服务彼此隔离', async () => {
  // 输入：回环服务与同端口双域名虚拟服务并行注册并交替请求。
  liteHttp.t_mock(); liteServer.t_mock();
  const first = liteServer.createServer((_req, res) => res.end('first')).listen(0);
  const second = liteServer.createServer((_req, res) => res.end('second')).listen(0);
  await Promise.all([first, second].map(server => new Promise(resolve => server.once('listening', resolve))));
  const a = liteServer.createServer((_req, res) => res.end('a'));
  const b = liteServer.createServer((_req, res) => res.end('b'));
  await Promise.all([new Promise(resolve => a.listen({ virtual: true, host: 'a.test', port: 443 }, resolve)), new Promise(resolve => b.listen({ virtual: true, host: 'b.test', port: 443 }, resolve))]);
  try {
    assert.equal((await f_realGet(first.port, '/')).body, 'first', '第一个回环服务应保持可达');
    assert.equal((await f_realGet(second.port, '/')).body, 'second', '第二个回环服务应保持可达');
    assert.equal((await i_urlInjectionRequest(liteHttp, { hostname: 'a.test', port: 443, path: '/' })).body, 'a', '域名 a 应路由到 a 服务');
    assert.equal((await i_urlInjectionRequest(liteHttp, { hostname: 'b.test', port: 443, path: '/' })).body, 'b', '相同端口的域名 b 应路由到 b 服务');
    const duplicate = liteServer.createServer((_req, res) => res.end());
    const error = new Promise(resolve => duplicate.once('error', resolve));
    duplicate.listen({ virtual: true, host: 'A.TEST', port: 443 });
    assert.equal((await error).code, 'EADDRINUSE', '相同域名端口不能重复监听');
    assert.throws(() => duplicate.listen({ virtual: true, host: '', port: 0 }), /域名和端口/, '虚拟地址必须完整有效');
    await new Promise(resolve => first.close(resolve));
    assert.equal((await f_realGet(second.port, '/')).body, 'second', '关闭一个服务不得关闭另一个');
  } finally { liteServer.t_unmock(); liteHttp.t_unmock(); }
});

/** 场景：真实 socket 回灌管线与观测账本——真 TCP 流量回包来自真实 handler，账本按契约记录。 */
test('socket 前端：真 TCP GET/POST 回灌管线、账本契约、缓存头区分', async () => {
  // 输入：真 socket 客户端 GET API / GET 静态 / POST API，随后读账本并 resetRequests
  const out = await f_withBoard(f_boardHandler, async (port) => {
    const api = await f_realGet(port, '/api/echo?a=1');
    const asset = await f_realGet(port, '/style.css');
    const post = await f_realPost(port, '/api/echo', '载荷');
    // 账本断言须在 run 内完成：withBoard 收尾 unmock 后账本随实例丢弃
    const recs = liteServer.t_requests().filter((r) => r.path === '/api/echo' || r.path === '/style.css');
    assert.equal(liteServer.liveRequests, undefined, '活账本不应作为公共方法导出');
    const snapshot = liteServer.t_requests();
    liteServer.t_resetRequests(); // 须在 run 内清空：unmock 后无内存账本
    return { api, asset, post, port, recs, snapshotLength: snapshot.length, clearedLength: liteServer.t_requests().length };
  });
  // 预期 1：真实 socket 请求应答真实 handler 的 200
  assert.equal(out.api.status, 200, '真实 socket 请求应答真实 handler 的 200');
  // 预期 2：GET 回包内容来自真实路由代码
  assert.deepEqual(JSON.parse(out.api.body), { ok: true, url: '/api/echo?a=1', echo: null }, 'GET 回包内容应来自真实路由代码');
  // 预期 3：/api/ 保持服务端 no-store
  assert.equal(out.api.headers['cache-control'], 'no-store', '/api/ 保持服务端 no-store（故障与轮询依赖新鲜回包）');
  // 预期 4：非 /api/ 静态资源覆盖为可缓存
  assert.equal(out.asset.headers['cache-control'], 'public, max-age=3600', '非 /api/ 静态资源应覆盖为可缓存');
  // 预期 5：POST 请求体经回灌管线到达 handler
  assert.equal(JSON.parse(out.post.body).echo, '载荷', 'POST 请求体应经回灌管线到达 handler');
  // 预期 6：content-length 按回写字节重算
  assert.equal(Number(out.post.headers['content-length']), Buffer.byteLength(out.post.body), 'content-length 应按回写字节重算');
  const recs = out.recs;
  // 预期 7：账本记录全部到达请求
  assert.equal(recs.length, 3, 'socket 前端账本应记录全部到达请求');
  const [api, asset, post] = recs;
  // 预期 8：账本契约（path 不含查询串、query 单列、body 为请求体文本）
  assert.deepEqual(
    [api.method, api.path, api.query, api.body, asset.query, post.body],
    ['GET', '/api/echo', '?a=1', null, '', '载荷'],
    '账本契约：path 不含查询串（query 单列）、body 为请求体文本',
  );
  // 预期 9：完成请求回填 status
  assert.equal(api.status, 200, '完成请求回填 status');
  // 预期 10：response 带解析后的 JSON 回包
  assert.equal(api.response.json.ok, true, 'response 应带解析后的 JSON 回包');
  // 预期 11：真实路由产物同引 serverResponse
  assert.equal(api.serverResponse, api.response, '真实路由产物应同引 serverResponse');
  // 预期 12：清空内部账本不改变已获取的快照
  assert.equal(out.snapshotLength, 3, '已获取的请求快照应保留原有记录');
  // 预期 13：清空后重新读取快照应为空
  assert.equal(out.clearedLength, 0, 'resetRequests 后的新快照应为空');
});

/** 场景：故障对 socket 流量生效——传输层 503 与服务端 wait 闸门对真 TCP 客户端同样生效。 */
test('socket 故障：传输层 503/服务端闸门对真 socket 生效、账本 serverResponse 区分', async () => {
  // 输入：注入传输层 503（once）后真 socket 两次请求；再注入服务端 wait 闸门，观察早退与放行
  const out = await f_withBoard(f_boardHandler, async (port) => {
    liteHttp.t_inject({ method: 'GET', path: '/api/echo', status: 503, body: { error: '传输不可用' }, once: true });
    const faulted = await f_realGet(port, '/api/echo');
    const recovered = await f_realGet(port, '/api/echo');
    const gate = Promise.withResolvers();
    const removeGate = liteServer.t_inject({ method: 'GET', path: '/style.css', wait: gate.promise });
    const held = f_realGet(port, '/style.css');
    const early = await Promise.race([held, new Promise(resolve => setTimeout(() => resolve({ held: true }), 200))]);
    gate.resolve();
    const released = await held;
    removeGate();
    const recs = liteServer.t_requests();
    return { faulted, recovered, early, released, recs };
  });
  // 预期 1：传输层故障替换真 socket 回包
  assert.equal(out.faulted.status, 503, '传输层故障应替换真 socket 回包');
  // 预期 2：错误正文来自注入规则
  assert.equal(JSON.parse(out.faulted.body).error, '传输不可用', '错误正文应来自注入规则');
  // 预期 3：once 自毁后回到真实回包
  assert.equal(out.recovered.status, 200, 'once 自毁后回到真实回包');
  // 预期 4：闸门放行前真 socket 无回包
  assert.equal(out.early.held, true, 'wait 闸门放行前真 socket 不应有回包');
  // 预期 5：放行后回包送达真实 socket
  assert.equal(out.released.status, 200, '放行后回包送达真实 socket');
  const recs = out.recs;
  const faultRec = recs.find((r) => r.path === '/api/echo' && r.status === 503);
  const gateRec = recs.find((r) => r.path === '/style.css');
  // 预期 6：故障回包入账
  assert.ok(faultRec, '故障回包应入账');
  // 预期 7：账本 response 为最终送达回包
  assert.equal(faultRec.response.json.error, '传输不可用', '账本 response 为最终送达回包');
  // 预期 8：故障替换时账本缺 serverResponse（仅真实路由产物）
  assert.equal(faultRec.serverResponse, undefined, '故障替换时账本缺 serverResponse（仅真实路由产物）');
  // 预期 9：闸门请求入账
  assert.ok(gateRec, '闸门请求应入账');
  // 预期 10：闸门放行后账本回填
  assert.equal(gateRec.status, 200, '闸门放行后账本回填');
  // 预期 11：真实回包账本补 serverResponse
  assert.equal(gateRec.serverResponse, gateRec.response, '真实回包账本补 serverResponse');
});

/** 场景：socket 中断联动取消——闸门挂起期间客户端弃连，放行后不投递、账本停在 status 0。 */
test('socket 中断：弃连联动取消投递、账本停在 status 0、服务继续可用', async () => {
  // 输入：闸门挂起期间真 socket 客户端 50ms 后弃连，放行闸门再发起后续请求
  const out = await f_withBoard(f_boardHandler, async (port) => {
    const gate = Promise.withResolvers();
    const removeGate = liteServer.t_inject({ method: 'GET', path: '/api/echo', wait: gate.promise });
    const dropping = f_realGet(port, '/api/echo', { destroyAfter: 50 }).catch((error) => ({ code: error.code }));
    const dropped = await dropping;
    await f_waitUntil(() => liteServer.t_requests().some(record => record.path === '/api/echo' && record.aborted));
    gate.resolve();
    await f_waitUntil(() => liteServer.t_requests().some(record => record.path === '/api/echo' && record.finished));
    const after = await f_realGet(port, '/style.css');
    removeGate();
    const rec = liteServer.t_requests().find((r) => r.path === '/api/echo');
    return { dropped, after, rec };
  });
  // 预期 1：弃连客户端见到连接错误而非回包
  assert.ok(out.dropped.code !== undefined, '弃连客户端应见连接错误而非回包');
  // 预期 2：中断后服务继续可用
  assert.equal(out.after.status, 200, '中断后服务应继续可用');
  const rec = out.rec;
  // 预期 3：中断请求在账本
  assert.ok(rec, '中断请求应在账本');
  // 预期 4：中断请求账本停在 status 0（对齐旧 route.abort 观测）
  assert.equal(rec.status, 0, '中断请求账本停在 status 0（对齐旧 route.abort 观测）');
  // 预期 5：中断请求不回填 response
  assert.equal(rec.response, undefined, '中断请求不回填 response');
});

/** 场景：闸门失败按管线异常收场——wait promise 拒绝时连接拆除、账本停在 status 0。 */
test('闸门失败：wait 拒绝按请求错误收场、连接拆除、账本不回填', async () => {
  // 输入：注入 wait 已拒绝的闸门后真 socket 请求
  const out = await f_withBoard(f_boardHandler, async (port) => {
    const boom = Promise.reject(new Error('闸门崩溃'));
    boom.catch(() => undefined); // 预挂兜底：注入期无请求消费不触发 unhandledRejection，真实 await 仍按拒绝传播
    const removeGate = liteServer.t_inject({ method: 'GET', path: '/api/echo', wait: boom });
    const failed = await f_realGet(port, '/api/echo').catch((error) => ({ code: error.code }));
    removeGate();
    const rec = liteServer.t_requests().find((r) => r.path === '/api/echo');
    return { failed, rec };
  });
  // 预期 1：闸门失败按请求错误收场（连接拆除）
  assert.ok(out.failed.code !== undefined, '闸门失败应按请求错误收场（连接拆除）');
  // 预期 2：管线异常账本停在 status 0
  assert.equal(out.rec.status, 0, '管线异常账本停在 status 0');
  // 预期 3：管线异常不回填 response
  assert.equal(out.rec.response, undefined, '管线异常不回填 response');
});

/** 场景：防误用守卫——lite-server mock 但 lite-http 未 mock 时 socket 前端明确报错，不外联。 */
test('防误用守卫：lite-http 未 mock 时 socket 前端 500 明确报错、无真实外联', async () => {
  // 输入：仅 mock lite-server 并监听（lite-http 全程未 mock），真 socket 请求
  liteServer.t_mock();
  const server = liteServer.createServer(f_boardHandler).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const refused = await f_realGet(server.port, '/api/echo');
    // 预期 1：收到 500 明确报错
    assert.equal(refused.status, 500, '未 mock lite-http 时 socket 前端应明确报错');
    // 预期 2：报错指引先 liteHttp.t_mock()
    assert.match(refused.body, /liteHttp\.t_mock/, '报错应指引先 liteHttp.t_mock()');
  } finally {
    liteServer.t_unmock();
  }
  // 预期 3：本用例全程 lite-http 未 mock
  assert.equal(liteHttp.isMocked(), false, '本用例全程 lite-http 未 mock');
});

/** 场景：端口策略与关停——动态口/显式口绑定、unmock 真实关停拒连、未 mock 门面空态。 */
test('端口策略与关停：动态/显式口、unmock 关停拒连、未 mock 空态', async () => {
  // 输入：未 mock 时查询端口与账本
  // 预期 1：无绑定端口（null）
  assert.equal(liteServer.t_port(), null, '未 mock 时无绑定端口');
  // 预期 2：账本为空集
  assert.deepEqual(liteServer.t_requests(), [], '未 mock 时账本为空集');
  // 输入：第一段会话——缺省 listen 动态空闲口
  liteHttp.t_mock();
  liteServer.t_mock();
  const dynamic = liteServer.createServer(f_boardHandler);
  dynamic.listen(); // 缺省：动态空闲口
  await new Promise((resolve) => dynamic.once('listening', resolve));
  // 预期 3：动态口为非 0 的实际绑定值
  assert.ok(Number.isInteger(liteServer.t_port()) && liteServer.t_port() > 0, '缺省 listen 应绑动态空闲口（非 0）');
  // 输入：真 socket 请求动态口
  const dynamicHit = await f_realGet(liteServer.t_port(), '/style.css');
  // 预期 4：动态口真实可达
  assert.equal(dynamicHit.status, 200, '动态口真实可达');
  liteServer.t_unmock();
  liteHttp.t_unmock();
  // 输入：第二段会话——显式端口绑定
  const explicit = await f_freePort();
  liteHttp.t_mock();
  liteServer.t_mock();
  const pinned = liteServer.createServer(f_boardHandler).listen(explicit);
  await new Promise((resolve) => pinned.once('listening', resolve));
  // 预期 5：显式端口绑定该口
  assert.equal(pinned.port, explicit, '显式端口应绑定该口');
  // 预期 6：门面暴露实际绑定端口
  assert.equal(liteServer.t_port(), explicit, '门面应暴露实际绑定端口');
  // 输入：真 socket 请求显式口
  const hit = await f_realGet(explicit, '/style.css');
  // 预期 7：显式口真实可达
  assert.equal(hit.status, 200, '显式口真实可达');
  // 输入：等待真实 socket 的关闭事件，再独立验证端口拒连。
  const closed = new Promise(resolve => pinned.once('close', resolve));
  liteServer.t_unmock();
  await closed;
  const refused = await new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: explicit, path: '/' }, response => { response.resume(); resolve({ connected: true }); });
    req.on('error', error => resolve({ code: error.code }));
  });
  // 预期 8：unmock 后真实 socket 关停拒连
  assert.equal(refused.code, 'ECONNREFUSED', 'unmock 后真实 socket 应关停拒连');
  liteHttp.t_unmock();
});

/** 场景：URL 定向故障在内存直调和真实 socket 回灌中一致，保留 Host、方法与查询隔离。 */
test('URL 回灌：两层故障、Host 来源、方法、查询与 once 一致', async () => {
  await f_withBoard((req, res) => res.end('handler'), async port => {
    for (const injector of [liteHttp, liteServer]) {
      for (const client of [liteHttp, http]) {
        const send = (path, extra = {}) => i_urlInjectionRequest(client, { hostname: '127.0.0.1', port, path, headers: { Host: `public.test:${port}` }, ...extra });
        // 输入：socket 连接仍指向回环地址，注入 URL 使用原始 Host，并同时限定 POST 和查询串
        injector.t_inject({ url: `http://public.test:${port}/same?a=1`, method: 'POST', status: 503, once: true });
        const misses = [await send('/same?a=2', { method: 'POST' }), await send('/same?a=1'),
          await send('/same?a=1', { method: 'POST', headers: { Host: `other.test:${port}` } })];
        // 预期 1：未命中的查询、方法与 Host 不消耗 once，直调与回灌结果一致
        assert.deepEqual(misses.map(out => out.status), [200, 200, 200], '其他 URL 或方法应收到真实回包');
        assert.equal((await send('/same?a=1', { method: 'POST' })).status, 503, '原始 Host 的完整 URL 应命中');
        assert.equal((await send('/same?a=1', { method: 'POST' })).status, 200, '命中后 once 应自毁');
        // 输入：路径 URL 不限定 origin，fragment 忽略，重复查询参数顺序精确
        const remove = injector.t_inject({ url: '/same?x=1&x=2#ignored', status: 502 });
        // 预期 2：两条请求管线都保留路径 URL 的完整查询语义
        assert.equal((await send('/same?x=1&x=2')).status, 502, '路径 URL 应命中任意 Host');
        assert.equal((await send('/same?x=2&x=1')).status, 200, '查询参数顺序不能颠倒');
        remove(); remove();
        assert.equal((await send('/same?x=1&x=2')).status, 200, '移除 URL 规则应幂等恢复');
      }
    }
    // 预期 3：服务端非法 URL 在登记时拒绝
    for (const url of ['', 'relative', '//example.test/same', 'ftp://example.test/same', 1, {}])
      assert.throws(() => liteServer.t_inject({ url, status: 503 }), /url/, '非法 URL 应在注入时拒绝');
  });
});

/** 场景：URL 定向 wait 只挂起目标请求，未命中正常响应，once 在放行前已消耗。 */
test('URL 闸门：两层 wait 只挂目标、未命中直通、once 放行前自毁', async () => {
  await f_withBoard((req, res) => res.end('handler'), async port => {
    for (const injector of [liteHttp, liteServer]) {
      const gate = Promise.withResolvers();
      const send = path => i_urlInjectionRequest(http, { hostname: '127.0.0.1', port, path });
      injector.t_inject({ url: '/same?held=1', wait: gate.promise, once: true });
      let settled = false;
      // 输入：真实 socket 请求命中路径 URL 闸门，另一个查询 URL 不命中
      const before = liteServer.t_requests().length;
      const held = send('/same?held=1').then(out => { settled = true; return out; });
      try {
        await f_waitUntil(() => liteServer.t_requests().length > before);
        assert.equal(liteServer.t_requests().length, before + 1, '目标请求应已进入回灌管线');
        // 预期 1：目标仍等待，未命中 URL 与第二次目标请求均不被 once 闸门挂住
        assert.equal(settled, false, '目标 URL 应等待闸门');
        assert.equal((await send('/same?held=2')).status, 200, '其他查询应直通');
        assert.equal((await send('/same?held=1')).status, 200, 'once 应在首个请求命中时消耗');
      } finally { gate.resolve(); await held; }
      // 预期 2：放行后目标仍收到真实 handler 回包
      assert.equal((await held).body, 'handler', '闸门放行后应保留真实回包');
    }
  });
});

/** 场景：异步 handler 拒绝时回 500，同一服务后续请求仍能正常完成。 */
test('异步 handler 失败：拒绝转为 500，后续请求仍成功', async () => {
  // 输入：通过服务创建接口登记会拒绝的业务 handler，经真实 socket 请求触发
  await f_withBoard(async (req, res) => {
    if (req.url === '/reject') throw new Error('handler-rejected');
    res.end('healthy');
  }, async port => {
    const failed = await f_realGet(port, '/reject');
    const healthy = await f_realGet(port, '/healthy');
    // 预期：错误作为响应可见，不破坏后续请求
    assert.equal(failed.status, 500, '异步拒绝应得到 500');
    assert.deepEqual(JSON.parse(failed.body), { error: 'handler-rejected' }, '回包应说明 handler 失败原因');
    assert.equal(healthy.status, 200, '后续请求应正常响应');
    assert.equal(healthy.body, 'healthy', '后续回包应来自 handler');
  });
});
