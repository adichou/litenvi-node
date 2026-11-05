// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-cmd-git：导入不注册命令；测试须显式调用 t_install() 安装 /mock-cmd/usr/bin/git。
// 命令均由 lite-child_process.spawn/spawnSync 派遣，调用账本与清理统一归该模块；
// mgr.command('git').t_onRun 只负责配置脚本钩子。异步执行由子进程门面复用同步命令实现。
// 本模块在 lite-fs 当前作用域维护仓库、提交 DAG、暂存区、引用与工作树，执行命令时不调用
// 系统 Git。分支切换会更新工作树并检查覆盖冲突；标签、reset、revert、cherry-pick、merge、
// stash 与 worktree 更新对应状态。无远端 fetch --all 成功，不可访问远端的传输命令失败。
// 内部存储是测试环境的私有格式，不是原生 Git 磁盘格式：
//   .git/HEAD、refs/heads/*、refs/tags/*：文本引用；
//   .git/objects/<f_sha1>：类型行 + blob 原文或 tree/commit JSON；
//   .git/index.json：path → blobSha 的暂存映射；
//   .git/worktrees/*：共享对象与引用，各工作树独立维护 HEAD 和暂存区。
// 状态随 lite-fs 卷生命周期保存或丢弃，不在命令模块中另设运行账本。
import crypto from 'node:crypto';
import path from 'node:path';
import mgr from './lite-cmd-mgr.mjs';
import fs from './lite-fs.mjs';

const f_statusObservers = new Set();

// 注册同步扫描检查点；回调可重入内存命令，移除函数用于隔离用例。
export function pkg_onStatusScan(observer) {
    if (typeof observer !== 'function') throw new TypeError('状态扫描检查点须为函数');
    f_statusObservers.add(observer);
    return () => f_statusObservers.delete(observer);
}

// Git 只读扫描的可选锁是尽力获取：已有锁时仍允许读取，写入则必须获得独占锁。
function f_withIndexLock(repo, optional, run) {
    const lockPath = path.join(repo.localDir, 'index.lock');
    let fd;
    try {
        fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!optional) return f_fatal(`Unable to create '${lockPath}': File exists.`);
    }
    try {
        return run({ lockPath, lockAcquired: fd !== undefined });
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
            fs.unlinkSync(lockPath);
        }
    }
}

// ---------- 仓库与对象模型 ----------

// 私有方法：仅在本文件实现中使用，不导出。
const f_sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

// 私有方法：仅在本文件实现中使用，不导出。
function f_openRepo(root, localDir = path.join(root, '.git')) {
    let gitDir = localDir;
    try { gitDir = path.resolve(localDir, fs.readFileSync(path.join(localDir, 'commondir'), 'utf8').trim()); } catch { /* 主工作树没有 commondir */ }
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_abs = rel => path.join(/^(HEAD|index.json|CHERRY_PICK_HEAD|MERGE_HEAD|REVERT_HEAD)$/.test(rel) ? localDir : gitDir, ...String(rel).split('/'));
    return {
        root,
        gitDir,
        localDir,
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_read(rel) {
            try { return fs.readFileSync(f_abs(rel)); } catch { return null; }
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_readText(rel) {
            try { return fs.readFileSync(f_abs(rel), 'utf8'); } catch { return null; }
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        f_write(rel, data) {
            fs.mkdirSync(path.dirname(f_abs(rel)), { recursive: true });
            fs.writeFileSync(f_abs(rel), data);
        },
    };
}

// 仓库发现：从 dir 逐级上溯找 .git（存在即命中）
// 私有方法：仅在本文件实现中使用，不导出。
function f_locateRepo(dir) {
    let cur = path.resolve(String(dir || '.'));
    for (;;) {
        const marker = path.join(cur, '.git');
        if (fs.existsSync(marker)) {
            if (fs.statSync(marker).isDirectory()) return f_openRepo(cur);
            const pointer = /^gitdir: (.+)/.exec(fs.readFileSync(marker, 'utf8'));
            if (pointer) return f_openRepo(cur, path.resolve(cur, pointer[1]));
        }
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
}

// 对象存取：文件 = `<type>\n` + 载荷；hash = 载荷 f_sha1（blob 按内容、commit/tree 按 JSON 文本）
// 私有方法：仅在本文件实现中使用，不导出。
function f_storeObject(repo, type, payload) {
    const body = Buffer.concat([Buffer.from(`${type}\n`), Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))]);
    const hash = f_sha1(body.slice(type.length + 1));
    const existing = repo.f_read(`objects/${hash}`);
    if (!existing || !existing.equals(body)) repo.f_write(`objects/${hash}`, body);
    return hash;
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_readObject(repo, hash, wantType) {
    const raw = repo.f_read(`objects/${hash}`);
    if (!raw) return null;
    const nl = raw.indexOf(0x0a);
    if (nl < 0) return null;
    const type = raw.slice(0, nl).toString('utf8');
    if (wantType && type !== wantType) return null;
    const payload = raw.slice(nl + 1);
    if (type === 'blob') return payload;
    try { return JSON.parse(payload.toString('utf8')); } catch { return null; }
}

// ---------- 引用与 HEAD ----------

const f_INVALID_REF_NAME_RE = /[\x00-\x20\x7f~^:?*[\]\\]/;
// 私有方法：仅在本文件实现中使用，不导出。
const f_validRefName = (name) => typeof name === 'string' && name.length > 0
    && !name.startsWith('-') && !f_INVALID_REF_NAME_RE.test(name)
    && !name.includes('..') && !name.includes('@{') && !name.endsWith('.')
    && name.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));

