// lite-cmd-git：显式导入后在 mgr 注册 /mock-cmd/usr/bin/git。
// 命令均由 lite-child_process.spawn/spawnSync 派遣，调用账本与清理统一归该模块；
// mgr.command('git').onRun 只负责配置脚本钩子。异步执行由子进程门面复用同步命令实现。
// 本模块在 lite-fs 当前作用域维护仓库、提交 DAG、暂存区、引用与工作树，执行命令时不调用
// 系统 Git。分支切换会更新工作树并检查覆盖冲突；标签、reset、revert、cherry-pick、merge、
// stash 与 worktree 更新对应状态。无远端 fetch --all 成功，不可访问远端的传输命令失败。
// 内部存储是测试环境的私有格式，不是原生 Git 磁盘格式：
//   .git/HEAD、refs/heads/*、refs/tags/*：文本引用；
//   .git/objects/<sha1>：类型行 + blob 原文或 tree/commit JSON；
//   .git/index.json：path → blobSha 的暂存映射；
//   .git/worktrees/*：共享对象与引用，各工作树独立维护 HEAD 和暂存区。
// 状态随 lite-fs 卷生命周期保存或丢弃，不在命令模块中另设运行账本。
import crypto from 'node:crypto';
import path from 'node:path';
import mgr from './lite-cmd-mgr.mjs';
import fs from './lite-fs.mjs';

// ---------- 仓库与对象模型 ----------

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

function openRepo(root, localDir = path.join(root, '.git')) {
    let gitDir = localDir;
    try { gitDir = path.resolve(localDir, fs.readFileSync(path.join(localDir, 'commondir'), 'utf8').trim()); } catch { /* 主工作树没有 commondir */ }
    const abs = rel => path.join(/^(HEAD|index.json|CHERRY_PICK_HEAD|MERGE_HEAD|REVERT_HEAD)$/.test(rel) ? localDir : gitDir, ...String(rel).split('/'));
    return {
        root,
        gitDir,
        localDir,
        read(rel) {
            try { return fs.readFileSync(abs(rel)); } catch { return null; }
        },
        readText(rel) {
            try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; }
        },
        write(rel, data) {
            fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
            fs.writeFileSync(abs(rel), data);
        },
    };
}

// 仓库发现：从 dir 逐级上溯找 .git（存在即命中）
function locateRepo(dir) {
    let cur = path.resolve(String(dir || '.'));
    for (;;) {
        const marker = path.join(cur, '.git');
        if (fs.existsSync(marker)) {
            if (fs.statSync(marker).isDirectory()) return openRepo(cur);
            const pointer = /^gitdir: (.+)/.exec(fs.readFileSync(marker, 'utf8'));
            if (pointer) return openRepo(cur, path.resolve(cur, pointer[1]));
        }
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
}

// 对象存取：文件 = `<type>\n` + 载荷；hash = 载荷 sha1（blob 按内容、commit/tree 按 JSON 文本）
function storeObject(repo, type, payload) {
    const body = Buffer.concat([Buffer.from(`${type}\n`), Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))]);
    const hash = sha1(body.slice(type.length + 1));
    const existing = repo.read(`objects/${hash}`);
    if (!existing || !existing.equals(body)) repo.write(`objects/${hash}`, body);
    return hash;
}

