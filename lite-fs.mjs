// lite-fs：node:fs 的可切换门面，机制与 lite-http / lite-spawn 一致——但按作用域收窄：
// 只接管「系统运行数据」。作用域为黑名单制：mock({ exclude }) 声明排除目录（模块源码、
// 静态资源、代码 mtime 探测等系统本体所在），排除目录外**全部**落内存卷——测试世界的越界
// 写不可能穿透真实磁盘（白名单口径曾让未声明路径静默走真实 fs，已废弃）。内存卷带真 fs
// 错误语义（ENOENT/EEXIST/EISDIR/ENOTDIR/ENOTEMPTY/EBADF）。默认（未 mock）全量转发真实
// node:fs，生产行为不变。错误注入是内存实现上的能力：inject({ op?, path?, code }) 对卷内
// 命中操作抛指定 code 的 fs 错误（如 EACCES 模拟写入失败），返回移除函数；op 省略匹配全部
// 操作，path 精确匹配。多路径操作（rename/copy/symlink）按首个路径参数判定作用域；卷内触
// 到未实现的 fs 面会明确报错（不静默落真实磁盘）。unmock() 移除内存实现（卷与规则随实例
// 丢弃）。状态为模块级单例：同进程内经同一 specifier 导入共享同一实例。
import fs from 'node:fs';
import path from 'node:path';