// 私有方法：引用按 UTF-8 字节排序，与 Git 的 refname 顺序一致，不使用系统语言排序。
const f_compareRefNames = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// 私有方法：仅在本文件实现中使用，不导出。
function f_readRef(repo, branch) {
    const text = repo.f_readText(`refs/heads/${branch}`);
    return text != null ? text.trim() : null;
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_writeRef(repo, branch, hash) {
    repo.f_write(`refs/heads/${branch}`, `${hash}\n`);
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_listBranches(repo) {
    const names = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_walk = (rel) => {
        let entries = [];
        try { entries = fs.readdirSync(path.join(repo.gitDir, 'refs', 'heads', rel)); } catch { return; }
        for (const name of entries) {
            const r = rel.length ? `${rel}/${name}` : name;
            let st = null;
            try { st = fs.statSync(path.join(repo.gitDir, 'refs', 'heads', ...r.split('/'))); } catch { continue; }
            if (st.isDirectory()) f_walk(r);
            else names.push(r);
        }
    };
    f_walk('');
    return names.sort(f_compareRefNames);
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_headState(repo) {
    const text = String(repo.f_readText('HEAD') || '').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    if (m) return { branch: m[1] };
    if (/^[0-9a-f]{40}$/.test(text)) return { detached: text };
    return {};
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_setHead(repo, branch) {
    repo.f_write('HEAD', `ref: refs/heads/${branch}\n`);
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_setDetached(repo, hash) {
    repo.f_write('HEAD', `${hash}\n`);
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_headCommit(repo) {
    const h = f_headState(repo);
    if (h.detached) return f_readObject(repo, h.detached, 'commit');
    if (h.branch) {
        const sha = f_readRef(repo, h.branch);
        return sha ? f_readObject(repo, sha, 'commit') : null; // 未出生分支：空仓库
    }
    return null;
}

// ---------- 暂存区 / 树 / 工作树 ----------

// 私有方法：仅在本文件实现中使用，不导出。
function f_readIndex(repo) {
    const text = repo.f_readText('index.json');
    if (text == null) return {};
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
}

// 私有方法：仅在本文件实现中使用，不导出。
const f_treeText = (tree) => JSON.stringify(tree, Object.keys(tree).sort());

// 私有方法：仅在本文件实现中使用，不导出。
function f_writeIndex(repo, index) {
    repo.f_write('index.json', `${f_treeText(index)}\n`);
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_treeOf(repo, commit) {
    return commit && commit.tree ? (f_readObject(repo, commit.tree, 'tree') || {}) : {};
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_headTree(repo) {
    return f_treeOf(repo, f_headCommit(repo));
}

// 工作树枚举：跳过 .git，返回仓库根相对 posix 路径（有序）
// 私有方法：仅在本文件实现中使用，不导出。
function f_listWorktree(repo) {
    const files = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_walk = (rel) => {
        let names = [];
        try { names = fs.readdirSync(rel ? path.join(repo.root, ...rel.split('/')) : repo.root); } catch { return; }
        for (const name of names) {
            if (!rel && name === '.git') continue;
            const r = rel ? `${rel}/${name}` : name;
            let st = null;
            try { st = fs.statSync(path.join(repo.root, ...r.split('/'))); } catch { continue; }
            if (st.isDirectory()) f_walk(r);
            else files.push(r);
        }
    };
    f_walk('');
    return files.sort();
}

// 根 .gitignore 最小忽略模型：逐行路径 / 目录（尾 /）模式，按仓库根锚定的精确或目录前缀匹配
// 私有方法：仅在本文件实现中使用，不导出。
function f_ignorePatterns(repo) {
    let text = null;
    try { text = fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8'); } catch { return new Set(); }
    const pats = new Set();
    for (let line of String(text || '').split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        pats.add(line.replace(/\/+$/, ''));
    }
    return pats;
}

// 私有方法：仅在本文件实现中使用，不导出。
function f_isIgnored(pats, p) {
    let cur = p;
    while (cur) {
        if (pats.has(cur)) return true;
        const at = cur.lastIndexOf('/');
        if (at === -1) return false;
        cur = cur.slice(0, at);
    }
    return false;
}

// 私有方法：读取工作树文件；仅文件缺失按删除处理，其他读取故障交由命令边界报告失败。
function f_readWorktreeFile(repo, p) {
    try { return fs.readFileSync(path.join(repo.root, ...p.split('/'))); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// pathspec 匹配：精确路径或目录前缀（'.' / 空串 = 全部）
// 私有方法：仅在本文件实现中使用，不导出。
function f_matchPathspec(spec, p) {
    const s = String(spec || '');
    if (s === '.' || s === '') return true;
    return p === s || p.startsWith(`${s}/`);
}

// ---------- 提交号解析与遍历 ----------

// 私有方法：仅在本文件实现中使用，不导出。
function f_commitHashes(repo) {
    let names = [];
    try { names = fs.readdirSync(path.join(repo.gitDir, 'objects')); } catch { return []; }
    return names.filter((n) => /^[0-9a-f]{40}$/.test(n)).map((n) => n.toLowerCase());
}

// 提交号解析：HEAD、分支名、refs/heads/x、40 位全号 / ≥4 位前缀、<rev>^{commit}
// 私有方法：仅在本文件实现中使用，不导出。
function f_resolveCommitish(repo, spec) {
    const raw = String(spec || '');
    const base = /\^\{commit\}$/.test(raw) ? raw.slice(0, -9) : raw;
    const ancestor = /^(.*)([~^])(\d*)$/.exec(base);
    if (ancestor) {
        let sha = f_resolveCommitish(repo, ancestor[1]);
        const count = Number(ancestor[3] || 1);
        if (ancestor[2] === '^') return count === 0 ? sha : (f_readObject(repo, sha, 'commit')?.parents[count - 1] || null);
        for (let i = 0; i < count && sha; i++) sha = f_readObject(repo, sha, 'commit')?.parents[0] || null;
        return sha;
    }
    const tag = repo.f_readText(`refs/tags/${base.replace(/^refs\/tags\//, '')}`);
    if (tag) return tag.trim();
    if (base === 'HEAD') {
        const h = f_headState(repo);
        if (h.detached) return h.detached;
        return h.branch ? f_readRef(repo, h.branch) : null; // 未出生分支 → null
    }
    if (base.startsWith('refs/heads/')) return f_readRef(repo, base.slice('refs/heads/'.length));
    if (f_validRefName(base)) {
        const ref = f_readRef(repo, base);
        if (ref != null) return ref;
    }
    if (/^[0-9a-f]{4,40}$/i.test(base)) {
        const low = base.toLowerCase();
        if (low.length === 40 && f_readObject(repo, low, 'commit')) return low;
        // 私有方法：仅在本文件实现中使用，不导出。
        const hits = f_commitHashes(repo).filter((h) => h.startsWith(low));
        if (hits.length === 1) return hits[0];
    }
    return null;
}

// 从 tips 沿 parents 收集提交（去重、排除 excludeTips 可达），发现序（DFS 子先于父）
// 私有方法：仅在本文件实现中使用，不导出。
function f_collectCommits(repo, tips, excludeTips = []) {
    const excl = new Set();
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_markExcl = (sha) => {
        if (!sha || excl.has(sha)) return;
        excl.add(sha);
        const c = f_readObject(repo, sha, 'commit');
        if (c) for (const p of c.parents || []) f_markExcl(p);
    };
    for (const t of excludeTips) f_markExcl(f_resolveCommitish(repo, t) || t);
    const seen = new Set();
    const found = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_visit = (sha) => {
        if (!sha || seen.has(sha) || excl.has(sha)) return;
        seen.add(sha);
        const c = f_readObject(repo, sha, 'commit');
        if (!c) return;
        found.push({ sha, commit: c });
        for (const p of c.parents || []) f_visit(p);
    };
    for (const t of tips) f_visit(f_resolveCommitish(repo, t) || t);
    return found;
}

// 私有方法：仅在本文件实现中使用，不导出。
const f_byTimeDesc = (a, b) => new Date(b.commit.at || 0) - new Date(a.commit.at || 0);

// 拓扑序（子先于父）：Kahn——入度 = 集合内子提交数，零入度（最新尖端）先出
// 私有方法：仅在本文件实现中使用，不导出。
function f_topoOrder(entries) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const bySha = new Map(entries.map((e) => [e.sha, e]));
    // 私有方法：仅在本文件实现中使用，不导出。
    const kids = new Map(entries.map((e) => [e.sha, 0]));
    for (const e of entries) {
        for (const p of e.commit.parents || []) {
            if (kids.has(p)) kids.set(p, kids.get(p) + 1);
        }
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    const queue = entries.filter((e) => kids.get(e.sha) === 0).map((e) => e.sha);
    const out = [];
    while (queue.length) {
        const sha = queue.shift();
        out.push(sha);
        for (const p of bySha.get(sha).commit.parents || []) {
            if (!kids.has(p)) continue;
            kids.set(p, kids.get(p) - 1);
            if (kids.get(p) === 0) queue.push(p);
        }
    }
    return out;
}

// ---------- 输出格式 ----------

// 严格 ISO 8601 本地偏移形态（对齐真实 git %aI/%cI，如 2026-10-29T12:00:00+08:00）
// 私有方法：仅在本文件实现中使用，不导出。
function f_isoStrict(at) {
    const d = new Date(at || 0);
    if (Number.isNaN(d.getTime())) return '';
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_pad = (n) => String(n).padStart(2, '0');
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const om = Math.abs(offsetMin);
    return `${d.getFullYear()}-${f_pad(d.getMonth() + 1)}-${f_pad(d.getDate())}`
        + `T${f_pad(d.getHours())}:${f_pad(d.getMinutes())}:${f_pad(d.getSeconds())}`
        + `${sign}${f_pad(Math.floor(om / 60))}:${f_pad(om % 60)}`;
}

// --format 占位符引擎（%H %h %P %p %an %aN %ae %aI %cn %ce %cI %s %B %b %n %% %xNN；
// an/ae/aI/cn/ce/cI 为双字符占位符，先于单字符判定）
// 私有方法：仅在本文件实现中使用，不导出。
function f_expandFormat(fmt, sha, commit) {
    const message = String(commit.message || '');
    const subject = message.split('\n')[0];
    const out = [];
    for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch !== '%' || i + 1 >= fmt.length) { out.push(ch); continue; }
        const two = fmt.slice(i + 1, i + 3);
        if (two === 'an' || two === 'aN') { out.push(commit.author?.name || ''); i += 2; continue; }
        if (two === 'ae') { out.push(commit.author?.email || ''); i += 2; continue; }
        if (two === 'aI') { out.push(f_isoStrict(commit.at)); i += 2; continue; }
        if (two === 'cn') { out.push(commit.committer?.name || ''); i += 2; continue; }
        if (two === 'ce') { out.push(commit.committer?.email || ''); i += 2; continue; }
        if (two === 'cI') { out.push(f_isoStrict(commit.at)); i += 2; continue; }
        const ph = fmt[++i];
        if (ph === 'H') out.push(sha);
        else if (ph === 'h') out.push(sha.slice(0, 7));
        else if (ph === 'P') out.push((commit.parents || []).join(' '));
        else if (ph === 'p') out.push((commit.parents || []).map((p) => p.slice(0, 7)).join(' '));
        else if (ph === 's') out.push(subject);
        else if (ph === 'B') out.push(`${message}\n`);
        else if (ph === 'b') out.push(message.split('\n').slice(1).join('\n'));
        else if (ph === 'n') out.push('\n');
        else if (ph === '%') out.push('%');
        else if (ph === 'x') {
            const hex = fmt.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                out.push(String.fromCharCode(parseInt(hex, 16)));
                i += 2;
            } else out.push('%x');
        } else out.push(`%${ph}`);
    }
    return out.join('');
}

// 提交变更路径：对首父的树差异（根提交 = 全量路径）
// 私有方法：仅在本文件实现中使用，不导出。
function f_changedPaths(repo, sha, commit) {
    const cur = f_treeOf(repo, commit);
    const parent = commit.parents && commit.parents[0]
        ? f_treeOf(repo, f_readObject(repo, commit.parents[0], 'commit'))
        : {};
    const paths = new Set([...Object.keys(cur), ...Object.keys(parent)]);
    return [...paths].filter((p) => cur[p] !== parent[p]).sort();
}

// ---------- 子命令实现 ----------

// 私有方法：仅在本文件实现中使用，不导出。
const f_ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
// 私有方法：仅在本文件实现中使用，不导出。
const f_notRepo = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
// 私有方法：仅在本文件实现中使用，不导出。
const f_fatal = (message) => ({ status: 128, stdout: '', stderr: `fatal: ${message}\n` });
// 私有方法：仅在本文件实现中使用，不导出。
const f_needRepo = (repo) => (repo ? null : f_notRepo());

// 私有方法：仅在本文件实现中使用，不导出。
function f_authorOf(config) {
    const name = config.get('user.name')
        || process.env.GIT_AUTHOR_NAME
        || process.env.USER
        || process.env.USERNAME
        || 'mini-git';
    const email = config.get('user.email')
        || process.env.GIT_AUTHOR_EMAIL
        || `${name}@mini-git.local`;
    return { name: String(name), email: String(email) };
}

// init [-q] [-b <name>]：建 .git 骨架（幂等，已存在不动 HEAD）
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdInit(cwd, args) {
    let branch = 'main';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-b' && args[i + 1]) { branch = args[i + 1]; i++; }
        else if (args[i].startsWith('--initial-branch=')) branch = args[i].slice('--initial-branch='.length);
    }
    if (!f_validRefName(branch)) return f_fatal(`invalid branch name: ${branch}`);
    const root = path.resolve(String(cwd));
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    const repo = f_openRepo(root);
    if (repo.f_readText('HEAD') == null) f_setHead(repo, branch);
    return f_ok();
}

// add [-A] [--] <paths…>：工作树文件入 index；工作树不存在的 pathspec 从 index 移除
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdAdd(repo, args) {
    const paths = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { paths.push(...args.slice(i + 1)); break; }
        if (args[i].startsWith('-')) continue; // -A/-f/-u 等标志：路径收集口径不变
        paths.push(args[i]);
    }
    if (!paths.length) {
        return { status: 0, stdout: '', stderr: 'Nothing specified, nothing added.\n' }; // 对齐真实 git 无路径口径
    }
    const index = f_readIndex(repo);
    const pats = f_ignorePatterns(repo);
    // 私有方法：仅在本文件实现中使用，不导出。
    const files = f_listWorktree(repo).filter((p) => !f_isIgnored(pats, p));
    for (const spec of paths) {
        const exists = fs.existsSync(path.join(repo.root, spec));
        if (!exists && !files.some(p => f_matchPathspec(spec, p)) && !Object.keys(index).some(p => f_matchPathspec(spec, p)))
            return f_fatal(`pathspec '${spec}' did not match any files`);
    }
    let dirty = false;
    for (const spec of paths) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const onDisk = new Set(files.filter((p) => f_matchPathspec(spec, p)));
        for (const p of onDisk) {
            const data = f_readWorktreeFile(repo, p);
            if (data == null) continue;
            index[p] = f_storeObject(repo, 'blob', data);
            dirty = true;
        }
        // 工作树不存在（整体暂存删除）：从 index 移除该 pathspec 命中项
        for (const p of Object.keys(index)) {
            if (f_matchPathspec(spec, p) && !onDisk.has(p)) { delete index[p]; dirty = true; }
        }
    }
    if (dirty) f_writeIndex(repo, index);
    return f_ok();
}

// rm [-q] [--] <paths…>：删除已跟踪且无未提交修改的文件，并将删除写入暂存区。
function f_cmdRm(repo, args) {
    const paths = [];
    let quiet = false, recursive = false, optionsEnded = false;
    for (const arg of args) {
        if (!optionsEnded && arg === '--') { optionsEnded = true; continue; }
        if (!optionsEnded && (arg === '-q' || arg === '--quiet')) { quiet = true; continue; }
        if (!optionsEnded && arg === '-r') { recursive = true; continue; }
        if (!optionsEnded && arg.startsWith('-')) return f_fatal(`unsupported rm option: ${arg}`);
        paths.push(arg);
    }
    if (!paths.length) return f_fatal('No pathspec was given');
    const index = f_readIndex(repo);
    const head = f_headTree(repo);
    const selected = new Set();
    for (const spec of paths) {
        const matches = Object.keys(index).filter(p => f_matchPathspec(spec, p));
        if (!matches.length) return f_fatal(`pathspec '${spec}' did not match any files`);
        if (!recursive && matches.some(p => p !== spec)) return f_fatal(`not removing '${spec}' recursively without -r`);
        for (const p of matches) selected.add(p);
    }
    const localChanges = [], stagedChanges = [];
    for (const p of selected) {
        const content = f_readWorktreeFile(repo, p);
        if (head[p] !== index[p]) stagedChanges.push(p);
        else if (content !== null && f_sha1(content) !== index[p]) localChanges.push(p);
    }
    if (localChanges.length || stagedChanges.length) {
        const message = (paths, detail) => {
            if (!paths.length) return '';
            const heading = paths.length === 1 ? 'file has' : 'files have';
            return `error: the following ${heading} ${detail}:\n${paths.map(p => `    ${p}\n`).join('')}(use --cached to keep the file, or -f to force removal)\n`;
        };
        return { status: 1, stdout: '', stderr: message(localChanges, 'local modifications') + message(stagedChanges, 'changes staged in the index') };
    }
    for (const p of selected) {
        const target = path.join(repo.root, ...p.split('/'));
        if (fs.existsSync(target)) fs.unlinkSync(target);
        delete index[p];
    }
    f_writeIndex(repo, index);
    return f_ok(quiet ? '' : [...selected].map(p => `rm '${p}'\n`).join(''));
}

// commit [-q] [--only] -m <subject> [--] [paths…]：生成 tree + commit 并推进当前分支
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdCommit(repo, args, config) {
    const messages = [];
    const paths = [];
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { paths.push(...args.slice(i + 1)); break; }
        if (a === '-m' || a === '--message') {
            if (args[i + 1] === undefined) return f_fatal('no commit message given');
            messages.push(args[i + 1]); i++;
        } else if (a.startsWith('--message=')) messages.push(a.slice('--message='.length));
        else if (a.startsWith('-m') && a.length > 2) messages.push(a.slice(2));
        else if (a === '-q' || a === '--quiet') quiet = true;
        else if (a.startsWith('-')) continue; // --only/--include/-v 等：不改变收集口径
        else paths.push(a);
    }
    if (!messages.length) return f_fatal('no commit message given');
    const message = messages.join('\n\n');
    const h = f_headState(repo);
    if (!h.branch && !h.detached) return f_fatal('HEAD 未指向任何分支或提交（仓库骨架异常）');
    const headSha = h.detached || f_readRef(repo, h.branch);
    const baseTree = headSha ? f_treeOf(repo, f_readObject(repo, headSha, 'commit')) : {};
    const index = f_readIndex(repo);
    const tree = { ...baseTree };
    const pats = f_ignorePatterns(repo);
    // 私有方法：仅在本文件实现中使用，不导出。
    const files = f_listWorktree(repo).filter((p) => !f_isIgnored(pats, p));
    if (paths.length) {
        // --only / 显式路径：按路径限定取工作树内容（磁盘缺失 = 提交删除）
        for (const spec of paths) {
            // 私有方法：仅在本文件实现中使用，不导出。
            const onDisk = new Set(files.filter((p) => f_matchPathspec(spec, p)));
            for (const p of onDisk) {
                const data = f_readWorktreeFile(repo, p);
                if (data == null) continue;
                const hash = f_storeObject(repo, 'blob', data);
                tree[p] = hash;
                index[p] = hash;
            }
            for (const p of [...Object.keys(tree), ...Object.keys(index)]) {
                if (f_matchPathspec(spec, p) && !onDisk.has(p)) { delete tree[p]; delete index[p]; }
            }
        }
    } else {
        // 整个暂存区替换 HEAD 树，已暂存删除的路径不能从旧树残留。
        for (const p of Object.keys(tree)) delete tree[p];
        Object.assign(tree, index);
    }
    const sameTree = Object.keys(tree).length === Object.keys(baseTree).length
        && Object.entries(tree).every(([p, sha]) => baseTree[p] === sha);
    if (sameTree) return { status: 1, stdout: `On branch ${h.branch}\nnothing to commit, working tree clean\n`, stderr: '' };
    const treeSha = f_storeObject(repo, 'tree', f_treeText(tree));
    const who = f_authorOf(config);
    const commit = {
        tree: treeSha,
        parents: headSha ? [headSha] : [],
        author: who,
        committer: who,
        message,
        at: new Date().toISOString(),
    };
    const sha = f_storeObject(repo, 'commit', JSON.stringify(commit));
    if (h.branch) f_writeRef(repo, h.branch, sha);
    else f_setDetached(repo, sha);
    f_writeIndex(repo, index);
    if (quiet) return f_ok();
    const label = h.branch || 'detached';
    return f_ok(`[${label} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`);
}

// status --porcelain [-uall] [-- <pathspec>…]：工作树 vs index vs HEAD 的 XY 码
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdStatus(repo, args) {
    let specs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { specs = args.slice(i + 1); break; }
    }
    const head = f_headTree(repo);
    const index = f_readIndex(repo);
    const pats = f_ignorePatterns(repo);
    // 私有方法：仅在本文件实现中使用，不导出。
    const files = new Set(f_listWorktree(repo).filter((p) => !f_isIgnored(pats, p)));
    const lines = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_emit = (code, p) => {
        if (specs.length && !specs.some((spec) => f_matchPathspec(spec, p))) return;
        lines.push(`${code} ${p}`);
    };
    const tracked = [...new Set([...Object.keys(head), ...Object.keys(index)])].sort();
    for (const p of tracked) {
        const x = !(p in head) && (p in index) ? 'A'
            : (p in head) && !(p in index) ? 'D'
                : head[p] !== index[p] ? 'M' : ' ';
        const onDisk = files.has(p);
        const y = !(p in index)
            ? ' ' // 已暂存删除（index 缺席）：工作树位无独立判定
            : !onDisk ? 'D'
                : f_sha1(f_readWorktreeFile(repo, p) || Buffer.alloc(0)) !== index[p] ? 'M' : ' ';
        if (x === ' ' && y === ' ') continue; // 干净路径不上 porcelain
        f_emit(`${x}${y}`, p);
    }
    for (const p of [...files].sort()) {
        if (p in index) continue;
        f_emit('??', p);
    }
    return f_ok(lines.length ? `${lines.join('\n')}\n` : '');
}

// log：格式引擎 + 范围/排除/分页
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdLog(repo, args) {
    let fmt = null;
    let limit = Infinity;
    let skip = 0;
    let nameOnly = false;
    const tips = [];
    const exclude = [];
    let negate = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') break;
        if (a.startsWith('--format=')) { fmt = a.slice('--format='.length); continue; }
        if (a === '-n') { limit = Number(args[++i]) || Infinity; continue; }
        if (/^-\d+$/.test(a)) { limit = Number(a.slice(1)); continue; }
        if (a.startsWith('--max-count=')) { limit = Number(a.slice('--max-count='.length)) || Infinity; continue; }
        if (a === '--skip') { skip = Number(args[++i]) || 0; continue; }
        if (a === '--name-only' || a === '--no-renames') { if (a === '--name-only') nameOnly = true; continue; }
        if (a === '--not') { negate = !negate; continue; }
        if (a.startsWith('-')) continue;
        const range = /^(\S*)\.\.(\S*)$/.exec(a);
        if (range) {
            const from = range[1] || 'HEAD';
            const to = range[2] || 'HEAD';
            const toSha = f_resolveCommitish(repo, to);
            if (!toSha) return f_fatal(`ambiguous argument '${to}': unknown revision or path not in the working tree.`);
            if (f_resolveCommitish(repo, from)) exclude.push(from);
            tips.push(to);
            continue;
        }
        if (negate) exclude.push(a);
        else tips.push(a);
    }
    if (!tips.length) tips.push('HEAD');
    for (const t of tips) {
        if (!f_resolveCommitish(repo, t)) return f_fatal(`ambiguous argument '${t}': unknown revision or path not in the working tree.`);
    }
    const entries = f_collectCommits(repo, tips, exclude);
    entries.sort(f_byTimeDesc);
    const page = entries.slice(skip, skip + limit);
    const out = [];
    page.forEach(({ sha, commit }, idx) => {
        out.push(fmt != null ? f_expandFormat(fmt, sha, commit) : `commit ${sha}`);
        if (nameOnly && (commit.parents?.length || 0) < 2) {
            out.push('');
            out.push(...f_changedPaths(repo, sha, commit));
            if (idx < page.length - 1) out.push(''); // 记录间空行（对齐真实 --name-only 布局）
        }
    });
    return f_ok(out.length ? `${out.join('\n')}\n` : '');
}

// rev-parse：--is-inside-work-tree / --show-toplevel / [--verify [--quiet]] <rev> / --abbrev-ref
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdRevParse(repo, args) {
    const out = [];
    let verify = false;
    let quiet = false;
    let abbrev = false;
    const specs = [];
    for (const a of args) {
        if (a === '--verify') { verify = true; continue; }
        if (a === '--quiet' || a === '-q') { quiet = true; continue; }
        if (a === '--abbrev-ref') { abbrev = true; continue; }
        if (a === '--is-inside-work-tree') { out.push('true'); continue; }
        if (a === '--show-toplevel') { out.push(repo.root); continue; }
        if (a.startsWith('-')) continue; // 其余全局性标志忽略
        specs.push(a);
    }
    for (const spec of specs) {
        if (abbrev || /@\{upstream\}$/.test(spec)) {
            return f_fatal(`no upstream configured for branch '${spec.replace(/@\{upstream\}$/, '')}'`);
        }
        const sha = f_resolveCommitish(repo, spec);
        if (!sha) {
            if (verify && quiet) return { status: 1, stdout: '', stderr: '' };
            if (verify) return f_fatal('Needed a single revision');
            return f_fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
        }
        out.push(sha);
    }
    if (!out.length) return f_fatal('arg count required');
    return f_ok(`${out.join('\n')}\n`);
}

// rev-list：--f_count / --max-parents=N / --topo-order / --reverse / ^ref 排除
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdRevList(repo, args) {
    let count = false;
    let maxParents = null;
    let topo = false;
    let reverse = false;
    const tips = [];
    const exclude = [];
    let negate = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--count') { count = true; continue; }
        if (a.startsWith('--max-parents=')) { maxParents = Number(a.slice('--max-parents='.length)); continue; }
        if (a === '--topo-order') { topo = true; continue; }
        if (a === '--reverse') { reverse = true; continue; }
        if (a === '--not') { negate = !negate; continue; }
        if (a.startsWith('-')) continue;
        if (a.startsWith('^')) { exclude.push(a.slice(1)); continue; }
        if (negate) exclude.push(a);
        else tips.push(a);
    }
    if (!tips.length) tips.push('HEAD');
    for (const t of tips) {
        if (!f_resolveCommitish(repo, t)) return f_fatal(`ambiguous argument '${t}': unknown revision or path not in the working tree.`);
    }
    let entries = f_collectCommits(repo, tips, exclude);
    if (maxParents != null) {
        entries = entries.filter((e) => (e.commit.parents || []).length === maxParents);
    }
    if (count) return f_ok(`${entries.length}\n`);
    let hashes;
    if (topo) hashes = f_topoOrder(entries);
    else {
        entries = [...entries].sort(f_byTimeDesc);
        hashes = entries.map((e) => e.sha);
    }
    if (reverse) hashes.reverse();
    return f_ok(hashes.length ? `${hashes.join('\n')}\n` : '');
}

// branch：--show-current / --format=%(refname:short) / -r（恒空）/ <name> [<start>]
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdBranch(repo, args) {
    const pos = [];
    let remote = false;
    let format = null;
    for (const a of args) {
        if (a === '--show-current') {
            const h = f_headState(repo);
            return f_ok(h.branch ? `${h.branch}\n` : '');
        }
        if (a === '-r' || a === '-a' || a === '--remotes' || a === '--all') { remote = true; continue; }
        if (a.startsWith('--format=')) { format = a.slice('--format='.length); continue; }
        if (a.startsWith('-')) continue;
        pos.push(a);
    }
    if (remote) return f_ok(''); // 无远端跟踪引用
    if (format != null || pos.length === 0) {
        if (format != null && format !== '%(refname:short)') return f_fatal(`unsupported --format: ${format}`);
        return f_ok(f_listBranches(repo).map((b) => `${b}\n`).join(''));
    }
    const [name, start] = pos;
    if (!f_validRefName(name)) return f_fatal(`invalid branch name: ${name}`);
    if (f_readRef(repo, name) != null) return f_fatal(`a branch named '${name}' already exists`);
    const sha = f_resolveCommitish(repo, start || 'HEAD');
    if (!sha) return f_fatal(`not a valid object name: '${start || 'HEAD'}'`);
    f_writeRef(repo, name, sha);
    return f_ok();
}

// 检出目标树：只更新两次提交之间变化的路径，未涉及的本地修改继续保留。
// 私有方法：仅在本文件实现中使用，不导出。
function f_checkoutTree(repo, target, force = false) {
    const previous = f_headTree(repo);
    const index = f_readIndex(repo);
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(target), ...(force ? Object.keys(index) : [])])]
        .filter(p => force || previous[p] !== target[p]);
    if (!force) {
        for (const p of changed) {
            const data = f_readWorktreeFile(repo, p);
            const disk = data === null ? undefined : f_sha1(data);
            if ((disk !== index[p] || index[p] !== previous[p]) && disk !== target[p])
                return { status: 1, stdout: '', stderr: `error: Your local changes to the following files would be overwritten by checkout:\n\t${p}\nPlease commit your changes or stash them before you switch branches.\nAborting\n` };
        }
    }
    for (const p of changed) {
        const filename = path.join(repo.root, p);
        if (target[p]) {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, f_readObject(repo, target[p], 'blob'));
            index[p] = target[p];
        } else {
            fs.rmSync(filename, { force: true });
            delete index[p];
        }
    }
    f_writeIndex(repo, force ? target : index);
    return f_ok();
}