function readObject(repo, hash, wantType) {
    const raw = repo.read(`objects/${hash}`);
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

const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const validRefName = (name) => REF_NAME_RE.test(name)
    && !name.includes('..') && !name.includes('//') && !name.endsWith('.lock');

function readRef(repo, branch) {
    const text = repo.readText(`refs/heads/${branch}`);
    return text != null ? text.trim() : null;
}

function writeRef(repo, branch, hash) {
    repo.write(`refs/heads/${branch}`, `${hash}\n`);
}

function listBranches(repo) {
    const names = [];
    const walk = (rel) => {
        let entries = [];
        try { entries = fs.readdirSync(path.join(repo.gitDir, 'refs', 'heads', ...rel)); } catch { return; }
        for (const name of entries) {
            const r = rel.length ? `${rel}/${name}` : name;
            let st = null;
            try { st = fs.statSync(path.join(repo.gitDir, 'refs', 'heads', ...r.split('/'))); } catch { continue; }
            if (st.isDirectory()) walk(r);
            else names.push(r);
        }
    };
    walk([]);
    return names.sort();
}

function headState(repo) {
    const text = String(repo.readText('HEAD') || '').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    if (m) return { branch: m[1] };
    if (/^[0-9a-f]{40}$/.test(text)) return { detached: text };
    return {};
}

function setHead(repo, branch) {
    repo.write('HEAD', `ref: refs/heads/${branch}\n`);
}

function setDetached(repo, hash) {
    repo.write('HEAD', `${hash}\n`);
}

function headCommit(repo) {
    const h = headState(repo);
    if (h.detached) return readObject(repo, h.detached, 'commit');
    if (h.branch) {
        const sha = readRef(repo, h.branch);
        return sha ? readObject(repo, sha, 'commit') : null; // 未出生分支：空仓库
    }
    return null;
}

// ---------- 暂存区 / 树 / 工作树 ----------

function readIndex(repo) {
    const text = repo.readText('index.json');
    if (text == null) return {};
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
}

const treeText = (tree) => JSON.stringify(tree, Object.keys(tree).sort());

function writeIndex(repo, index) {
    repo.write('index.json', `${treeText(index)}\n`);
}

function treeOf(repo, commit) {
    return commit && commit.tree ? (readObject(repo, commit.tree, 'tree') || {}) : {};
}

function headTree(repo) {
    return treeOf(repo, headCommit(repo));
}

// 工作树枚举：跳过 .git，返回仓库根相对 posix 路径（有序）
function listWorktree(repo) {
    const files = [];
    const walk = (rel) => {
        let names = [];
        try { names = fs.readdirSync(rel ? path.join(repo.root, ...rel.split('/')) : repo.root); } catch { return; }
        for (const name of names) {
            if (!rel && name === '.git') continue;
            const r = rel ? `${rel}/${name}` : name;
            let st = null;
            try { st = fs.statSync(path.join(repo.root, ...r.split('/'))); } catch { continue; }
            if (st.isDirectory()) walk(r);
            else files.push(r);
        }
    };
    walk('');
    return files.sort();
}

// 根 .gitignore 最小忽略模型：逐行路径 / 目录（尾 /）模式，按仓库根锚定的精确或目录前缀匹配
function ignorePatterns(repo) {
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

function isIgnored(pats, p) {
    let cur = p;
    while (cur) {
        if (pats.has(cur)) return true;
        const at = cur.lastIndexOf('/');
        if (at === -1) return false;
        cur = cur.slice(0, at);
    }
    return false;
}

function readWorktreeFile(repo, p) {
    try { return fs.readFileSync(path.join(repo.root, ...p.split('/'))); } catch { return null; }
}

// pathspec 匹配：精确路径或目录前缀（'.' / 空串 = 全部）
function matchPathspec(spec, p) {
    const s = String(spec || '');
    if (s === '.' || s === '') return true;
    return p === s || p.startsWith(`${s}/`);
}

// ---------- 提交号解析与遍历 ----------

function commitHashes(repo) {
    let names = [];
    try { names = fs.readdirSync(path.join(repo.gitDir, 'objects')); } catch { return []; }
    return names.filter((n) => /^[0-9a-f]{40}$/.test(n)).map((n) => n.toLowerCase());
}

// 提交号解析：HEAD、分支名、refs/heads/x、40 位全号 / ≥4 位前缀、<rev>^{commit}
function resolveCommitish(repo, spec) {
    const raw = String(spec || '');
    const base = /\^\{commit\}$/.test(raw) ? raw.slice(0, -9) : raw;
    const ancestor = /^(.*)([~^])(\d*)$/.exec(base);
    if (ancestor) {
        let sha = resolveCommitish(repo, ancestor[1]);
        const count = Number(ancestor[3] || 1);
        if (ancestor[2] === '^') return count === 0 ? sha : (readObject(repo, sha, 'commit')?.parents[count - 1] || null);
        for (let i = 0; i < count && sha; i++) sha = readObject(repo, sha, 'commit')?.parents[0] || null;
        return sha;
    }
    const tag = repo.readText(`refs/tags/${base.replace(/^refs\/tags\//, '')}`);
    if (tag) return tag.trim();
    if (base === 'HEAD') {
        const h = headState(repo);
        if (h.detached) return h.detached;
        return h.branch ? readRef(repo, h.branch) : null; // 未出生分支 → null
    }
    if (base.startsWith('refs/heads/')) return readRef(repo, base.slice('refs/heads/'.length));
    if (validRefName(base)) {
        const ref = readRef(repo, base);
        if (ref != null) return ref;
    }
    if (/^[0-9a-f]{4,40}$/i.test(base)) {
        const low = base.toLowerCase();
        if (low.length === 40 && readObject(repo, low, 'commit')) return low;
        const hits = commitHashes(repo).filter((h) => h.startsWith(low));
        if (hits.length === 1) return hits[0];
    }
    return null;
}

// 从 tips 沿 parents 收集提交（去重、排除 excludeTips 可达），发现序（DFS 子先于父）
function collectCommits(repo, tips, excludeTips = []) {
    const excl = new Set();
    const markExcl = (sha) => {
        if (!sha || excl.has(sha)) return;
        excl.add(sha);
        const c = readObject(repo, sha, 'commit');
        if (c) for (const p of c.parents || []) markExcl(p);
    };
    for (const t of excludeTips) markExcl(resolveCommitish(repo, t) || t);
    const seen = new Set();
    const found = [];
    const visit = (sha) => {
        if (!sha || seen.has(sha) || excl.has(sha)) return;
        seen.add(sha);
        const c = readObject(repo, sha, 'commit');
        if (!c) return;
        found.push({ sha, commit: c });
        for (const p of c.parents || []) visit(p);
    };
    for (const t of tips) visit(resolveCommitish(repo, t) || t);
    return found;
}

const byTimeDesc = (a, b) => new Date(b.commit.at || 0) - new Date(a.commit.at || 0);

// 拓扑序（子先于父）：Kahn——入度 = 集合内子提交数，零入度（最新尖端）先出
function topoOrder(entries) {
    const bySha = new Map(entries.map((e) => [e.sha, e]));
    const kids = new Map(entries.map((e) => [e.sha, 0]));
    for (const e of entries) {
        for (const p of e.commit.parents || []) {
            if (kids.has(p)) kids.set(p, kids.get(p) + 1);
        }
    }
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
function isoStrict(at) {
    const d = new Date(at || 0);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const om = Math.abs(offsetMin);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `${sign}${pad(Math.floor(om / 60))}:${pad(om % 60)}`;
}

// --format 占位符引擎（%H %h %P %p %an %aN %ae %aI %cn %ce %cI %s %B %b %n %% %xNN；
// an/ae/aI/cn/ce/cI 为双字符占位符，先于单字符判定）
function expandFormat(fmt, sha, commit) {
    const message = String(commit.message || '');
    const subject = message.split('\n')[0];
    const out = [];
    for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch !== '%' || i + 1 >= fmt.length) { out.push(ch); continue; }
        const two = fmt.slice(i + 1, i + 3);
        if (two === 'an' || two === 'aN') { out.push(commit.author?.name || ''); i += 2; continue; }
        if (two === 'ae') { out.push(commit.author?.email || ''); i += 2; continue; }
        if (two === 'aI') { out.push(isoStrict(commit.at)); i += 2; continue; }
        if (two === 'cn') { out.push(commit.committer?.name || ''); i += 2; continue; }
        if (two === 'ce') { out.push(commit.committer?.email || ''); i += 2; continue; }
        if (two === 'cI') { out.push(isoStrict(commit.at)); i += 2; continue; }
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
function changedPaths(repo, sha, commit) {
    const cur = treeOf(repo, commit);
    const parent = commit.parents && commit.parents[0]
        ? treeOf(repo, readObject(repo, commit.parents[0], 'commit'))
        : {};
    const paths = new Set([...Object.keys(cur), ...Object.keys(parent)]);
    return [...paths].filter((p) => cur[p] !== parent[p]).sort();
}

// ---------- 子命令实现 ----------

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const notRepo = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
const fatal = (message) => ({ status: 128, stdout: '', stderr: `fatal: ${message}\n` });
const needRepo = (repo) => (repo ? null : notRepo());

function authorOf(config) {
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
function cmdInit(cwd, args) {
    let branch = 'main';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-b' && args[i + 1]) { branch = args[i + 1]; i++; }
        else if (args[i].startsWith('--initial-branch=')) branch = args[i].slice('--initial-branch='.length);
    }
    if (!validRefName(branch)) return fatal(`invalid branch name: ${branch}`);
    const root = path.resolve(String(cwd));
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    const repo = openRepo(root);
    if (repo.readText('HEAD') == null) setHead(repo, branch);
    return ok();
}

// add [-A] [--] <paths…>：工作树文件入 index；工作树不存在的 pathspec 从 index 移除
function cmdAdd(repo, args) {
    const paths = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { paths.push(...args.slice(i + 1)); break; }
        if (args[i].startsWith('-')) continue; // -A/-f/-u 等标志：路径收集口径不变
        paths.push(args[i]);
    }
    if (!paths.length) {
        return { status: 0, stdout: '', stderr: 'Nothing specified, nothing added.\n' }; // 对齐真实 git 无路径口径
    }
    const index = readIndex(repo);
    const pats = ignorePatterns(repo);
    const files = listWorktree(repo).filter((p) => !isIgnored(pats, p));
    let dirty = false;
    for (const spec of paths) {
        const onDisk = new Set(files.filter((p) => matchPathspec(spec, p)));
        for (const p of onDisk) {
            const data = readWorktreeFile(repo, p);
            if (data == null) continue;
            index[p] = storeObject(repo, 'blob', data);
            dirty = true;
        }
        // 工作树不存在（整体暂存删除）：从 index 移除该 pathspec 命中项
        for (const p of Object.keys(index)) {
            if (matchPathspec(spec, p) && !onDisk.has(p)) { delete index[p]; dirty = true; }
        }
    }
    if (dirty) writeIndex(repo, index);
    return ok();
}

// commit [-q] [--only] -m <subject> [--] [paths…]：生成 tree + commit 并推进当前分支
function cmdCommit(repo, args, config) {
    const messages = [];
    const paths = [];
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { paths.push(...args.slice(i + 1)); break; }
        if (a === '-m' || a === '--message') {
            if (args[i + 1] === undefined) return fatal('no commit message given');
            messages.push(args[i + 1]); i++;
        } else if (a.startsWith('--message=')) messages.push(a.slice('--message='.length));
        else if (a.startsWith('-m') && a.length > 2) messages.push(a.slice(2));
        else if (a === '-q' || a === '--quiet') quiet = true;
        else if (a.startsWith('-')) continue; // --only/--include/-v 等：不改变收集口径
        else paths.push(a);
    }
    if (!messages.length) return fatal('no commit message given');
    const message = messages.join('\n\n');
    const h = headState(repo);
    if (!h.branch && !h.detached) return fatal('HEAD 未指向任何分支或提交（仓库骨架异常）');
    const headSha = h.detached || readRef(repo, h.branch);
    const baseTree = headSha ? treeOf(repo, readObject(repo, headSha, 'commit')) : {};
    const index = readIndex(repo);
    const tree = { ...baseTree };
    const pats = ignorePatterns(repo);
    const files = listWorktree(repo).filter((p) => !isIgnored(pats, p));
    if (paths.length) {
        // --only / 显式路径：按路径限定取工作树内容（磁盘缺失 = 提交删除）
        for (const spec of paths) {
            const onDisk = new Set(files.filter((p) => matchPathspec(spec, p)));
            for (const p of onDisk) {
                const data = readWorktreeFile(repo, p);
                if (data == null) continue;
                const hash = storeObject(repo, 'blob', data);
                tree[p] = hash;
                index[p] = hash;
            }
            for (const p of [...Object.keys(tree), ...Object.keys(index)]) {
                if (matchPathspec(spec, p) && !onDisk.has(p)) { delete tree[p]; delete index[p]; }
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
    const treeSha = storeObject(repo, 'tree', treeText(tree));
    const who = authorOf(config);
    const commit = {
        tree: treeSha,
        parents: headSha ? [headSha] : [],
        author: who,
        committer: who,
        message,
        at: new Date().toISOString(),
    };
    const sha = storeObject(repo, 'commit', JSON.stringify(commit));
    if (h.branch) writeRef(repo, h.branch, sha);
    else setDetached(repo, sha);
    writeIndex(repo, index);
    if (quiet) return ok();
    const label = h.branch || 'detached';
    return ok(`[${label} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`);
}

// status --porcelain [-uall] [-- <pathspec>…]：工作树 vs index vs HEAD 的 XY 码
function cmdStatus(repo, args) {
    let specs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { specs = args.slice(i + 1); break; }
    }
    const head = headTree(repo);
    const index = readIndex(repo);
    const pats = ignorePatterns(repo);
    const files = new Set(listWorktree(repo).filter((p) => !isIgnored(pats, p)));
    const lines = [];
    const emit = (code, p) => {
        if (specs.length && !specs.some((spec) => matchPathspec(spec, p))) return;
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
                : sha1(readWorktreeFile(repo, p) || Buffer.alloc(0)) !== index[p] ? 'M' : ' ';
        if (x === ' ' && y === ' ') continue; // 干净路径不上 porcelain
        emit(`${x}${y}`, p);
    }
    for (const p of [...files].sort()) {
        if (p in index) continue;
        emit('??', p);
    }
    return ok(lines.length ? `${lines.join('\n')}\n` : '');
}

// log：格式引擎 + 范围/排除/分页
function cmdLog(repo, args) {
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
            const toSha = resolveCommitish(repo, to);
            if (!toSha) return fatal(`ambiguous argument '${to}': unknown revision or path not in the working tree.`);
            if (resolveCommitish(repo, from)) exclude.push(from);
            tips.push(to);
            continue;
        }
        if (negate) exclude.push(a);
        else tips.push(a);
    }
    if (!tips.length) tips.push('HEAD');
    for (const t of tips) {
        if (!resolveCommitish(repo, t)) return fatal(`ambiguous argument '${t}': unknown revision or path not in the working tree.`);
    }
    const entries = collectCommits(repo, tips, exclude);
    entries.sort(byTimeDesc);
    const page = entries.slice(skip, skip + limit);
    const out = [];
    page.forEach(({ sha, commit }, idx) => {
        out.push(fmt != null ? expandFormat(fmt, sha, commit) : `commit ${sha}`);
        if (nameOnly) {
            out.push('');
            out.push(...changedPaths(repo, sha, commit));
            if (idx < page.length - 1) out.push(''); // 记录间空行（对齐真实 --name-only 布局）
        }
    });
    return ok(out.length ? `${out.join('\n')}\n` : '');
}

// rev-parse：--is-inside-work-tree / --show-toplevel / [--verify [--quiet]] <rev> / --abbrev-ref
function cmdRevParse(repo, args) {
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
            return fatal(`no upstream configured for branch '${spec.replace(/@\{upstream\}$/, '')}'`);
        }
        const sha = resolveCommitish(repo, spec);
        if (!sha) {
            if (verify && quiet) return { status: 1, stdout: '', stderr: '' };
            if (verify) return fatal('Needed a single revision');
            return fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
        }
        out.push(sha);
    }
    if (!out.length) return fatal('arg count required');
    return ok(`${out.join('\n')}\n`);
}

