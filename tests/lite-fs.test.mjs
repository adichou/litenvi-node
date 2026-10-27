// lite-fs 门面用例：默认全量转发真实 node:fs；mock({ roots }) 只把声明根内的运行数据操作切到
// 内存卷（真实 fs 错误语义），根外（模块源码等系统本体）一律走真实 fs；inject 注入 fs 错误；
// unmock 回真实实现。
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import liteFs from '../lite-fs.mjs';
import { runCases } from './run-cases.mjs';

const selfFile = new URL(import.meta.url).pathname; // 系统本体文件（真实磁盘）
const ROOT = '/data/lite-fs-root'; // 运行数据根（真实磁盘不存在的绝对路径）

await runCases([
    /** 场景：默认真实实现；输入：未 mock 时读系统本体文件；预期：与 node:fs 完全一致。 */
    async function defaultDelegatesToNodeFs() {
        assert.equal(liteFs.existsSync(selfFile), true, '真实文件应可见');
        assert.equal(liteFs.readFileSync(selfFile, 'utf8'), realFs.readFileSync(selfFile, 'utf8'), '内容应与真实 fs 一致');
    },
    /** 场景：roots 必填；输入：mock() 不带 roots；预期：拒绝（系统本体不得误入内存卷）。 */
    async function mockRequiresRoots() {
        assert.throws(() => liteFs.mock(), /roots/, '无声明根应拒绝 mock');
    },
    /** 场景：根内内存卷基本面；输入：mkdir/write/read/append/readdir/stat；预期：内存读写自洽。 */
    async function memoryVolumeBasics() {
        liteFs.mock({ roots: [ROOT] });
        try {
            liteFs.mkdirSync(`${ROOT}/a/b`, { recursive: true });
            liteFs.writeFileSync(`${ROOT}/a/b/x.txt`, 'hello');
            liteFs.appendFileSync(`${ROOT}/a/b/x.txt`, ' lite-fs');
            assert.equal(liteFs.readFileSync(`${ROOT}/a/b/x.txt`, 'utf8'), 'hello lite-fs', '字符串读写应自洽');
            assert.ok(Buffer.isBuffer(liteFs.readFileSync(`${ROOT}/a/b/x.txt`)), '无 encoding 应返回 Buffer');
            assert.deepEqual(liteFs.readdirSync(`${ROOT}/a/b`), ['x.txt'], '目录清单应只含写入文件');
            const st = liteFs.statSync(`${ROOT}/a/b/x.txt`);
            assert.equal(st.isFile(), true, '文件 stat 应 isFile');
            assert.equal(st.size, 'hello lite-fs'.length, 'size 应为内容长度');
            assert.equal(liteFs.statSync(`${ROOT}/a/b`).isDirectory(), true, '目录 stat 应 isDirectory');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：真实错误语义；输入：缺失路径/缺父目录/重复建目录/对文件 readdir/非空 rm；预期：ENOENT/EEXIST/ENOTDIR/ENOTEMPTY/EISDIR。 */
    async function realErrorCodeSemantics() {
        liteFs.mock({ roots: [ROOT] });
        try {
            liteFs.mkdirSync(`${ROOT}/d`, { recursive: true });
            liteFs.writeFileSync(`${ROOT}/d/f`, 'x');
            assert.throws(() => liteFs.readFileSync(`${ROOT}/missing`), e => e.code === 'ENOENT', '读缺失文件应 ENOENT');
            assert.throws(() => liteFs.writeFileSync(`${ROOT}/no-such/f`, 'x'), e => e.code === 'ENOENT', '缺父目录写入应 ENOENT');
            assert.throws(() => liteFs.mkdirSync(`${ROOT}/d`), e => e.code === 'EEXIST', '非递归重复建目录应 EEXIST');
            assert.throws(() => liteFs.readdirSync(`${ROOT}/d/f`), e => e.code === 'ENOTDIR', '对文件 readdir 应 ENOTDIR');
            assert.throws(() => liteFs.rmSync(`${ROOT}/d`), e => e.code === 'ENOTEMPTY', '非空目录非递归 rm 应 ENOTEMPTY');
            assert.throws(() => liteFs.unlinkSync(`${ROOT}/d`), e => e.code === 'EISDIR', '对目录 unlink 应 EISDIR');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：根外系统本体；输入：mock 后读源码文件；预期：原样走真实 fs，不经内存卷。 */
    async function outsideRootsStaysReal() {
        liteFs.mock({ roots: [ROOT] });
        try {
            assert.equal(liteFs.existsSync(selfFile), true, '根外真实文件应仍可见');
            assert.equal(liteFs.readFileSync(selfFile, 'utf8'), realFs.readFileSync(selfFile, 'utf8'), '根外读取应与真实 fs 一致');
            assert.equal(liteFs.existsSync(`${ROOT}/x`), false, '根内路径应走内存卷（真实磁盘本无此文件）');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：移动/复制/递归删除；输入：rename/copyFile/cp -r/rm -r；预期：树操作自洽。 */
    async function treeOperations() {
        liteFs.mock({ roots: [ROOT] });
        try {
            liteFs.mkdirSync(`${ROOT}/t/sub`, { recursive: true });
            liteFs.writeFileSync(`${ROOT}/t/sub/a`, '1');
            liteFs.writeFileSync(`${ROOT}/t/b`, '2');
            liteFs.renameSync(`${ROOT}/t/b`, `${ROOT}/t/c`);
            assert.equal(liteFs.readFileSync(`${ROOT}/t/c`, 'utf8'), '2', 'rename 后内容应保留');
            liteFs.copyFileSync(`${ROOT}/t/c`, `${ROOT}/t/d`);
            liteFs.cpSync(`${ROOT}/t/sub`, `${ROOT}/t/copy`);
            assert.equal(liteFs.readFileSync(`${ROOT}/t/copy/a`, 'utf8'), '1', 'cp 递归应复制子树');
            liteFs.rmSync(`${ROOT}/t`, { recursive: true, force: true });
            assert.equal(liteFs.existsSync(`${ROOT}/t`), false, '递归删除后应不存在');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：fd 面；输入：openSync('a')/closeSync；预期：fd 数字、内容可读、坏 fd EBADF。 */
    async function fdSurface() {
        liteFs.mock({ roots: [ROOT] });
        try {
            liteFs.mkdirSync(ROOT, { recursive: true });
            const fd = liteFs.openSync(`${ROOT}/log.txt`, 'a');
            assert.equal(typeof fd, 'number', 'openSync 应返回 fd');
            liteFs.appendFileSync(`${ROOT}/log.txt`, 'line');
            liteFs.closeSync(fd);
            assert.equal(liteFs.readFileSync(`${ROOT}/log.txt`, 'utf8'), 'line', '打开即建的文件应可读写');
            assert.throws(() => liteFs.closeSync(fd), e => e.code === 'EBADF', '重复 close 应 EBADF');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：错误注入；输入：对写入路径注入 EACCES；预期：写入抛错、读取不受影响、撤销恢复。 */
    async function injectedFaultScopesToOp() {
        liteFs.mock({ roots: [ROOT] });
        try {
            liteFs.mkdirSync(ROOT, { recursive: true });
            liteFs.writeFileSync(`${ROOT}/f`, 'seed');
            const remove = liteFs.inject({ op: 'writeFileSync', path: `${ROOT}/f`, code: 'EACCES' });
            assert.throws(() => liteFs.writeFileSync(`${ROOT}/f`, 'x'), e => e.code === 'EACCES', '命中注入的写入应抛 EACCES');
            assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'seed', '读取不受写入注入影响');
            remove();
            liteFs.writeFileSync(`${ROOT}/f`, 'ok');
            assert.equal(liteFs.readFileSync(`${ROOT}/f`, 'utf8'), 'ok', '撤销注入后写入应恢复');
        }
        finally {
            liteFs.unmock();
        }
    },
    /** 场景：根内未实现面与前置约束；输入：未实现函数在根内调用、未 mock 即 inject；预期：明确报错。 */
    async function unsupportedSurfaceIsLoud() {
        liteFs.mock({ roots: [ROOT] });
        try {
            assert.throws(() => liteFs.truncateSync(`${ROOT}/f`), /未覆盖/, '根内未实现操作应明确报错而非落真实磁盘');
        }
        finally {
            liteFs.unmock();
        }
        assert.throws(() => liteFs.inject({ code: 'EACCES' }), /先 mock/, '未设置内存实现时注入应拒绝');
    },
    /** 场景：幂等与恢复；输入：重复 mock 保留卷、unmock 后根内路径按真实 fs 语义；预期：状态随实例。 */
    async function mockIdempotentAndUnmockDropsVolume() {
        liteFs.mock({ roots: [ROOT] });
        liteFs.mkdirSync(ROOT, { recursive: true });
        liteFs.writeFileSync(`${ROOT}/keep`, 'x');
        liteFs.mock({ roots: [ROOT] });
        assert.equal(liteFs.readFileSync(`${ROOT}/keep`, 'utf8'), 'x', '重复 mock 不应丢弃内存卷');
        liteFs.unmock();
        assert.equal(liteFs.existsSync(`${ROOT}/keep`), false, 'unmock 后应回到真实 fs（该路径真实磁盘不存在）');
    },
]);