// switch [-q] [-c] <branch> [start]：更新工作树与暂存区后才推进 HEAD。
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdSwitch(repo, args) {
    let create = false;
    const pos = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-c' || a === '--create' || a === '-C' || a === '--force-create') { create = true; continue; }
        if (a === '-q' || a === '--quiet') continue;
        if (a.startsWith('-')) continue;
        pos.push(a);
    }
    const name = pos[0];
    if (!name) return f_fatal('branch name required');
    if (!f_validRefName(name)) return f_fatal(`invalid branch name: ${name}`);
    if (create) {
        if (f_readRef(repo, name) && !args.includes('-C') && !args.includes('--force-create'))
            return f_fatal(`a branch named '${name}' already exists`);
        const start = pos[1] || 'HEAD';
        const sha = f_resolveCommitish(repo, start);
        if (!sha) {
            // 空仓库未出生分支：等价于把未出生分支改名（首个提交自然落在新分支）
            const h = f_headState(repo);
            if (!pos[1] && h.branch && !f_readRef(repo, h.branch)) { f_setHead(repo, name); return f_ok(); }
            return f_fatal(`not a valid object name: '${start}'`);
        }
        const checked = f_checkoutTree(repo, f_treeOf(repo, f_readObject(repo, sha, 'commit')));
        if (checked.status) return checked;
        f_writeRef(repo, name, sha);
        f_setHead(repo, name);
        return f_ok();
    }
    const sha = f_readRef(repo, name);
    if (sha == null) return f_fatal(`invalid reference: ${name}`);
    const checked = f_checkoutTree(repo, f_treeOf(repo, f_readObject(repo, sha, 'commit')));
    if (checked.status) return checked;
    f_setHead(repo, name);
    return f_ok();
}