// rev-list：--count / --max-parents=N / --topo-order / --reverse / ^ref 排除
function cmdRevList(repo, args) {
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
        if (!resolveCommitish(repo, t)) return fatal(`ambiguous argument '${t}': unknown revision or path not in the working tree.`);
    }
    let entries = collectCommits(repo, tips, exclude);
    if (maxParents != null) {
        entries = entries.filter((e) => (e.commit.parents || []).length === maxParents);
    }
    if (count) return ok(`${entries.length}\n`);
    let hashes;
    if (topo) hashes = topoOrder(entries);
    else {
        entries = [...entries].sort(byTimeDesc);
        hashes = entries.map((e) => e.sha);
    }
    if (reverse) hashes.reverse();
    return ok(hashes.length ? `${hashes.join('\n')}\n` : '');
}

// branch：--show-current / --format=%(refname:short) / -r（恒空）/ <name> [<start>]
function cmdBranch(repo, args) {
    const pos = [];
    let remote = false;
    let format = null;
    for (const a of args) {
        if (a === '--show-current') {
            const h = headState(repo);
            return ok(h.branch ? `${h.branch}\n` : '');
        }
        if (a === '-r' || a === '-a' || a === '--remotes' || a === '--all') { remote = true; continue; }
        if (a.startsWith('--format=')) { format = a.slice('--format='.length); continue; }
        if (a.startsWith('-')) continue;
        pos.push(a);
    }
    if (remote) return ok(''); // 无远端跟踪引用
    if (format != null || pos.length === 0) {
        if (format != null && format !== '%(refname:short)') return fatal(`unsupported --format: ${format}`);
        return ok(listBranches(repo).map((b) => `${b}\n`).join(''));
    }
    const [name, start] = pos;
    if (!validRefName(name)) return fatal(`invalid branch name: ${name}`);
    if (readRef(repo, name) != null) return fatal(`a branch named '${name}' already exists`);
    const sha = resolveCommitish(repo, start || 'HEAD');
    if (!sha) return fatal(`not a valid object name: '${start || 'HEAD'}'`);
    writeRef(repo, name, sha);
    return ok();
}

