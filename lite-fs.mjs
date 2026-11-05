// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-fs：node:fs 的可切换门面，机制与 lite-http / lite-child_process 一致——但按作用域收窄：
// 只接管「系统运行数据」。作用域为黑名单制：mock({ exclude }) 声明排除目录（模块源码、
// 静态资源、代码 mtime 探测等系统本体所在），排除目录外**全部**落内存卷——测试世界的越界
// 写不可能穿透真实磁盘（白名单口径曾让未声明路径静默走真实 fs，已废弃）。内存卷带真 fs
// 错误语义（ENOENT/EEXIST/EISDIR/ENOTDIR/ENOTEMPTY/EBADF）。默认（未 mock）全量转发真实
// node:fs，生产行为不变。错误注入是内存实现上的能力：inject({ op?, path?, code }) 对卷内
// 命中操作抛指定 code 的 fs 错误（如 EACCES 模拟写入失败），返回移除函数；op 省略匹配全部
// 操作，path 精确匹配。多路径操作默认按首个路径参数判定作用域；copyFileSync 从排除目录
// 复制到卷内时读取真实源并写入内存目标，不向真实目标写入；卷内触
// 到未实现的 fs 面会明确报错（不静默落真实磁盘）。t_unmock() 移除内存实现（卷与规则随实例
// 丢弃；markPersistent 登记的持久根子树除外——unmock 时快照、下次 mock 建卷后恢复，跨卷
// 复位存活，其余内容清零由世界自播种）。持久根是通用机制：lite-fs 不认识任何具体根（命令
// 系统卷 /mock-cmd 由 lite-cmd-mgr 登记）。状态为模块级单例：同进程内经同一 specifier 导入
// 共享同一实例。utimesSync 更新卷内文件 mtimeMs（目录无时间面记为 no-op；时间参数接受
// Date/毫秒数/日期字符串）。fd 0 支持管道型暂存记录（pkg_stageStdin，包内协作）：虚拟命令
// 运行期 readFileSync(0)/readSync(0) 同步返回 spawnSync 输入快照，写侧 EBADF——stdin 协议类
// 黑盒的同步读面。
import fs from 'node:fs';
import path from 'node:path';

// 目录树节点深拷贝：快照与恢复两侧隔离（卷内后续变更不污染快照、恢复不与快照共享引用）
// 私有方法：复制目录树快照；仅在本文件实现中使用，不导出。
function f_cloneNode(node) {
    return {
        dirs: new Map([...node.dirs].map(([name, child]) => [name, f_cloneNode(child)])),
        files: new Map([...node.files].map(([name, file]) => [name, { ...file, data: Buffer.from(file.data) }])),
    };
}