// checkout：分支切换 / detached（提交号）/ <rev> -- <paths> 检出。
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdCheckout(repo, args) {
    const dd = args.indexOf('--');
    if (dd >= 0) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const rev = args.slice(0, dd).find((a) => !a.startsWith('-')) || 'HEAD';
        const paths = args.slice(dd + 1);
        const sha = f_resolveCommitish(repo, rev);
        if (!sha) return f_fatal(`invalid reference: ${rev}`);
        const commit = f_readObject(repo, sha, 'commit');
        const tree = f_treeOf(repo, commit);
        const index = f_readIndex(repo);
        let matched = false;
        for (const spec of paths) {
            for (const p of Object.keys(tree)) {
                if (!f_matchPathspec(spec, p)) continue;
                matched = true;
                const data = f_readObject(repo, tree[p], 'blob');
                if (data == null) continue;
                fs.mkdirSync(path.dirname(path.join(repo.root, ...p.split('/'))), { recursive: true });
                fs.writeFileSync(path.join(repo.root, ...p.split('/')), data);
                index[p] = tree[p];
            }
        }
        if (!matched) {
            return {
                status: 1,
                stdout: '',
                stderr: `error: pathspec '${paths.join(' ')}' did not match any file(s) known to git\n`,
            };
        }
        f_writeIndex(repo, index);
        return f_ok();
    }
    // 私有方法：仅在本文件实现中使用，不导出。
    const target = args.find((a) => !a.startsWith('-'));
    if (!target) return f_fatal('branch name required');
    if (f_readRef(repo, target) != null) {
        return f_cmdSwitch(repo, args);
    }
    const sha = f_resolveCommitish(repo, target);
    if (!sha) return f_fatal(`invalid reference: ${target}`);
    const checked = f_checkoutTree(repo, f_treeOf(repo, f_readObject(repo, sha, 'commit')));
    if (checked.status) return checked;
    f_setDetached(repo, sha); // 提交号 → detached HEAD
    return f_ok();
}