// 检出目标树：只更新两次提交之间变化的路径，未涉及的本地修改继续保留。
function checkoutTree(repo, target, force = false) {
    const previous = headTree(repo);
    const index = readIndex(repo);
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(target), ...(force ? Object.keys(index) : [])])]
        .filter(p => force || previous[p] !== target[p]);
    if (!force) {
        for (const p of changed) {
            const data = readWorktreeFile(repo, p);
            const disk = data === null ? undefined : sha1(data);
            if ((disk !== index[p] || index[p] !== previous[p]) && disk !== target[p])
                return { status: 1, stdout: '', stderr: `error: Your local changes to the following files would be overwritten by checkout:\n\t${p}\nPlease commit your changes or stash them before you switch branches.\nAborting\n` };
        }
    }
    for (const p of changed) {
        const filename = path.join(repo.root, p);
        if (target[p]) {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, readObject(repo, target[p], 'blob'));
            index[p] = target[p];
        } else {
            fs.rmSync(filename, { force: true });
            delete index[p];
        }
    }
    writeIndex(repo, force ? target : index);
    return ok();
}

// switch [-q] [-c] <branch> [start]：更新工作树与暂存区后才推进 HEAD。
function cmdSwitch(repo, args) {
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
    if (!name) return fatal('branch name required');
    if (!validRefName(name)) return fatal(`invalid branch name: ${name}`);
    if (create) {
        if (readRef(repo, name) && !args.includes('-C') && !args.includes('--force-create'))
            return fatal(`a branch named '${name}' already exists`);
        const start = pos[1] || 'HEAD';
        const sha = resolveCommitish(repo, start);
        if (!sha) {
            // 空仓库未出生分支：等价于把未出生分支改名（首个提交自然落在新分支）
            const h = headState(repo);
            if (!pos[1] && h.branch && !readRef(repo, h.branch)) { setHead(repo, name); return ok(); }
            return fatal(`not a valid object name: '${start}'`);
        }
        const checked = checkoutTree(repo, treeOf(repo, readObject(repo, sha, 'commit')));
        if (checked.status) return checked;
        writeRef(repo, name, sha);
        setHead(repo, name);
        return ok();
    }
    const sha = readRef(repo, name);
    if (sha == null) return fatal(`invalid reference: ${name}`);
    const checked = checkoutTree(repo, treeOf(repo, readObject(repo, sha, 'commit')));
    if (checked.status) return checked;
    setHead(repo, name);
    return ok();
}