// 私有方法：创建内存文件系统；仅在本文件实现中使用，不导出。
function f_createMemoryFs() {
    const faults = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_matches = (fault, op, target) => (!fault.op || fault.op === op)
        && (typeof fault.matches === 'function' ? fault.matches(target) : (!fault.path || fault.path === target));
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_fail = (code, syscall, target) => {
        const error = new Error(`${code}: ${syscall} 失败（lite-fs 内存卷）：${target}`);
        error.code = code;
        error.syscall = syscall;
        error.path = target;
        throw error;
    };
    // 目录树：{ dirs: Map<name, dir>, files: Map<name, { data: Buffer, mtimeMs, symlink?: string }> }
    const root = { dirs: new Map(), files: new Map() };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_split = (target) => path.resolve(String(target)).split(path.sep).filter(Boolean);
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_dirOf = (target) => {
        let node = root;
        for (const name of f_split(target)) {
            const next = node.dirs.get(name);
            if (!next)
                return undefined;
            node = next;
        }
        return node;
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_entryOf = (target) => {
        const names = f_split(target);
        const name = names.pop();
        const parent = names.length ? f_dirOf(`${path.sep}${names.join(path.sep)}`) : root;
        return parent ? { parent, name } : undefined;
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_guard = (op, target) => {
        const resolved = path.resolve(String(target ?? ''));
        // 私有方法：仅在本文件实现中使用，不导出。
        const fault = faults.find(rule => f_matches(rule, op, resolved));
        if (fault) {
            if (fault.error)
                throw fault.error;
            f_fail(fault.code, op, resolved);
        }
    };
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_toBuffer = (data) => Buffer.isBuffer(data) ? Buffer.from(data)
        : data instanceof Uint8Array ? Buffer.from(data)
            : Buffer.from(String(data));

    // 私有方法：utimes 时间参数解析（Date | 毫秒数 | 日期字符串），非法形态按 TypeError 明确报错。
    // 私有实现：仅在本文件实现中使用，不导出。
    function f_timeMsOf(value, name) {
        const ms = value instanceof Date ? value.getTime()
            : typeof value === 'string' ? Date.parse(value)
                : Number(value);
        if (!Number.isFinite(ms))
            throw new TypeError(`lite-fs utimes 的 ${name} 必须是 Date、毫秒数或可解析的日期字符串`);
        return ms;
    }

    // 私有方法：解析读取路径中的符号链接；相对目标以链接父目录为基准，循环按 ELOOP 失败。
    function f_readFileData(target) {
        let names = f_split(target), node = root, links = 0;
        for (let i = 0; i < names.length; i++) {
            const name = names[i], file = node.files.get(name);
            if (file?.symlink !== undefined) {
                if (++links > 40) f_fail('ELOOP', 'open', target);
                const parent = path.sep + names.slice(0, i).join(path.sep);
                names = f_split(path.resolve(parent, file.symlink, ...names.slice(i + 1)));
                node = root;
                i = -1;
            } else if (file) {
                if (i < names.length - 1) f_fail('ENOTDIR', 'open', target);
                return file.data;
            } else {
                node = node.dirs.get(name);
                if (!node) f_fail('ENOENT', 'open', target);
            }
        }
        f_fail('EISDIR', 'read', undefined);
    }

    const impl = {
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        existsSync(target) {
            const hit = f_entryOf(target);
            if (hit && (hit.parent.dirs.has(hit.name) || hit.parent.files.has(hit.name)))
                return true;
            return f_dirOf(target) !== undefined;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        mkdirSync(target, options = {}) {
            f_guard('mkdirSync', target);
            const names = f_split(target);
            let node = root, created;
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                if (node.files.has(name)) {
                    if (i === names.length - 1 && !options.recursive)
                        f_fail('EEXIST', 'mkdir', target);
                    f_fail('ENOTDIR', 'mkdir', target);
                }
                let next = node.dirs.get(name);
                if (!next) {
                    if (i < names.length - 1 && !options.recursive)
                        f_fail('ENOENT', 'mkdir', target);
                    next = { dirs: new Map(), files: new Map() };
                    node.dirs.set(name, next);
                    created ??= path.sep + names.slice(0, i + 1).join(path.sep);
                }
                else if (i === names.length - 1 && !options.recursive)
                    f_fail('EEXIST', 'mkdir', target);
                node = next;
            }
            return options.recursive ? created : undefined;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        writeFileSync(target, data) {
            if (Number.isInteger(target)) {
                const rec = fds.get(target);
                if (!rec || rec.data !== undefined) f_fail('EBADF', 'write', String(target));
                if (String(rec.flags).includes('a')) impl.appendFileSync(rec.file, data);
                else impl.writeFileSync(rec.file, data);
                return;
            }
            f_guard('writeFileSync', target);
            const hit = f_entryOf(target);
            if (!hit || hit.parent.dirs.has(hit.name))
                f_fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            hit.parent.files.set(hit.name, { data: f_toBuffer(data), mtimeMs: Date.now() });
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        appendFileSync(target, data) {
            f_guard('appendFileSync', target);
            const hit = f_entryOf(target);
            if (!hit || hit.parent.dirs.has(hit.name))
                f_fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            const existing = hit.parent.files.get(hit.name);
            const buffer = f_toBuffer(data);
            hit.parent.files.set(hit.name, existing
                ? { data: Buffer.concat([existing.data, buffer]), mtimeMs: Date.now() }
                : { data: buffer, mtimeMs: Date.now() });
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        readFileSync(target, encoding) {
            // 整型 fd：管道型暂存记录（pkg_stageStdin 登记的 fd 0）同步返回输入快照；
            // 未登记或文件型记录缺 data 走 EBADF（与真实 stdio fd 未安装时的 Node 语义一致）。
            if (Number.isInteger(target)) {
                const rec = fds.get(target);
                if (!rec || rec.data === undefined)
                    f_fail('EBADF', 'read', String(target));
                const format = typeof encoding === 'object' ? encoding?.encoding : encoding;
                return format ? rec.data.toString(format) : Buffer.from(rec.data);
            }
            f_guard('readFileSync', target);
            const data = f_readFileData(target);
            const format = typeof encoding === 'object' ? encoding?.encoding : encoding;
            return format ? data.toString(format) : Buffer.from(data);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        readdirSync(target, options = {}) {
            f_guard('readdirSync', target);
            const hit = f_entryOf(target);
            if (hit && hit.parent.files.has(hit.name))
                f_fail('ENOTDIR', 'scandir', target);
            const node = f_dirOf(target);
            if (!node)
                f_fail('ENOENT', 'scandir', target);
            const names = [...node.dirs.keys(), ...node.files.keys()];
            const encoding = typeof options === 'string' ? options : options?.encoding;
            const encoded = name => encoding === 'buffer' ? Buffer.from(name) : encoding && encoding !== 'utf8' ? Buffer.from(name).toString(encoding) : name;
            if (!options?.withFileTypes) return names.map(encoded);
            return names.map(name => {
                const directory = node.dirs.has(name);
                const symbolicLink = !directory && node.files.get(name)?.symlink !== undefined;
                return { name: encoded(name), parentPath: String(target), path: String(target),
                    isDirectory: () => directory, isFile: () => !directory && !symbolicLink,
                    isSymbolicLink: () => symbolicLink, isBlockDevice: () => false,
                    isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
            });
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        statSync(target) { return f_stat(target, false); },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        lstatSync(target) { return f_stat(target, true); },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        utimesSync(target, atime, mtime) {
            f_guard('utimesSync', target);
            const hit = f_entryOf(target);
            if (!hit || !(hit.parent.files.has(hit.name) || hit.parent.dirs.has(hit.name)))
                f_fail('ENOENT', 'utimes', target);
            // 卷内文件更新 mtimeMs；目录无时间面（f_statTimes 目录恒纪元 0 口径不变），记为 no-op。
            if (hit.parent.files.has(hit.name))
                hit.parent.files.get(hit.name).mtimeMs = f_timeMsOf(mtime, 'mtime');
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        rmSync(target, options = {}) {
            f_guard('rmSync', target);
            const hit = f_entryOf(target);
            if (!hit || !(hit.parent.dirs.has(hit.name) || hit.parent.files.has(hit.name))) {
                if (!options.force)
                    f_fail('ENOENT', 'rm', target);
                return;
            }
            if (hit.parent.dirs.has(hit.name) && !options.recursive) f_fail('ERR_FS_EISDIR', 'rm', target);
            hit.parent.dirs.delete(hit.name);
            hit.parent.files.delete(hit.name);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        rmdirSync(target) {
            f_guard('rmdirSync', target);
            const hit = f_entryOf(target);
            if (!hit || !hit.parent.dirs.has(hit.name))
                f_fail(hit && hit.parent.files.has(hit.name) ? 'ENOTDIR' : 'ENOENT', 'rmdir', target);
            const node = hit.parent.dirs.get(hit.name);
            if (node.dirs.size || node.files.size)
                f_fail('ENOTEMPTY', 'rmdir', target);
            hit.parent.dirs.delete(hit.name);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        unlinkSync(target) {
            f_guard('unlinkSync', target);
            const hit = f_entryOf(target);
            if (!hit || !hit.parent.files.has(hit.name))
                f_fail(hit && hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'unlink', target);
            hit.parent.files.delete(hit.name);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        renameSync(from, to) {
            f_guard('renameSync', from);
            const src = f_entryOf(from), dst = f_entryOf(to);
            if (!src || !(src.parent.dirs.has(src.name) || src.parent.files.has(src.name)))
                f_fail('ENOENT', 'rename', from);
            if (!dst)
                f_fail('ENOENT', 'rename', to);
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
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        copyFileSync(from, to) {
            f_guard('copyFileSync', from);
            const content = impl.readFileSync(from);
            impl.writeFileSync(to, content);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        cpSync(from, to) {
            f_guard('cpSync', from);
            if (!impl.existsSync(from))
                f_fail('ENOENT', 'cp', from);
            if (impl.statSync(from).isDirectory()) {
                impl.mkdirSync(to, { recursive: true });
                for (const name of impl.readdirSync(from))
                    impl.cpSync(path.join(String(from), name), path.join(String(to), name));
                return;
            }
            impl.writeFileSync(to, impl.readFileSync(from));
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        accessSync(target) {
            f_guard('accessSync', target);
            if (!impl.existsSync(target))
                f_fail('ENOENT', 'access', target);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        realpathSync(target) {
            f_guard('realpathSync', target);
            // 语义与原生一致：逐段解析符号链接（含中间目录段与末段链接链，40 层上限防循环），
            // 每个前缀必须存在（缺失 ENOENT、链接目录中夹文件 ENOTDIR），返回解析后的绝对路径。
            let names = f_split(path.resolve(String(target))), node = root, links = 0;
            for (let i = 0; i < names.length; i++) {
                const name = names[i], file = node.files.get(name), dir = node.dirs.get(name);
                if (file?.symlink !== undefined) {
                    if (++links > 40)
                        f_fail('ELOOP', 'realpath', target);
                    const parent = path.sep + names.slice(0, i).join(path.sep);
                    names = [...f_split(path.resolve(parent, file.symlink)), ...names.slice(i + 1)];
                    node = root;
                    i = -1;
                }
                else if (dir) {
                    node = dir;
                }
                else if (file) {
                    if (i < names.length - 1)
                        f_fail('ENOTDIR', 'realpath', target);
                    return path.sep + names.join(path.sep);
                }
                else {
                    f_fail('ENOENT', 'lstat', target);
                }
            }
            return path.sep + names.join(path.sep);
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        chmodSync() { /* 内存卷无权限语义：记账为 no-op */ },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        symlinkSync(target, linkPath) {
            f_guard('symlinkSync', linkPath);
            const hit = f_entryOf(linkPath);
            if (!hit || hit.parent.dirs.has(linkPath === undefined ? undefined : hit.name))
                f_fail('ENOENT', 'symlink', linkPath);
            hit.parent.files.set(hit.name, { data: Buffer.alloc(0), mtimeMs: Date.now(), symlink: String(target) });
        },
        // 最小 fd 面：serveCmd 冷启动经 fs.openSync(logFile,'a') 拿 stdio fd——内存卷按打开即建
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        openSync(target, flags = 'r') {
            f_guard('openSync', target);
            const hit = f_entryOf(target);
            if (!hit)
                f_fail('ENOENT', 'open', target);
            if (flags.includes('x') && (hit.parent.files.has(hit.name) || hit.parent.dirs.has(hit.name)))
                f_fail('EEXIST', 'open', target);
            if ((flags.includes('a') || flags.includes('w')) && !hit.parent.files.has(hit.name) && !hit.parent.dirs.has(hit.name))
                hit.parent.files.set(hit.name, { data: Buffer.alloc(0), mtimeMs: Date.now() });
            if (!hit.parent.files.has(hit.name))
                f_fail(hit.parent.dirs.has(hit.name) ? 'EISDIR' : 'ENOENT', 'open', target);
            if (flags.includes('w')) hit.parent.files.set(hit.name, { data: Buffer.alloc(0), mtimeMs: Date.now() });
            const fd = ++fdSeq;
            fds.set(fd, { file: String(target), flags: String(flags || 'r') }); // 记录 flags：fd 写入按 open 语义落点
            return fd;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        closeSync(fd) {
            if (!fds.delete(fd))
                f_fail('EBADF', 'close', String(fd));
        },
        // 定位读：按 position 从卷内文件整体内容切片回填（显式 position 为唯一支持形态——
        // lite fd 不维护游标，position 缺省按 0 起；增量日志按字节偏移读即此口径）。
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        readSync(fd, buffer, offset = 0, length = buffer.length - offset, position = null) {
            const state = fds.get(fd);
            if (!state)
                f_fail('EBADF', 'read', String(fd));
            const data = state.data !== undefined ? state.data : impl.readFileSync(state.file);
            const start = Math.max(0, Number(position ?? 0));
            const taken = data.subarray(start, Math.min(start + length, data.length));
            taken.copy(buffer, offset);
            return taken.length;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_fdInUse(fd) { return fds.has(fd); },
        // fd 0 管道型暂存（pkg_stageStdin 分派）：读侧经 readFileSync/readSync 整型分支消费，
        // 写侧 EBADF（只读管道语义）。同一时刻只保留一份——虚拟命令串行执行下最后暂存生效。
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_stageStdin(data) { fds.set(0, { data, flags: 'r' }); },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_releaseStdin() { fds.delete(0); },
        // 最小读流（零依赖）：on/pipe 消费面，整体缓冲一跳推 data、再推 end——不背压不切片；
        // 不引 node:events，保持 lite-fs 仅依赖 node:fs/node:path（可进模块白名单受控环境）。
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        createReadStream(target) {
            const listeners = new Map();
            // 私有方法：仅在本文件实现中使用，不导出。
            const f_emit = (event, ...values) => { for (const fn of listeners.get(event) ?? []) fn(...values); };
            const stream = {
                // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
                on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return stream; },
                // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
                pipe(dest) {
                    stream.on('data', (chunk) => dest.write(chunk));
                    stream.on('end', () => dest.end());
                    return stream;
                },
            };
            queueMicrotask(() => {
                try {
                    f_emit('data', impl.readFileSync(target));
                    f_emit('end');
                }
                catch (error) {
                    f_emit('error', error);
                }
            });
            return stream;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        inject(fault) {
            // code（按 f_fail 组标准文案）或 error（预制错误实例，调用方自定文案与字段）二选一
            if (!fault || (typeof fault.code !== 'string' || !fault.code) && !(fault.error instanceof Error))
                throw new Error('lite-fs 注入必须指定错误 code（如 EACCES / EIO / ENOSPC）或预制 error 实例');
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
    };
    // 私有方法：stat 时间面与真实 fs.Stats 同构——mtime/atime/birthtime/ctime 为 Date、
    // *Ms 为数值（业务侧 st.mtime.toISOString() 等消费依赖 Date 形态）；卷内无独立访问/
    // 变更时钟，四路同源 mtimeMs（目录缺省纪元 0）。
    function f_statTimes(mtimeMs) {
        return {
            mtimeMs, atimeMs: mtimeMs, birthtimeMs: mtimeMs, ctimeMs: mtimeMs,
            mtime: new Date(mtimeMs), atime: new Date(mtimeMs), birthtime: new Date(mtimeMs), ctime: new Date(mtimeMs),
        };
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    function f_stat(target, linkOnly) {
        f_guard(linkOnly ? 'lstatSync' : 'statSync', target);
        const hit = f_entryOf(target);
        if (hit && hit.parent.files.has(hit.name)) {
            const file = hit.parent.files.get(hit.name);
            const times = f_statTimes(file.mtimeMs);
            return {
                isFile: () => true, isDirectory: () => false, isSymbolicLink: () => Boolean(file.symlink),
                size: file.data.length, ...times,
            };
        }
        const node = f_dirOf(target);
        if (node !== undefined)
            return {
                isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
                size: 0, ...f_statTimes(0),
            };
        f_fail('ENOENT', 'stat', target);
    }
    let fdSeq = 100;
    const fds = new Map();
    return {
        impl,
        // 从排除目录读取源码，产物仍写入内存卷；故障规则沿用 copyFileSync 的源路径口径。
        f_copyFromReal(source, target, flags = 0) {
            f_guard('copyFileSync', source);
            let content;
            try { content = fs.readFileSync(source); }
            catch (error) { error.syscall = 'copyfile'; error.dest = target; throw error; }
            if ((flags & fs.constants.COPYFILE_EXCL) && impl.existsSync(target)) {
                const error = new Error(`EEXIST: file already exists, copyfile '${source}' -> '${target}'`);
                Object.assign(error, { code: 'EEXIST', syscall: 'copyfile', path: source, dest: target });
                throw error;
            }
            return impl.writeFileSync(target, content);
        },
        // 持久根支撑：子树快照（卷销毁前留存；不存在为 null）与植入（新卷恢复；父链按需补建）
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_snapshotOf(target) {
            const node = f_dirOf(target);
            return node ? f_cloneNode(node) : null;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_plant(target, node) {
            const names = f_split(target);
            const name = names.pop();
            let cursor = root;
            for (const seg of names) {
                let next = cursor.dirs.get(seg);
                if (!next) {
                    next = { dirs: new Map(), files: new Map() };
                    cursor.dirs.set(seg, next);
                }
                cursor = next;
            }
            cursor.dirs.set(name, f_cloneNode(node));
        },
    };
}

let f_memory = null; // 未设置 → 默认实现（真实 node:fs 全量转发）；{ impl, list }

// 持久根：跨卷复位存活的子树登记（模块级，与卷实例无关）——unmock 时把卷内各持久根子树
// 快照存模块级存储，mock 建新卷后恢复；可在任何时刻登记（未 mock 时只是登记，无副作用）
const f_persistentRoots = new Set();
const f_persistentSnapshots = new Map(); // root → 快照节点（null = 上次卷内不存在该根）
// 外部方法：配置跨卷复位保留的目录；允许所有调用方使用，包括测试文件。
const markPersistent = (root) => {
    f_persistentRoots.add(path.resolve(String(root)));
};

// 包内协作：把 spawn 输入暂存为 fd 0（管道型记录），供虚拟命令内 fs.readFileSync(0) 同步读取；
// 仅 mock 生效期有意义，未 mock 时为 no-op。供 lite-cmd-node 等包内模块调用。
export function pkg_stageStdin(data) {
    if (!f_memory) return;
    f_memory.impl.f_stageStdin(Buffer.from(data ?? Buffer.alloc(0)));
}

// 包内协作：释放 fd 0 暂存（虚拟命令结束时调用，防跨运行残留）；未 mock 时为 no-op。
export function pkg_releaseStdin() {
    if (!f_memory) return;
    f_memory.impl.f_releaseStdin();
}

// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
const t_mock = ({ exclude } = {}) => {
    if (f_memory)
        return facade;
    if (!Array.isArray(exclude) || !exclude.length)
        throw new Error('lite-fs.t_mock 需要非空 exclude：声明排除目录（系统本体留在真实 fs），其余全落内存卷');
    f_memory = f_createMemoryFs();
    f_memory.list = exclude.map(entry => path.resolve(String(entry)));
    for (const [rootPath, snapshot] of f_persistentSnapshots) {
        if (snapshot) f_memory.f_plant(rootPath, snapshot); // 持久根恢复：其余内容清零由世界自播种
    }
    return facade;
};
// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
const t_unmock = () => {
    if (f_memory) {
        for (const rootPath of f_persistentRoots)
            f_persistentSnapshots.set(rootPath, f_memory.f_snapshotOf(rootPath));
    }
    f_memory = null;
};
// 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
const t_inject = (fault) => {
    if (!f_memory)
        throw new Error('lite-fs.t_inject 需先 t_mock() 设置内存实现');
    return f_memory.impl.inject(fault);
};
// 作用域判定：目标不在任何排除目录内（排除目录本身或其子路径除外）即走内存卷——
// 越界写不可能穿透真实磁盘
// 私有方法：仅在本文件实现中使用，不导出。
const f_scoped = (target) => {
    if (typeof target !== 'string')
        return false;
    const resolved = path.resolve(target);
    return !f_memory.list.some(entry => resolved === entry || resolved.startsWith(entry + path.sep));
};

const facade = new Proxy({}, {
    // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
    get(_target, prop) {
        if (typeof prop === 'symbol')
            return Reflect.get(fs, prop);
        if (prop === 't_mock')
            return t_mock;
        if (prop === 't_unmock')
            return t_unmock;
        if (prop === 't_inject')
            return t_inject;
        if (prop === 'isMocked') // 外部方法：查询 mock 状态，允许所有调用方使用；状态自省：其他 lite 门面（如世界装配层判定骨架写入不落真实磁盘的前置条件）
            return () => f_memory !== null;
        if (prop === 'markPersistent') // 外部方法：配置持久根，允许所有调用方使用；持久根登记：跨卷复位存活的通用机制（lite-fs 不认识具体根）
            return markPersistent;
        // 私有方法不经代理泄露：除上述公共配置外，仅转发原生 fs 的接口。
        if (!(prop in fs))
            return undefined;
        if (!f_memory)
            return fs[prop];
        if (prop === 'constants')
            return fs.constants;
        const memoryFn = typeof f_memory.impl[prop] === 'function' ? f_memory.impl[prop] : null;
        const realFn = typeof fs[prop] === 'function' ? fs[prop] : null;
        if (!memoryFn && !realFn)
            return fs[prop];
        return (...args) => {
            if (prop === 'copyFileSync' && typeof args[0] === 'string' && typeof args[1] === 'string' && !f_scoped(args[0]) && f_scoped(args[1])) {
                return f_memory.f_copyFromReal(...args);
            }
            // fd 首参操作（writeFileSync/closeSync 等以整型 fd 开头）：fd 在内存卷登记则整条
            // 操作落内存实现——否则数据载荷（字符串）会被误判为根外路径，透传真实 fs 拿
            // 虚拟 fd 写出 EBADF；未登记的 fd（真实 stdio 等）按原样走真实 fs
            if (Number.isInteger(args[0])) {
                if (f_memory?.impl.f_fdInUse(args[0])) {
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
            if ((pathArg !== null && f_scoped(pathArg)) || (pathArg === null && memoryFn)) {
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