// merge-base [--is-ancestor] <a> <b>：沿父提交关系求祖先或最佳共同祖先。
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdMergeBase(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const specs = args.filter(a => !a.startsWith('-'));
    if (specs.length < 2) return { status: 129, stdout: '', stderr: 'usage: git merge-base [--all] <commit> <commit>...\n' };
    const [a, b] = specs;
    const aSha = f_resolveCommitish(repo, a);
    const bSha = f_resolveCommitish(repo, b);
    if (!aSha || !bSha) return f_fatal(`not a valid object name: ${!aSha ? a : b}`);
    const reach = f_collectCommits(repo, [bSha]);
    if (args.includes('--is-ancestor'))
        return { status: reach.some(e => e.sha === aSha) ? 0 : 1, stdout: '', stderr: '' };
    // 私有方法：仅在本文件实现中使用，不导出。
    const other = new Set(reach.map(e => e.sha));
    // 私有方法：仅在本文件实现中使用，不导出。
    const common = f_collectCommits(repo, [aSha]).filter(e => other.has(e.sha));
    // 私有方法：仅在本文件实现中使用，不导出。
    const best = common.filter(candidate => !common.some(e => e.sha !== candidate.sha
        && f_collectCommits(repo, [e.sha]).some(ancestor => ancestor.sha === candidate.sha)));
    return best.length ? f_ok(`${(args.includes('--all') || args.includes('-a') ? best : best.slice(0, 1)).map(e => e.sha).join('\n')}\n`)
        : { status: 1, stdout: '', stderr: '' };
}

// ls-files [--error-unmatch] [--] <p>…：index 命中
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdLsFiles(repo, args) {
    let errorUnmatch = false;
    const specs = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { specs.push(...args.slice(i + 1)); break; }
        if (a === '--error-unmatch') { errorUnmatch = true; continue; }
        if (a.startsWith('-')) continue;
        specs.push(a);
    }
    const index = f_readIndex(repo);
    const all = Object.keys(index).sort();
    if (!specs.length) return f_ok(all.length ? `${all.join('\n')}\n` : '');
    const hits = new Set();
    for (const spec of specs) {
        // 私有方法：仅在本文件实现中使用，不导出。
        const matched = all.filter((p) => f_matchPathspec(spec, p));
        if (!matched.length && errorUnmatch) {
            return {
                status: 1,
                stdout: '',
                stderr: `error: pathspec '${spec}' did not match any file(s) known to git\n`,
            };
        }
        matched.forEach((p) => hits.add(p));
    }
    return f_ok(hits.size ? `${[...hits].sort().join('\n')}\n` : '');
}