// checkout：分支切换 / detached（提交号）/ <rev> -- <paths> 检出。
function cmdCheckout(repo, args) {
    const dd = args.indexOf('--');
    if (dd >= 0) {
        const rev = args.slice(0, dd).find((a) => !a.startsWith('-')) || 'HEAD';
        const paths = args.slice(dd + 1);
        const sha = resolveCommitish(repo, rev);
        if (!sha) return fatal(`invalid reference: ${rev}`);
        const commit = readObject(repo, sha, 'commit');
        const tree = treeOf(repo, commit);
        const index = readIndex(repo);
        let matched = false;
        for (const spec of paths) {
            for (const p of Object.keys(tree)) {
                if (!matchPathspec(spec, p)) continue;
                matched = true;
                const data = readObject(repo, tree[p], 'blob');
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
        writeIndex(repo, index);
        return ok();
    }
    const target = args.find((a) => !a.startsWith('-'));
    if (!target) return fatal('branch name required');
    if (readRef(repo, target) != null) {
        return cmdSwitch(repo, args);
    }
    const sha = resolveCommitish(repo, target);
    if (!sha) return fatal(`invalid reference: ${target}`);
    const checked = checkoutTree(repo, treeOf(repo, readObject(repo, sha, 'commit')));
    if (checked.status) return checked;
    setDetached(repo, sha); // 提交号 → detached HEAD
    return ok();
}

// merge-base [--is-ancestor] <a> <b>：沿父提交关系求祖先或最佳共同祖先。
function cmdMergeBase(repo, args) {
    const specs = args.filter(a => !a.startsWith('-'));
    if (specs.length < 2) return { status: 129, stdout: '', stderr: 'usage: git merge-base [--all] <commit> <commit>...\n' };
    const [a, b] = specs;
    const aSha = resolveCommitish(repo, a);
    const bSha = resolveCommitish(repo, b);
    if (!aSha || !bSha) return fatal(`not a valid object name: ${!aSha ? a : b}`);
    const reach = collectCommits(repo, [bSha]);
    if (args.includes('--is-ancestor'))
        return { status: reach.some(e => e.sha === aSha) ? 0 : 1, stdout: '', stderr: '' };
    const other = new Set(reach.map(e => e.sha));
    const common = collectCommits(repo, [aSha]).filter(e => other.has(e.sha));
    const best = common.filter(candidate => !common.some(e => e.sha !== candidate.sha
        && collectCommits(repo, [e.sha]).some(ancestor => ancestor.sha === candidate.sha)));
    return best.length ? ok(`${(args.includes('--all') || args.includes('-a') ? best : best.slice(0, 1)).map(e => e.sha).join('\n')}\n`)
        : { status: 1, stdout: '', stderr: '' };
}

// ls-files [--error-unmatch] [--] <p>…：index 命中
function cmdLsFiles(repo, args) {
    let errorUnmatch = false;
    const specs = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { specs.push(...args.slice(i + 1)); break; }
        if (a === '--error-unmatch') { errorUnmatch = true; continue; }
        if (a.startsWith('-')) continue;
        specs.push(a);
    }
    const index = readIndex(repo);
    const all = Object.keys(index).sort();
    if (!specs.length) return ok(all.length ? `${all.join('\n')}\n` : '');
    const hits = new Set();
    for (const spec of specs) {
        const matched = all.filter((p) => matchPathspec(spec, p));
        if (!matched.length && errorUnmatch) {
            return {
                status: 1,
                stdout: '',
                stderr: `error: pathspec '${spec}' did not match any file(s) known to git\n`,
            };
        }
        matched.forEach((p) => hits.add(p));
    }
    return ok(hits.size ? `${[...hits].sort().join('\n')}\n` : '');
}

// symbolic-ref [--quiet] [--short] HEAD：非符号引用默认 128，静默模式为 1。
function cmdSymbolicRef(repo, args) {
    const target = args.find((a) => !a.startsWith('-'));
    const h = headState(repo);
    if (target !== 'HEAD' || !h.branch) {
        const quiet = args.includes('--quiet') || args.includes('-q');
        return { status: quiet ? 1 : 128, stdout: '', stderr: quiet ? '' : `fatal: ref ${target || 'HEAD'} is not a symbolic ref\n` };
    }
    return ok(`${args.includes('--short') ? h.branch : `refs/heads/${h.branch}`}\n`);
}

// show [-s] [--format=…] <rev> / show <rev>:<path>
function cmdShow(repo, args) {
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
        const sha = resolveCommitish(repo, rev);
        const commit = sha && readObject(repo, sha, 'commit');
        const tree = treeOf(repo, commit);
        if (!commit || !(p in tree)) return fatal(`path '${p}' does not exist in '${rev}'`);
        const data = readObject(repo, tree[p], 'blob');
        return ok(data ? data.toString('utf8') : '');
    }
    const sha = resolveCommitish(repo, spec);
    const commit = sha && readObject(repo, sha, 'commit');
    if (!commit) return fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
    if (fmt != null) return ok(`${expandFormat(fmt, sha, commit)}\n`); // 记录终止换行（对齐 log）
    return ok(`commit ${sha}\nAuthor: ${commit.author?.name || ''} <${commit.author?.email || ''}>\nDate:   ${isoStrict(commit.at)}\n\n    ${String(commit.message || '').split('\n').join('\n    ')}\n`);
}

// diff-tree --no-commit-id --name-only -r <rev>
function cmdDiffTree(repo, args) {
    const rev = args.find((a) => !a.startsWith('-'));
    const sha = resolveCommitish(repo, rev || 'HEAD');
    const commit = sha && readObject(repo, sha, 'commit');
    if (!commit) return fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    const paths = changedPaths(repo, sha, commit);
    return ok(paths.length ? `${paths.join('\n')}\n` : '');
}