function createMemoryFs() {
    const faults = [];
    const matches = (fault, op, target) => (!fault.op || fault.op === op) && (!fault.path || fault.path === target);
    const fail = (code, syscall, target) => {
        const error = new Error(`${code}: ${syscall} 失败（lite-fs 内存卷）：${target}`);
        error.code = code;
        error.syscall = syscall;
        error.path = target;
        throw error;
    };
    // 目录树：{ dirs: Map<name, dir>, files: Map<name, { data: Buffer, mtimeMs, symlink?: string }> }
    const root = { dirs: new Map(), files: new Map() };
    const split = (target) => path.resolve(String(target)).split(path.sep).filter(Boolean);
    const dirOf = (target) => {
        let node = root;
        for (const name of split(target)) {
            const next = node.dirs.get(name);
            if (!next)
                return undefined;
            node = next;
        }
        return node;
    };
    const entryOf = (target) => {
        const names = split(target);
        const name = names.pop();
        const parent = names.length ? dirOf(`${path.sep}${names.join(path.sep)}`) : root;
        return parent ? { parent, name } : undefined;
    };
    const guard = (op, target) => {
        const resolved = path.resolve(String(target ?? ''));
        const fault = faults.find(rule => matches(rule, op, resolved));
        if (fault)
            fail(fault.code, op, resolved);
    };
    const toBuffer = (data) => Buffer.isBuffer(data) ? Buffer.from(data)
        : data instanceof Uint8Array ? Buffer.from(data)
            : Buffer.from(String(data));

    const impl = {
        existsSync(target) {
            const hit = entryOf(target);
            if (hit && (hit.parent.dirs.has(hit.name) || hit.parent.files.has(hit.name)))
                return true;
            return dirOf(target) !== undefined;
        },
        mkdirSync(target, options = {}) {
            guard('mkdirSync', target);
            const names = split(target);
            let node = root;
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                if (node.files.has(name)) {
                    if (i === names.length - 1 && !options.recursive)
                        fail('EEXIST', 'mkdir', target);
                    fail('ENOTDIR', 'mkdir', target);
                }
                let next = node.dirs.get(name);
                if (!next) {
                    if (i < names.length - 1 && !options.recursive)
                        fail('ENOENT', 'mkdir', target);
                    next = { dirs: new Map(), files: new Map() };
                    node.dirs.set(name, next);
                }
                else if (i === names.length - 1 && !options.recursive)
                    fail('EEXIST', 'mkdir', target);
                node = next;
            }
        },
        writeFileSync(target, data) {
            if (Number.isInteger(target)) {
                const rec = fds.get(target);
                if (!rec) fail('EBADF', 'write', String(target));
                if (String(rec.flags).includes('a')) impl.appendFileSync(rec.file, data);
                else impl.writeFileSync(rec.file, data);
                return;
            }
            guard('writeFileSync', target);
            const hit = entryOf(target);
            if (!hit || hit.parent.dirs.has(hit.name))
                fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            hit.parent.files.set(hit.name, { data: toBuffer(data), mtimeMs: Date.now() });
        },
        appendFileSync(target, data) {
            guard('appendFileSync', target);
            const hit = entryOf(target);
            if (!hit || hit.parent.dirs.has(hit.name))
                fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            const existing = hit.parent.files.get(hit.name);
            const buffer = toBuffer(data);
            hit.parent.files.set(hit.name, existing
                ? { data: Buffer.concat([existing.data, buffer]), mtimeMs: Date.now() }
                : { data: buffer, mtimeMs: Date.now() });
        },
        readFileSync(target, encoding) {
            guard('readFileSync', target);
            const hit = entryOf(target);
            if (!hit || !hit.parent.files.has(hit.name))
                fail(dirOf(target) !== undefined ? 'EISDIR' : 'ENOENT', 'open', target);
            const file = hit.parent.files.get(hit.name);
            return encoding ? file.data.toString(encoding) : Buffer.from(file.data);
        },
        readdirSync(target) {
            guard('readdirSync', target);
            const hit = entryOf(target);
            if (hit && hit.parent.files.has(hit.name))
                fail('ENOTDIR', 'scandir', target);
            const node = dirOf(target);
            if (!node)
                fail('ENOENT', 'scandir', target);
            return [...node.dirs.keys(), ...node.files.keys()];
        },
        statSync(target) { return stat(target, false); },
        lstatSync(target) { return stat(target, true); },
        rmSync(target, options = {}) {
            guard('rmSync', target);
            const hit = entryOf(target);
            if (!hit || !(hit.parent.dirs.has(hit.name) || hit.parent.files.has(hit.name))) {
                if (!options.force)
                    fail('ENOENT', 'rm', target);
                return;
            }
            if (hit.parent.dirs.has(hit.name) && !options.recursive) {
                const node = hit.parent.dirs.get(hit.name);
                if (node.dirs.size || node.files.size)
                    fail('ENOTEMPTY', 'rm', target);
            }
            hit.parent.dirs.delete(hit.name);
            hit.parent.files.delete(hit.name);
        },
        rmdirSync(target) {
            guard('rmdirSync', target);
            const hit = entryOf(target);
            if (!hit || !hit.parent.dirs.has(hit.name))
                fail(hit && hit.parent.files.has(hit.name) ? 'ENOTDIR' : 'ENOENT', 'rmdir', target);
            const node = hit.parent.dirs.get(hit.name);
            if (node.dirs.size || node.files.size)
                fail('ENOTEMPTY', 'rmdir', target);
            hit.parent.dirs.delete(hit.name);
        },
        unlinkSync(target) {
            guard('unlinkSync', target);
            const hit = entryOf(target);
            if (!hit || !hit.parent.files.has(hit.name))
                fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'unlink', target);
            hit.parent.files.delete(hit.name);
        },
        renameSync(from, to) {
            guard('renameSync', from);
            const src = entryOf(from), dst = entryOf(to);
            if (!src || !(src.parent.dirs.has(src.name) || src.parent.files.has(src.name)))
                fail('ENOENT', 'rename', from);
            if (!dst)
                fail('ENOENT', 'rename', to);
            if (dst.parent.files.has(dst.name))
                dst.parent.files.delete(dst.name);
            if (dst.parent.dirs.has(dst.name))
                dst.parent.dirs.delete(dst.name);
            if (src.parent.files.has(src.name)) {
                dst.parent.files.set(dst.name, src.parent.files.get(src.name));
                src.parent.files.delete(src.name);
                return;
            }
            dst.parent.dirs.set(dst.name, src.parent.dirs.get(src.name));
            src.parent.dirs.delete(src.name);
        },
        copyFileSync(from, to) {
            guard('copyFileSync', from);
            const content = impl.readFileSync(from);
            impl.writeFileSync(to, content);
        },
        cpSync(from, to) {
            guard('cpSync', from);
            if (!impl.existsSync(from))
                fail('ENOENT', 'cp', from);
            if (impl.statSync(from).isDirectory()) {
                impl.mkdirSync(to, { recursive: true });
                for (const name of impl.readdirSync(from))
                    impl.cpSync(path.join(String(from), name), path.join(String(to), name));
                return;
            }
            impl.writeFileSync(to, impl.readFileSync(from));
        },
        accessSync(target) {
            guard('accessSync', target);
            if (!impl.existsSync(target))
                fail('ENOENT', 'access', target);
        },
        realpathSync(target) {
            guard('realpathSync', target);
            const resolved = path.resolve(String(target));
            if (!impl.existsSync(resolved))
                fail('ENOENT', 'realpath', target);
            return resolved;
        },
        chmodSync() { /* 内存卷无权限语义：记账为 no-op */ },
        symlinkSync(target, linkPath) {
            guard('symlinkSync', linkPath);
            const hit = entryOf(linkPath);
            if (!hit || hit.parent.dirs.has(linkPath === undefined ? undefined : hit.name))
                fail('ENOENT', 'symlink', linkPath);
            hit.parent.files.set(hit.name, { data: Buffer.alloc(0), mtimeMs: Date.now(), symlink: String(target) });
        },
        // 最小 fd 面：serveCmd 冷启动经 fs.openSync(logFile,'a') 拿 stdio fd——内存卷按打开即建
        openSync(target, flags = 'r') {
            guard('openSync', target);
            const hit = entryOf(target);
            if (!hit)
                fail('ENOENT', 'open', target);
            if ((flags.includes('a') || flags.includes('w')) && !hit.parent.files.has(hit.name) && !hit.parent.dirs.has(hit.name))
                hit.parent.files.set(hit.name, { data: Buffer.alloc(0), mtimeMs: Date.now() });
            if (!hit.parent.files.has(hit.name))
                fail(hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            const fd = ++fdSeq;
            fds.set(fd, { file: String(target), flags: String(flags || 'r') }); // 记录 flags：fd 写入按 open 语义落点
            return fd;
        },
        closeSync(fd) {
            if (!fds.delete(fd))
                fail('EBADF', 'close', String(fd));
        },
        fdInUse(fd) { return fds.has(fd); },
        // realpath：内存卷无符号链接，等价 resolve（git-flow 定位仓库根等调用路径）
        realpathSync(target) {
            guard('realpathSync', target);
            return path.resolve(String(target));
        },
        // 最小读流（零依赖）：on/pipe 消费面，整体缓冲一跳推 data、再推 end——不背压不切片；
        // 不引 node:events，保持 lite-fs 仅依赖 node:fs/node:path（可进模块白名单受控环境）。
        createReadStream(target) {
            const listeners = new Map();
            const emit = (event, ...values) => { for (const fn of listeners.get(event) ?? []) fn(...values); };
            const stream = {
                on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return stream; },
                pipe(dest) {
                    stream.on('data', (chunk) => dest.write(chunk));
                    stream.on('end', () => dest.end());
                    return stream;
                },
            };
            queueMicrotask(() => {
                try {
                    emit('data', impl.readFileSync(target));
                    emit('end');
                }
                catch (error) {
                    emit('error', error);
                }
            });
            return stream;
        },
        inject(fault) {
            if (!fault || typeof fault.code !== 'string' || !fault.code)
                throw new Error('lite-fs 注入必须指定错误 code（如 EACCES / EIO / ENOSPC）');
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
    };
    function stat(target, linkOnly) {
        guard(linkOnly ? 'lstatSync' : 'statSync', target);
        const hit = entryOf(target);
        if (hit && hit.parent.files.has(hit.name)) {
            const file = hit.parent.files.get(hit.name);
            return {
                isFile: () => true, isDirectory: () => false, isSymbolicLink: () => Boolean(file.symlink),
                size: file.data.length, mtimeMs: file.mtimeMs, atimeMs: file.mtimeMs, birthtimeMs: file.mtimeMs,
            };
        }
        const node = dirOf(target);
        if (node !== undefined)
            return {
                isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
                size: 0, mtimeMs: 0, atimeMs: 0, birthtimeMs: 0,
            };
        fail('ENOENT', 'stat', target);
    }
    let fdSeq = 100;
    const fds = new Map();
    return { impl };
}