// symbolic-ref [--quiet] [--short] HEAD：非符号引用默认 128，静默模式为 1。
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdSymbolicRef(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const target = args.find((a) => !a.startsWith('-'));
    const h = f_headState(repo);
    if (target !== 'HEAD' || !h.branch) {
        const quiet = args.includes('--quiet') || args.includes('-q');
        return { status: quiet ? 1 : 128, stdout: '', stderr: quiet ? '' : `fatal: ref ${target || 'HEAD'} is not a symbolic ref\n` };
    }
    return f_ok(`${args.includes('--short') ? h.branch : `refs/heads/${h.branch}`}\n`);
}

// show [-s] [--format=…] <rev> / show <rev>:<path>
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdShow(repo, args) {
    let fmt = null;
    const pos = [];
    for (const a of args) {
        if (a.startsWith('--format=')) { fmt = a.slice('--format='.length); continue; }
        if (a.startsWith('-') && a !== '-') continue; // -s 等标志：不改变口径
        pos.push(a);
    }
    const spec = pos[pos.length - 1] || 'HEAD';
    const colon = spec.indexOf(':');
    if (colon > 0) {
        const rev = spec.slice(0, colon);
        const p = spec.slice(colon + 1);
        const sha = f_resolveCommitish(repo, rev);
        const commit = sha && f_readObject(repo, sha, 'commit');
        const tree = f_treeOf(repo, commit);
        if (!commit || !(p in tree)) return f_fatal(`path '${p}' does not exist in '${rev}'`);
        const data = f_readObject(repo, tree[p], 'blob');
        return f_ok(data ? data.toString('utf8') : '');
    }
    const sha = f_resolveCommitish(repo, spec);
    const commit = sha && f_readObject(repo, sha, 'commit');
    if (!commit) return f_fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
    if (fmt != null) return f_ok(`${f_expandFormat(fmt, sha, commit)}\n`); // 记录终止换行（对齐 log）
    return f_ok(`commit ${sha}\nAuthor: ${commit.author?.name || ''} <${commit.author?.email || ''}>\nDate:   ${f_isoStrict(commit.at)}\n\n    ${String(commit.message || '').split('\n').join('\n    ')}\n`);
}

// diff-tree --no-commit-id --name-only -r <rev>
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdDiffTree(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const rev = args.find((a) => !a.startsWith('-'));
    const sha = f_resolveCommitish(repo, rev || 'HEAD');
    const commit = sha && f_readObject(repo, sha, 'commit');
    if (!commit) return f_fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    if ((commit.parents?.length || 0) > 1 && !args.includes('-m')) return f_ok();
    const paths = f_changedPaths(repo, sha, commit);
    return f_ok(paths.length ? `${paths.join('\n')}\n` : '');
}

// ls-tree --name-only -r <rev>
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdLsTree(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const rev = args.find((a) => !a.startsWith('-'));
    const sha = f_resolveCommitish(repo, rev || 'HEAD');
    const commit = sha && f_readObject(repo, sha, 'commit');
    if (!commit) return f_fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    const paths = Object.keys(f_treeOf(repo, commit)).sort();
    return f_ok(paths.length ? `${paths.join('\n')}\n` : '');
}

// diff：HEAD -- <p>（简化统一差异）/ --cached --quiet（退出码）/ --name-only --diff-filter=U（恒空）
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdDiff(repo, args) {
    const dd = args.indexOf('--');
    const before = dd >= 0 ? args.slice(0, dd) : args;
    const paths = dd >= 0 ? args.slice(dd + 1) : [];
    const cached = before.includes('--cached') || before.includes('staged');
    const quiet = before.includes('--quiet') || before.includes('-q');
    // 私有方法：仅在本文件实现中使用，不导出。
    const rev = before.find((a) => !a.startsWith('-') && a !== 'HEAD') || 'HEAD';
    if (before.includes('--diff-filter=U') || before.includes('--name-only')) {
        return f_ok(''); // 无冲突模型：未合并清单恒空
    }
    if (cached) {
        const head = f_headTree(repo);
        const index = f_readIndex(repo);
        const scope = paths.length
            ? (p) => paths.some((spec) => f_matchPathspec(spec, p))
            : () => true;
        const dirty = [...new Set([...Object.keys(head), ...Object.keys(index)])]
            .some((p) => scope(p) && head[p] !== index[p]);
        return dirty ? { status: 1, stdout: '', stderr: '' } : f_ok();
    }
    // 工作树 vs <rev>：简化统一差异（整块 -旧/+新，无行级 LCS）
    const sha = f_resolveCommitish(repo, rev);
    const commit = sha && f_readObject(repo, sha, 'commit');
    if (!commit) return f_fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    const tree = f_treeOf(repo, commit);
    const out = [];
    const scope = paths.length ? paths : [''];
    for (const spec of scope) {
        for (const p of new Set([...Object.keys(tree), ...f_listWorktree(repo)])) {
            if (!f_matchPathspec(spec, p)) continue;
            const oldData = p in tree ? f_readObject(repo, tree[p], 'blob') : null;
            const newData = f_readWorktreeFile(repo, p);
            const oldText = oldData ? oldData.toString('utf8') : null;
            const newText = newData ? newData.toString('utf8') : null;
            if (oldText === (newText == null ? null : newText)) continue;
            out.push(`diff --git a/${p} b/${p}`);
            out.push(`--- ${oldText == null ? '/dev/null' : `a/${p}`}`);
            out.push(`+++ ${newText == null ? '/dev/null' : `b/${p}`}`);
            const oldLines = oldText == null ? [] : oldText.split('\n');
            const newLines = newText == null ? [] : newText.split('\n');
            out.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
            oldLines.filter((l, i) => i < oldLines.length - 1 || l !== '').forEach((l) => out.push(`-${l}`));
            newLines.filter((l, i) => i < newLines.length - 1 || l !== '').forEach((l) => out.push(`+${l}`));
        }
    }
    return f_ok(out.length ? `${out.join('\n')}\n` : '');
}

// check-ignore -q [--] <p>：根 .gitignore 最小忽略模型
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdCheckIgnore(repo, args) {
    const pats = f_ignorePatterns(repo);
    const specs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { specs.push(...args.slice(i + 1)); break; }
        if (args[i].startsWith('-')) continue;
        specs.push(args[i]);
    }
    if (!specs.length) return f_ok('');
    return specs.every((p) => f_isIgnored(pats, p)) ? f_ok() : { status: 1, stdout: '', stderr: '' };
}

// 引用枚举直接读取已创建的 heads/tags，格式输出与查询命令共享真实引用状态。
// 私有方法：仅在本文件实现中使用，不导出。
function f_allRefs(repo) {
    const refs = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_walk = rel => {
        const directory = path.join(repo.gitDir, rel);
        if (!fs.existsSync(directory)) return;
        for (const name of fs.readdirSync(directory)) {
            const next = `${rel}/${name}`;
            if (fs.statSync(path.join(repo.gitDir, next)).isDirectory()) f_walk(next);
            else refs.push({ name: next, sha: repo.f_readText(next).trim() });
        }
    };
    f_walk('refs');
    return refs.sort((a, b) => f_compareRefNames(a.name, b.name));
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdForEachRef(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const patterns = args.filter(a => !a.startsWith('-'));
    // 私有方法：仅在本文件实现中使用，不导出。
    const fmt = args.find(a => a.startsWith('--format='))?.slice(9) || '%(objectname) %(objecttype)\t%(refname)';
    return f_ok(f_allRefs(repo).filter(ref => !patterns.length || patterns.some(p => ref.name.startsWith(p))).map(ref =>
        fmt.replace(/%\(([^)]+)\)/g, (_match, key) => {
            if (key === 'refname:short') return ref.name.replace(/^refs\/(heads|tags|remotes)\//, '');
            if (key === 'refname') return ref.name;
            if (key === 'objectname') return ref.sha;
            if (key === 'objecttype') return 'commit';
            return '';
        }).replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16))) + '\n').join(''));
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdTag(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const names = args.filter(a => !a.startsWith('-'));
    if (!names.length || args.includes('-l') || args.includes('--list'))
        return f_ok(f_allRefs(repo).filter(ref => ref.name.startsWith('refs/tags/')).map(ref => `${ref.name.slice(10)}\n`).join(''));
    const name = names[0], ref = `refs/tags/${name}`;
    if (!f_validRefName(name)) return f_fatal(`'${name}' is not a valid tag name.`);
    if (repo.f_readText(ref) && !args.includes('-f')) return f_fatal(`tag '${name}' already exists`);
    const sha = f_resolveCommitish(repo, names[1] || 'HEAD');
    if (!sha) return f_fatal(`Failed to resolve '${names[1] || 'HEAD'}' as a valid ref.`);
    repo.f_write(ref, `${sha}\n`);
    return f_ok();
}