// ls-tree --name-only -r <rev>
function cmdLsTree(repo, args) {
    const rev = args.find((a) => !a.startsWith('-'));
    const sha = resolveCommitish(repo, rev || 'HEAD');
    const commit = sha && readObject(repo, sha, 'commit');
    if (!commit) return fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    const paths = Object.keys(treeOf(repo, commit)).sort();
    return ok(paths.length ? `${paths.join('\n')}\n` : '');
}

// diff：HEAD -- <p>（简化统一差异）/ --cached --quiet（退出码）/ --name-only --diff-filter=U（恒空）
function cmdDiff(repo, args) {
    const dd = args.indexOf('--');
    const before = dd >= 0 ? args.slice(0, dd) : args;
    const paths = dd >= 0 ? args.slice(dd + 1) : [];
    const cached = before.includes('--cached') || before.includes('staged');
    const quiet = before.includes('--quiet') || before.includes('-q');
    const rev = before.find((a) => !a.startsWith('-') && a !== 'HEAD') || 'HEAD';
    if (before.includes('--diff-filter=U') || before.includes('--name-only')) {
        return ok(''); // 无冲突模型：未合并清单恒空
    }
    if (cached) {
        const head = headTree(repo);
        const index = readIndex(repo);
        const scope = paths.length
            ? (p) => paths.some((spec) => matchPathspec(spec, p))
            : () => true;
        const dirty = [...new Set([...Object.keys(head), ...Object.keys(index)])]
            .some((p) => scope(p) && head[p] !== index[p]);
        return dirty ? { status: 1, stdout: '', stderr: '' } : ok();
    }
    // 工作树 vs <rev>：简化统一差异（整块 -旧/+新，无行级 LCS）
    const sha = resolveCommitish(repo, rev);
    const commit = sha && readObject(repo, sha, 'commit');
    if (!commit) return fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    const tree = treeOf(repo, commit);
    const out = [];
    const scope = paths.length ? paths : [''];
    for (const spec of scope) {
        for (const p of new Set([...Object.keys(tree), ...listWorktree(repo)])) {
            if (!matchPathspec(spec, p)) continue;
            const oldData = p in tree ? readObject(repo, tree[p], 'blob') : null;
            const newData = readWorktreeFile(repo, p);
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
    return ok(out.length ? `${out.join('\n')}\n` : '');
}

// check-ignore -q [--] <p>：根 .gitignore 最小忽略模型
function cmdCheckIgnore(repo, args) {
    const pats = ignorePatterns(repo);
    const specs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') { specs.push(...args.slice(i + 1)); break; }
        if (args[i].startsWith('-')) continue;
        specs.push(args[i]);
    }
    if (!specs.length) return ok('');
    return specs.every((p) => isIgnored(pats, p)) ? ok() : { status: 1, stdout: '', stderr: '' };
}

// 引用枚举直接读取已创建的 heads/tags，格式输出与查询命令共享真实引用状态。
function allRefs(repo) {
    const refs = [];
    const walk = rel => {
        const directory = path.join(repo.gitDir, rel);
        if (!fs.existsSync(directory)) return;
        for (const name of fs.readdirSync(directory)) {
            const next = `${rel}/${name}`;
            if (fs.statSync(path.join(repo.gitDir, next)).isDirectory()) walk(next);
            else refs.push({ name: next, sha: repo.readText(next).trim() });
        }
    };
    walk('refs');
    return refs.sort((a, b) => a.name.localeCompare(b.name));
}
function cmdForEachRef(repo, args) {
    const patterns = args.filter(a => !a.startsWith('-'));
    const fmt = args.find(a => a.startsWith('--format='))?.slice(9) || '%(objectname) %(objecttype)\t%(refname)';
    return ok(allRefs(repo).filter(ref => !patterns.length || patterns.some(p => ref.name.startsWith(p))).map(ref =>
        fmt.replace(/%\(([^)]+)\)/g, (_match, key) => {
            if (key === 'refname:short') return ref.name.replace(/^refs\/(heads|tags|remotes)\//, '');
            if (key === 'refname') return ref.name;
            if (key === 'objectname') return ref.sha;
            if (key === 'objecttype') return 'commit';
            return '';
        }).replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16))) + '\n').join(''));
}
function cmdTag(repo, args) {
    const names = args.filter(a => !a.startsWith('-'));
    if (!names.length || args.includes('-l') || args.includes('--list'))
        return ok(allRefs(repo).filter(ref => ref.name.startsWith('refs/tags/')).map(ref => `${ref.name.slice(10)}\n`).join(''));
    const name = names[0], ref = `refs/tags/${name}`;
    if (!validRefName(name)) return fatal(`'${name}' is not a valid tag name.`);
    if (repo.readText(ref) && !args.includes('-f')) return fatal(`tag '${name}' already exists`);
    const sha = resolveCommitish(repo, names[1] || 'HEAD');
    if (!sha) return fatal(`Failed to resolve '${names[1] || 'HEAD'}' as a valid ref.`);
    repo.write(ref, `${sha}\n`);
    return ok();
}