let memory = null; // 未设置 → 默认实现（真实 node:fs 全量转发）；{ impl, list }

const mock = ({ exclude } = {}) => {
    if (memory)
        return memory;
    if (!Array.isArray(exclude) || !exclude.length)
        throw new Error('lite-fs.mock 需要非空 exclude：声明排除目录（系统本体留在真实 fs），其余全落内存卷');
    memory = createMemoryFs();
    memory.list = exclude.map(entry => path.resolve(String(entry)));
    return memory;
};
const unmock = () => { memory = null; };
const inject = (fault) => {
    if (!memory)
        throw new Error('lite-fs.inject 需先 mock() 设置内存实现');
    return memory.impl.inject(fault);
};
// 作用域判定：目标不在任何排除目录内（排除目录本身或其子路径除外）即走内存卷——
// 越界写不可能穿透真实磁盘
const scoped = (target) => {
    if (typeof target !== 'string')
        return false;
    const resolved = path.resolve(target);
    return !memory.list.some(entry => resolved === entry || resolved.startsWith(entry + path.sep));
};

const facade = new Proxy({}, {
    get(_target, prop) {
        if (typeof prop === 'symbol')
            return Reflect.get(fs, prop);
        if (prop === 'mock')
            return mock;
        if (prop === 'unmock')
            return unmock;
        if (prop === 'inject')
            return inject;
        if (!memory)
            return fs[prop];
        if (prop === 'constants')
            return fs.constants;
        const memoryFn = typeof memory.impl[prop] === 'function' ? memory.impl[prop] : null;
        const realFn = typeof fs[prop] === 'function' ? fs[prop] : null;
        if (!memoryFn && !realFn)
            return fs[prop];
        return (...args) => {
            // fd 首参操作（writeFileSync/closeSync 等以整型 fd 开头）：fd 在内存卷登记则整条
            // 操作落内存实现——否则数据载荷（字符串）会被误判为根外路径，透传真实 fs 拿
            // 虚拟 fd 写出 EBADF；未登记的 fd（真实 stdio 等）按原样走真实 fs
            if (Number.isInteger(args[0])) {
                if (memory?.impl.fdInUse(args[0])) {
                    if (!memoryFn)
                        throw new Error(`lite-fs 内存实现未覆盖 fd 操作 fs.${String(prop)}——补充实现`);
                    return memoryFn(...args);
                }
                return realFn ? realFn(...args) : fs[prop](...args);
            }
            // 作用域判定按首个路径参数：readFileSync 的 encoding、flags 等字符串载荷不是路径，
            // 混入判定会让排除目录内的文件被误路由进内存卷（黑名单模式下 'utf8' 恒视为卷内
            // 路径）；多路径操作（rename/copy/cp）同样按首个路径定作用域，跨界操作源需已在卷内。
            // 无路径参数的操作（fd 类已在上文分流）有内存实现则落内存卷。
            const pathArg = typeof args[0] === 'string' ? args[0] : null;
            if ((pathArg !== null && scoped(pathArg)) || (pathArg === null && memoryFn)) {
                if (!memoryFn)
                    throw new Error(`lite-fs 内存实现未覆盖根内操作 fs.${String(prop)}——补充实现，或确认该路径属于运行数据`);
                return memoryFn(...args);
            }
            // 根外是系统本体/用户文件：原样走真实 fs（模块源码、静态资源、mtime 探测等）
            return realFn ? realFn(...args) : fs[prop](...args);
        };
    },
});

export default facade;