// 写入新提交时同时推进引用、暂存区和工作树；反向提交与合并共享该出口。
// 私有方法：仅在本文件实现中使用，不导出。
function f_commitTree(repo, tree, message, parents, config) {
    const before = f_headTree(repo);
    const checked = f_checkoutTree(repo, tree);
    if (checked.status) return checked;
    const who = f_authorOf(config);
    const commit = { tree: f_storeObject(repo, 'tree', f_treeText(tree)), parents, author: who, committer: who,
        message, at: new Date().toISOString() };
    const sha = f_storeObject(repo, 'commit', JSON.stringify(commit));
    const head = f_headState(repo);
    if (head.branch) f_writeRef(repo, head.branch, sha);
    else f_setDetached(repo, sha);
    // 私有方法：仅在本文件实现中使用，不导出。
    const paths = [...new Set([...Object.keys(before), ...Object.keys(tree)])].filter(p => before[p] !== tree[p]);
    let insertions = 0, deletions = 0;
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_count = hash => hash ? f_readObject(repo, hash, 'blob').toString().split('\n').filter(Boolean).length : 0;
    for (const p of paths) { insertions += f_count(tree[p]); deletions += f_count(before[p]); }
    const stats = [` ${paths.length} file${paths.length === 1 ? '' : 's'} changed`];
    if (insertions) stats.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`);
    if (deletions) stats.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`);
    // 私有方法：仅在本文件实现中使用，不导出。
    const modes = paths.filter(p => !tree[p] || !before[p]).map(p => ` ${tree[p] ? 'create' : 'delete'} mode 100644 ${p}\n`).join('');
    return f_ok(`[${head.branch || 'detached HEAD'} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n${stats.join(', ')}\n${modes}`);
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdReset(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const spec = args.find(a => !a.startsWith('-')) || 'HEAD';
    const sha = f_resolveCommitish(repo, spec);
    if (!sha) return f_fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
    const commit = f_readObject(repo, sha, 'commit'), tree = f_treeOf(repo, commit);
    if (args.includes('--hard')) f_checkoutTree(repo, tree, true);
    else if (!args.includes('--soft')) f_writeIndex(repo, tree);
    const head = f_headState(repo);
    if (head.branch) f_writeRef(repo, head.branch, sha);
    else f_setDetached(repo, sha);
    for (const state of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD']) fs.rmSync(path.join(repo.localDir, state), { force: true });
    return f_ok(args.includes('--hard') ? `HEAD is now at ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n` : '');
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_applyTreeDelta(repo, base, change, target) {
    const result = { ...target };
    for (const p of new Set([...Object.keys(base), ...Object.keys(change)])) {
        if (base[p] === change[p]) continue;
        if (target[p] !== base[p] && target[p] !== change[p])
            return { conflict: p };
        if (change[p]) result[p] = change[p];
        else delete result[p];
    }
    return { tree: result };
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdReplay(repo, args, config, reverse) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const spec = args.find(a => !a.startsWith('-')) || 'HEAD';
    const sha = f_resolveCommitish(repo, spec), head = f_resolveCommitish(repo, 'HEAD');
    if (!sha) return f_fatal(`bad revision '${spec}'`);
    const commit = f_readObject(repo, sha, 'commit');
    const previous = f_treeOf(repo, f_readObject(repo, commit.parents[0], 'commit'));
    const current = f_treeOf(repo, commit);
    const applied = f_applyTreeDelta(repo, reverse ? current : previous, reverse ? previous : current, f_headTree(repo));
    if (applied.conflict) return { status: 1, stdout: `CONFLICT (content): Merge conflict in ${applied.conflict}\n`, stderr: `error: could not apply ${sha.slice(0, 7)}... ${commit.message.split('\n')[0]}\n` };
    if (f_treeText(applied.tree) === f_treeText(f_headTree(repo))) {
        repo.f_write(reverse ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD', `${sha}\n`);
        return { status: 1,
            stdout: `On branch ${f_headState(repo).branch}\nYou are currently cherry-picking commit ${sha.slice(0, 7)}.\n  (all conflicts fixed: run "git cherry-pick --continue")\n  (use "git cherry-pick --skip" to skip this patch)\n  (use "git cherry-pick --abort" to cancel the cherry-pick operation)\n\nnothing to commit, working tree clean\n`,
            stderr: "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n" };
    }
    const message = reverse ? `Revert "${commit.message.split('\n')[0]}"\n\nThis reverts commit ${sha}.`
        : commit.message + (args.includes('-x') ? `\n\n(cherry picked from commit ${sha})` : '');
    return f_commitTree(repo, applied.tree, message, [head], config);
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdMerge(repo, args, config) {
    const last = args.at(-1), sha = f_resolveCommitish(repo, last), head = f_resolveCommitish(repo, 'HEAD');
    if (!sha) return { status: 1, stdout: '', stderr: `merge: ${last} - not something we can merge\n` };
    if (f_collectCommits(repo, [head]).some(e => e.sha === sha)) return f_ok('Already up to date.\n');
    const target = f_treeOf(repo, f_readObject(repo, sha, 'commit'));
    if (!args.includes('--no-ff') && f_collectCommits(repo, [sha]).some(e => e.sha === head)) {
        const checked = f_checkoutTree(repo, target);
        if (checked.status) return checked;
        const h = f_headState(repo);
        if (h.branch) f_writeRef(repo, h.branch, sha); else f_setDetached(repo, sha);
        return f_ok(`Updating ${head.slice(0, 7)}..${sha.slice(0, 7)}\nFast-forward\n`);
    }
    const baseResult = f_cmdMergeBase(repo, [head, sha]);
    const base = f_treeOf(repo, f_readObject(repo, baseResult.stdout.trim(), 'commit'));
    const merged = f_applyTreeDelta(repo, base, target, f_treeOf(repo, f_readObject(repo, head, 'commit')));
    if (merged.conflict) return { status: 1, stdout: `CONFLICT (content): Merge conflict in ${merged.conflict}\nAutomatic merge failed; fix conflicts and then commit the result.\n`, stderr: '' };
    const at = args.indexOf('-m');
    const message = at >= 0 ? args[at + 1] : `Merge branch '${last}'`;
    const committed = f_commitTree(repo, merged.tree, message, [head, sha], config);
    if (committed.status) return committed;
    return f_ok("Merge made by the 'ort' strategy.\n");
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdStash(repo, args) {
    const saved = repo.f_readText('stash.json');
    if (args[0] === 'pop' || args[0] === 'apply') {
        if (!saved) return { status: 1, stdout: '', stderr: 'No stash entries found.\n' };
        const data = JSON.parse(saved);
        for (const [p, text] of Object.entries(data.files)) {
            fs.mkdirSync(path.dirname(path.join(repo.root, p)), { recursive: true });
            fs.writeFileSync(path.join(repo.root, p), Buffer.from(text, 'base64'));
        }
        f_writeIndex(repo, data.index);
        if (args[0] === 'pop') fs.rmSync(path.join(repo.gitDir, 'stash.json'), { force: true });
        return f_ok();
    }
    if (!f_cmdStatus(repo, ['--porcelain']).stdout) return f_ok('No local changes to save\n');
    // 私有方法：仅在本文件实现中使用，不导出。
    const files = Object.fromEntries(f_listWorktree(repo).map(p => [p, f_readWorktreeFile(repo, p).toString('base64')]));
    repo.f_write('stash.json', JSON.stringify({ files, index: f_readIndex(repo) }));
    const sha = f_resolveCommitish(repo, 'HEAD'), commit = f_readObject(repo, sha, 'commit');
    f_checkoutTree(repo, f_headTree(repo), true);
    return f_ok(`Saved working directory and index state WIP on ${f_headState(repo).branch}: ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n`);
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdWorktree(repo, args) {
    // 私有方法：仅在本文件实现中使用，不导出。
    const action = args[0], operands = args.slice(1).filter(a => !a.startsWith('-'));
    const target = path.resolve(repo.root, operands[0] || '.');
    if (action === 'remove') {
        const marker = path.join(target, '.git');
        if (!fs.existsSync(marker) || fs.statSync(marker).isDirectory()) return f_fatal(`'${target}' is not a working tree`);
        const linked = f_locateRepo(target);
        if (!linked || linked.gitDir !== repo.gitDir) return f_fatal(`'${target}' is not a working tree`);
        if (!args.includes('--force') && f_cmdStatus(linked, ['--porcelain']).stdout) return f_fatal(`'${target}' contains modified or untracked files, use --force to delete it`);
        fs.rmSync(linked.localDir, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
        return f_ok();
    }
    if (action !== 'add') return { status: 129, stdout: '', stderr: 'usage: git worktree add <path> [<commit-ish>]\n' };
    const name = operands[1] || path.basename(target);
    const preparing = `Preparing worktree (checking out '${name}')\n`;
    const main = f_openRepo(path.dirname(repo.gitDir));
    if (f_headState(main).branch === name && !args.includes('--force'))
        return { status: 128, stdout: '', stderr: preparing + `fatal: '${name}' is already used by worktree at '${main.root}'\n` };
    const registered = path.join(repo.gitDir, 'worktrees');
    if (fs.existsSync(registered) && !args.includes('--force')) {
        for (const id of fs.readdirSync(registered)) {
            const admin = path.join(registered, id);
            const pointer = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
            if (f_headState(f_openRepo(path.dirname(pointer), admin)).branch === name)
                return { status: 128, stdout: '', stderr: preparing + `fatal: '${name}' is already used by worktree at '${path.dirname(pointer)}'\n` };
        }
    }
    const sha = f_resolveCommitish(repo, name);
    if (!sha) return f_fatal(`invalid reference: ${name}`);
    const admin = path.join(repo.gitDir, 'worktrees', path.basename(target));
    if (fs.existsSync(target) && fs.readdirSync(target).length) return f_fatal(`'${target}' already exists`);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(target, '.git'), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(admin, 'gitdir'), path.join(target, '.git'));
    const linked = f_openRepo(target, admin);
    f_setHead(linked, name);
    f_checkoutTree(linked, f_treeOf(repo, f_readObject(repo, sha, 'commit')), true);
    const commit = f_readObject(repo, sha, 'commit');
    return { status: 0, stdout: `HEAD is now at ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n`, stderr: preparing };
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdRemote(repo, args) {
    const remotes = JSON.parse(repo.f_readText('remotes.json') || '{}');
    if (args[0] === 'add') { remotes[args[1]] = args[2]; repo.f_write('remotes.json', JSON.stringify(remotes)); return f_ok(); }
    if (args[0] === 'get-url') return remotes[args[1]] ? f_ok(`${remotes[args[1]]}\n`) : { status: 2, stdout: '', stderr: `error: No such remote '${args[1]}'\n` };
    return f_ok(Object.keys(remotes).sort().map(name => `${name}\n`).join(''));
}
// 私有方法：仅在本文件实现中使用，不导出。
function f_cmdTransport(repo, command, args) {
    const remotes = JSON.parse(repo.f_readText('remotes.json') || '{}');
    if (command === 'fetch' && args.includes('--all') && !Object.keys(remotes).length) return f_ok();
    // 私有方法：仅在本文件实现中使用，不导出。
    const remote = args.find(a => !a.startsWith('-')) || 'origin';
    return { status: 128, stdout: '', stderr: `fatal: '${remotes[remote] || remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n` };
}

// ---------- 分派 ----------

// 私有方法：仅在本文件实现中使用，不导出。
function f_runGit(argv, options, ctx) {
    const config = new Map();
    let optionalLocks = true;
    let cwd = options?.cwd || ctx.cwd();
    let rest = [...argv];
    // 全局选项：-c <k>=<v>、-C <dir>、--no-optional-locks 等只读加锁/分页前缀
    while (rest.length) {
        const a = rest[0];
        if (a === '-c' && rest.length > 1) {
            const at = String(rest[1]).indexOf('=');
            if (at > 0) config.set(String(rest[1]).slice(0, at), String(rest[1]).slice(at + 1));
            rest = rest.slice(2);
        } else if (a === '-C' && rest.length > 1) {
            cwd = rest[1];
            rest = rest.slice(2);
        } else if (a === '--no-optional-locks' || a === '--no-pager' || a === '--literal-pathspecs') {
            if (a === '--no-optional-locks') optionalLocks = false;
            rest = rest.slice(1);
        } else break;
    }
    const cmd = String(rest[0] || '');
    const args = rest.slice(1);
    if (!cmd) return f_fatal('no command given');
    if (cmd === 'init') return f_cmdInit(cwd, args);
    const repo = f_locateRepo(cwd);
    const gate = f_needRepo(repo);
    if (gate) return gate;
    try {
        switch (cmd) {
            case 'add': return f_withIndexLock(repo, false, () => f_cmdAdd(repo, args));
            case 'rm': return f_withIndexLock(repo, false, () => f_cmdRm(repo, args));
            case 'commit': return f_withIndexLock(repo, false, () => f_cmdCommit(repo, args, config));
            case 'status': {
                const scan = ({ lockPath, lockAcquired }) => {
                    for (const observer of [...f_statusObservers]) {
                        const result = observer({ cwd, root: repo.root, lockPath, lockAcquired, optionalLocks });
                        if (result && typeof result.then === 'function') throw new TypeError('状态扫描检查点必须同步执行');
                    }
                    return f_cmdStatus(repo, args);
                };
                return optionalLocks ? f_withIndexLock(repo, true, scan)
                    : scan({ lockPath: path.join(repo.localDir, 'index.lock'), lockAcquired: false });
            }
            case 'log': return f_cmdLog(repo, args);
            case 'rev-parse': return f_cmdRevParse(repo, args);
            case 'rev-list': return f_cmdRevList(repo, args);
            case 'branch': return f_cmdBranch(repo, args);
            case 'switch': return f_cmdSwitch(repo, args);
            case 'checkout': return f_cmdCheckout(repo, args);
            case 'merge-base': return f_cmdMergeBase(repo, args);
            case 'ls-files': return f_cmdLsFiles(repo, args);
            case 'symbolic-ref': return f_cmdSymbolicRef(repo, args);
            case 'show': return f_cmdShow(repo, args);
            case 'diff-tree': return f_cmdDiffTree(repo, args);
            case 'ls-tree': return f_cmdLsTree(repo, args);
            case 'diff': return f_cmdDiff(repo, args);
            case 'check-ignore': return f_cmdCheckIgnore(repo, args);
            case 'for-each-ref': return f_cmdForEachRef(repo, args);
            case 'remote': return f_cmdRemote(repo, args);
            case 'tag': return f_cmdTag(repo, args);
            case 'reset': return f_cmdReset(repo, args);
            case 'merge': return f_cmdMerge(repo, args, config);
            case 'cherry-pick': return f_cmdReplay(repo, args, config, false);
            case 'revert': return f_cmdReplay(repo, args, config, true);
            case 'stash': return f_cmdStash(repo, args);
            case 'worktree': return f_cmdWorktree(repo, args);
            case 'fetch': case 'push': case 'pull': return f_cmdTransport(repo, cmd, args);
            default:
                return {
                    status: 1,
                    stdout: '',
                    stderr: `git: '${cmd}' is not a git command. See 'git --help'.\n`,
                };
        }
    } catch (error) {
        return f_fatal(String(error && error.message ? error.message : error));
    }
}

// 测试专用方法：显式安装 Git 命令；重复调用保留已有钩子与故障配置。
export function t_install() {
    if (mgr.command('/mock-cmd/usr/bin/git')) return;
    mgr.pkg_defineCommand('/mock-cmd/usr/bin/git', {
        // 内部方法：向命令注入框架提供 Git 扫描检查点，不作为公共命令入口。
        pkg_injectCheckpoint(name, observer) {
            if (name !== 'status-scan') throw new Error(`Git 不支持检查点：${name}`);
            return pkg_onStatusScan(observer);
        },
        // 内部方法：命令实现协议，由执行层分派，测试通过 spawn 等公共入口触发。
        pkg_runSync(argv, ctx) {
            return f_runGit(argv, ctx.options, ctx);
        },
    });
}