// 写入新提交时同时推进引用、暂存区和工作树；反向提交与合并共享该出口。
function commitTree(repo, tree, message, parents, config) {
    const before = headTree(repo);
    const checked = checkoutTree(repo, tree);
    if (checked.status) return checked;
    const who = authorOf(config);
    const commit = { tree: storeObject(repo, 'tree', treeText(tree)), parents, author: who, committer: who,
        message, at: new Date().toISOString() };
    const sha = storeObject(repo, 'commit', JSON.stringify(commit));
    const head = headState(repo);
    if (head.branch) writeRef(repo, head.branch, sha);
    else setDetached(repo, sha);
    const paths = [...new Set([...Object.keys(before), ...Object.keys(tree)])].filter(p => before[p] !== tree[p]);
    let insertions = 0, deletions = 0;
    const count = hash => hash ? readObject(repo, hash, 'blob').toString().split('\n').filter(Boolean).length : 0;
    for (const p of paths) { insertions += count(tree[p]); deletions += count(before[p]); }
    const stats = [` ${paths.length} file${paths.length === 1 ? '' : 's'} changed`];
    if (insertions) stats.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`);
    if (deletions) stats.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`);
    const modes = paths.filter(p => !tree[p] || !before[p]).map(p => ` ${tree[p] ? 'create' : 'delete'} mode 100644 ${p}\n`).join('');
    return ok(`[${head.branch || 'detached HEAD'} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n${stats.join(', ')}\n${modes}`);
}
function cmdReset(repo, args) {
    const spec = args.find(a => !a.startsWith('-')) || 'HEAD';
    const sha = resolveCommitish(repo, spec);
    if (!sha) return fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
    const commit = readObject(repo, sha, 'commit'), tree = treeOf(repo, commit);
    if (args.includes('--hard')) checkoutTree(repo, tree, true);
    else if (!args.includes('--soft')) writeIndex(repo, tree);
    const head = headState(repo);
    if (head.branch) writeRef(repo, head.branch, sha);
    else setDetached(repo, sha);
    for (const state of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD']) fs.rmSync(path.join(repo.localDir, state), { force: true });
    return ok(args.includes('--hard') ? `HEAD is now at ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n` : '');
}
function applyTreeDelta(repo, base, change, target) {
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
function cmdReplay(repo, args, config, reverse) {
    const spec = args.find(a => !a.startsWith('-')) || 'HEAD';
    const sha = resolveCommitish(repo, spec), head = resolveCommitish(repo, 'HEAD');
    if (!sha) return fatal(`bad revision '${spec}'`);
    const commit = readObject(repo, sha, 'commit');
    const previous = treeOf(repo, readObject(repo, commit.parents[0], 'commit'));
    const current = treeOf(repo, commit);
    const applied = applyTreeDelta(repo, reverse ? current : previous, reverse ? previous : current, headTree(repo));
    if (applied.conflict) return { status: 1, stdout: `CONFLICT (content): Merge conflict in ${applied.conflict}\n`, stderr: `error: could not apply ${sha.slice(0, 7)}... ${commit.message.split('\n')[0]}\n` };
    if (treeText(applied.tree) === treeText(headTree(repo))) {
        repo.write(reverse ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD', `${sha}\n`);
        return { status: 1,
            stdout: `On branch ${headState(repo).branch}\nYou are currently cherry-picking commit ${sha.slice(0, 7)}.\n  (all conflicts fixed: run "git cherry-pick --continue")\n  (use "git cherry-pick --skip" to skip this patch)\n  (use "git cherry-pick --abort" to cancel the cherry-pick operation)\n\nnothing to commit, working tree clean\n`,
            stderr: "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n" };
    }
    const message = reverse ? `Revert "${commit.message.split('\n')[0]}"\n\nThis reverts commit ${sha}.`
        : commit.message + (args.includes('-x') ? `\n\n(cherry picked from commit ${sha})` : '');
    return commitTree(repo, applied.tree, message, [head], config);
}
function cmdMerge(repo, args, config) {
    const last = args.at(-1), sha = resolveCommitish(repo, last), head = resolveCommitish(repo, 'HEAD');
    if (!sha) return { status: 1, stdout: '', stderr: `merge: ${last} - not something we can merge\n` };
    if (collectCommits(repo, [head]).some(e => e.sha === sha)) return ok('Already up to date.\n');
    const target = treeOf(repo, readObject(repo, sha, 'commit'));
    if (!args.includes('--no-ff') && collectCommits(repo, [sha]).some(e => e.sha === head)) {
        const checked = checkoutTree(repo, target);
        if (checked.status) return checked;
        const h = headState(repo);
        if (h.branch) writeRef(repo, h.branch, sha); else setDetached(repo, sha);
        return ok(`Updating ${head.slice(0, 7)}..${sha.slice(0, 7)}\nFast-forward\n`);
    }
    const baseResult = cmdMergeBase(repo, [head, sha]);
    const base = treeOf(repo, readObject(repo, baseResult.stdout.trim(), 'commit'));
    const merged = applyTreeDelta(repo, base, target, treeOf(repo, readObject(repo, head, 'commit')));
    if (merged.conflict) return { status: 1, stdout: `CONFLICT (content): Merge conflict in ${merged.conflict}\nAutomatic merge failed; fix conflicts and then commit the result.\n`, stderr: '' };
    const at = args.indexOf('-m');
    const message = at >= 0 ? args[at + 1] : `Merge branch '${last}'`;
    const committed = commitTree(repo, merged.tree, message, [head, sha], config);
    if (committed.status) return committed;
    return ok("Merge made by the 'ort' strategy.\n");
}
function cmdStash(repo, args) {
    const saved = repo.readText('stash.json');
    if (args[0] === 'pop' || args[0] === 'apply') {
        if (!saved) return { status: 1, stdout: '', stderr: 'No stash entries found.\n' };
        const data = JSON.parse(saved);
        for (const [p, text] of Object.entries(data.files)) {
            fs.mkdirSync(path.dirname(path.join(repo.root, p)), { recursive: true });
            fs.writeFileSync(path.join(repo.root, p), Buffer.from(text, 'base64'));
        }
        writeIndex(repo, data.index);
        if (args[0] === 'pop') fs.rmSync(path.join(repo.gitDir, 'stash.json'), { force: true });
        return ok();
    }
    if (!cmdStatus(repo, ['--porcelain']).stdout) return ok('No local changes to save\n');
    const files = Object.fromEntries(listWorktree(repo).map(p => [p, readWorktreeFile(repo, p).toString('base64')]));
    repo.write('stash.json', JSON.stringify({ files, index: readIndex(repo) }));
    const sha = resolveCommitish(repo, 'HEAD'), commit = readObject(repo, sha, 'commit');
    checkoutTree(repo, headTree(repo), true);
    return ok(`Saved working directory and index state WIP on ${headState(repo).branch}: ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n`);
}
function cmdWorktree(repo, args) {
    const action = args[0], operands = args.slice(1).filter(a => !a.startsWith('-'));
    const target = path.resolve(repo.root, operands[0] || '.');
    if (action === 'remove') {
        const marker = path.join(target, '.git');
        if (!fs.existsSync(marker) || fs.statSync(marker).isDirectory()) return fatal(`'${target}' is not a working tree`);
        const linked = locateRepo(target);
        if (!linked || linked.gitDir !== repo.gitDir) return fatal(`'${target}' is not a working tree`);
        if (!args.includes('--force') && cmdStatus(linked, ['--porcelain']).stdout) return fatal(`'${target}' contains modified or untracked files, use --force to delete it`);
        fs.rmSync(linked.localDir, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
        return ok();
    }
    if (action !== 'add') return { status: 129, stdout: '', stderr: 'usage: git worktree add <path> [<commit-ish>]\n' };
    const name = operands[1] || path.basename(target);
    const preparing = `Preparing worktree (checking out '${name}')\n`;
    const main = openRepo(path.dirname(repo.gitDir));
    if (headState(main).branch === name && !args.includes('--force'))
        return { status: 128, stdout: '', stderr: preparing + `fatal: '${name}' is already used by worktree at '${main.root}'\n` };
    const registered = path.join(repo.gitDir, 'worktrees');
    if (fs.existsSync(registered) && !args.includes('--force')) {
        for (const id of fs.readdirSync(registered)) {
            const admin = path.join(registered, id);
            const pointer = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
            if (headState(openRepo(path.dirname(pointer), admin)).branch === name)
                return { status: 128, stdout: '', stderr: preparing + `fatal: '${name}' is already used by worktree at '${path.dirname(pointer)}'\n` };
        }
    }
    const sha = resolveCommitish(repo, name);
    if (!sha) return fatal(`invalid reference: ${name}`);
    const admin = path.join(repo.gitDir, 'worktrees', path.basename(target));
    if (fs.existsSync(target) && fs.readdirSync(target).length) return fatal(`'${target}' already exists`);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(target, '.git'), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(admin, 'gitdir'), path.join(target, '.git'));
    const linked = openRepo(target, admin);
    setHead(linked, name);
    checkoutTree(linked, treeOf(repo, readObject(repo, sha, 'commit')), true);
    const commit = readObject(repo, sha, 'commit');
    return { status: 0, stdout: `HEAD is now at ${sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n`, stderr: preparing };
}
function cmdRemote(repo, args) {
    const remotes = JSON.parse(repo.readText('remotes.json') || '{}');
    if (args[0] === 'add') { remotes[args[1]] = args[2]; repo.write('remotes.json', JSON.stringify(remotes)); return ok(); }
    if (args[0] === 'get-url') return remotes[args[1]] ? ok(`${remotes[args[1]]}\n`) : { status: 2, stdout: '', stderr: `error: No such remote '${args[1]}'\n` };
    return ok(Object.keys(remotes).sort().map(name => `${name}\n`).join(''));
}
function cmdTransport(repo, command, args) {
    const remotes = JSON.parse(repo.readText('remotes.json') || '{}');
    if (command === 'fetch' && args.includes('--all') && !Object.keys(remotes).length) return ok();
    const remote = args.find(a => !a.startsWith('-')) || 'origin';
    return { status: 128, stdout: '', stderr: `fatal: '${remotes[remote] || remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n` };
}

// ---------- 分派 ----------

function runGit(argv, options, ctx) {
    const config = new Map();
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
            rest = rest.slice(1);
        } else break;
    }
    const cmd = String(rest[0] || '');
    const args = rest.slice(1);
    if (!cmd) return fatal('no command given');
    if (cmd === 'init') return cmdInit(cwd, args);
    const repo = locateRepo(cwd);
    const gate = needRepo(repo);
    if (gate) return gate;
    try {
        switch (cmd) {
            case 'add': return cmdAdd(repo, args);
            case 'commit': return cmdCommit(repo, args, config);
            case 'status': return cmdStatus(repo, args);
            case 'log': return cmdLog(repo, args);
            case 'rev-parse': return cmdRevParse(repo, args);
            case 'rev-list': return cmdRevList(repo, args);
            case 'branch': return cmdBranch(repo, args);
            case 'switch': return cmdSwitch(repo, args);
            case 'checkout': return cmdCheckout(repo, args);
            case 'merge-base': return cmdMergeBase(repo, args);
            case 'ls-files': return cmdLsFiles(repo, args);
            case 'symbolic-ref': return cmdSymbolicRef(repo, args);
            case 'show': return cmdShow(repo, args);
            case 'diff-tree': return cmdDiffTree(repo, args);
            case 'ls-tree': return cmdLsTree(repo, args);
            case 'diff': return cmdDiff(repo, args);
            case 'check-ignore': return cmdCheckIgnore(repo, args);
            case 'for-each-ref': return cmdForEachRef(repo, args);
            case 'remote': return cmdRemote(repo, args);
            case 'tag': return cmdTag(repo, args);
            case 'reset': return cmdReset(repo, args);
            case 'merge': return cmdMerge(repo, args, config);
            case 'cherry-pick': return cmdReplay(repo, args, config, false);
            case 'revert': return cmdReplay(repo, args, config, true);
            case 'stash': return cmdStash(repo, args);
            case 'worktree': return cmdWorktree(repo, args);
            case 'fetch': case 'push': case 'pull': return cmdTransport(repo, cmd, args);
            default:
                return {
                    status: 1,
                    stdout: '',
                    stderr: `git: '${cmd}' is not a git command. See 'git --help'.\n`,
                };
        }
    } catch (error) {
        return fatal(String(error && error.message ? error.message : error));
    }
}

// git 命令登记：只负责内置 mini-git 语义，调用账本与清理统一归 lite-child_process。
// onRun 世界脚本钩子由 mgr 通用包裹（entry 级，签名 (call, runBuiltin)）
const gitCommand = mgr.defineCommand('/mock-cmd/usr/bin/git', {
    runSync(argv, ctx) {
        return runGit(argv, ctx.options, ctx);
    },
});

export default gitCommand;
