// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-http：node:http 的可切换门面（客户端面：request/get）。默认（未设置内存实现）原样
// 转发真实 node:http，生产行为不变。t_mock() 设置内存实现（幂等：已设置时复用当前实例）、
// t_unmock() 移除（规则随实例丢弃）。
// 内存实现不触网：对同端口的 loopback 请求经 lite-server 门面路由到真实 handler（拿到真实
// 路由代码的正确回包；服务端登记与响应阶段故障归 lite-server）；传输层故障（inject）按
// url/method/path（字符串精确或正则）/query 匹配——请求未达 handler 即被拦截应答错误，wait 闸门
// 挂起请求放行后继续，once 命中即自毁；端口无监听内存服务按 ECONNREFUSED 拒连。状态为模块
// 级单例：同进程内经同一 specifier 导入（含动态 import）共享。
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { urlToHttpOptions } from 'node:url';
import liteServer from './lite-server.mjs';

// URL 规则在登记时规范化：路径 URL 不限来源，绝对 URL 额外匹配来源；fragment 不参与 HTTP 请求。
// 私有方法：仅在本文件实现中使用，不导出。
function f_normalizeFaultUrl(value) {
    if (!(typeof value === 'string' || value instanceof URL))
        throw new Error('inject 的 url 必须是绝对 HTTP URL 或以 / 开头的路径 URL');
    const text = String(value);
    const relative = text.startsWith('/') && !text.startsWith('//');
    let url;
    try { url = relative ? new URL(text, 'http://lite.invalid') : new URL(text); }
    catch { throw new Error('inject 的 url 必须是绝对 HTTP URL 或以 / 开头的路径 URL'); }
    if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('inject 的 url 仅支持 HTTP URL');
    return `${relative ? '' : url.origin}${url.pathname}${url.search}`;
}

// 内存 http 实现：回调式 request/get 按传输层注入规则应答错误、经 lite-server 路由真实
// handler。req 形状对齐真实 ClientRequest 的常用消费面（on('error')/on('response')/end/
// destroy）；res 形状对齐 IncomingMessage（statusCode / headers / data / end 事件 + faulted
// 标记）。
// 私有方法：创建内存 HTTP 客户端；仅在本文件实现中使用，不导出。
function f_createMemoryHttp() {
    const faults = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_matches = (fault, method, path, search, url) => (fault.url === undefined || fault.url === (fault.url.startsWith('/') ? url.pathname + url.search : url.origin + url.pathname + url.search))
        && (!fault.method || String(fault.method).toUpperCase() === method)
        && (!fault.path || (fault.path instanceof RegExp ? fault.path.test(path) : fault.path === path))
        && (!fault.query || Object.entries(fault.query).every(([key, value]) => new URLSearchParams(search).get(key) === String(value)));

    // 私有方法：仅在本文件实现中使用，不导出。
    function f_request(options, extra, callback) {
        if (typeof extra === 'function') { callback = extra; extra = undefined; }
        const config = typeof options === 'string' || options instanceof URL
            ? { ...urlToHttpOptions(new URL(options)), ...extra } : (options || {});
        const method = String(config.method || 'GET').toUpperCase();
        const raw = String((config instanceof URL ? config.pathname + config.search : config.path) || '/');
        const at = raw.indexOf('?');
        const target = at === -1 ? raw : raw.slice(0, at);
        const search = at === -1 ? '' : raw.slice(at);
        const port = Number(config.port) || (config.protocol === 'https:' ? 443 : 80);
        // Host 是请求的公开来源；socket 前端回灌仍连回环端口，但保留原始 Host。
        // 私有方法：仅在本文件实现中使用，不导出。
        const host = Object.entries(config.headers || {}).find(([name]) => name.toLowerCase() === 'host')?.[1];
        const hostname = config.hostname || config.host || 'localhost';
        const authority = host || `${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${port}`;
        const url = new URL(raw, `${config.protocol || 'http:'}//${authority}`);
        const req = new EventEmitter();
        const chunks = [];
        let ended = false, aborted = false, closed = false;
        req.destroyed = false;
        req.writableEnded = false;
        if (callback) req.once('response', callback);
        // 私有方法：关闭共享浏览器；仅在本文件实现中使用，不导出。
        const f_close = () => { if (!closed) { closed = true; req.destroyed = true; req.emit('close'); } };
        // 私有方法：仅在本文件实现中使用，不导出。
        const f_bytes = (chunk, encoding) => Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
        req.write = (chunk, encoding, done) => {
            chunks.push(f_bytes(chunk, typeof encoding === 'string' ? encoding : undefined));
            const callback = typeof encoding === 'function' ? encoding : done;
            if (callback) queueMicrotask(callback);
            return true;
        };
        req.end = (body, encoding, done) => {
            if (ended) return req;
            if (typeof body === 'function') { done = body; body = undefined; }
            if (body !== undefined && body !== null) chunks.push(f_bytes(body, typeof encoding === 'string' ? encoding : undefined));
            ended = req.writableEnded = true;
            queueMicrotask(() => { req.emit('finish'); (typeof encoding === 'function' ? encoding : done)?.(); });
            const payload = Buffer.concat(chunks);
            // 故障匹配面：url + method + path（字符串精确 / 正则）+ query（键值逐项比对搜索串）。
            // once：命中即自毁（跨用例不泄漏；wait 闸门期间到达的后续请求不再被拦）。
            // 私有方法：仅在本文件实现中使用，不导出。
            const matched = faults.filter(rule => f_matches(rule, method, target, search, url));
            for (const fault of matched)
                if (fault.once) {
                    const i = faults.indexOf(fault);
                    if (i !== -1)
                        faults.splice(i, 1);
                }
            // 私有方法：仅在本文件实现中使用，不导出。
            const f_faultBody = (fault) => JSON.stringify(fault.body ?? { error: fault.error || `注入的 HTTP ${fault.status} 错误` });
            // 闸门串：传输层故障先行（请求未达服务端：带状态即注入错误回包、纯 wait 放行后继续）
            // → 经 lite-server 路由真实 handler（服务端故障在服务端回包阶段归属处理）
            // 私有方法：仅在本文件实现中使用，不导出。
            const f_route = async () => {
                for (const fault of matched) {
                    if (fault.wait instanceof Promise)
                        await fault.wait;
                    if (aborted)
                        return;
                    if (fault.status !== undefined) {
                        f_deliverResponse(fault.status, { 'content-type': 'application/json' }, f_faultBody(fault), true);
                        return;
                    }
                }
                if (aborted)
                    return;
                // 私有方法：仅在本文件实现中使用，不导出。
                const response = await liteServer.pkg_handle(port, { method, raw, url, hostname, payload, headers: config.headers, isAborted: () => aborted });
                if (response === null) {
                    req.emit('error', Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port }));
                    f_close();
                    return;
                }
                f_deliverResponse(response.status, response.headers, response.body, response.faulted);
            };
            // 私有方法：仅在本文件实现中使用，不导出。
            function f_deliverResponse(status, headers, text, faulted = false) {
                queueMicrotask(() => {
                    if (aborted)
                        return;
                    const res = new PassThrough();
                    res.statusCode = status;
                    res.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
                    res.statusMessage = http.STATUS_CODES[status];
                    res.complete = false;
                    res.faulted = faulted; // 故障回包标记：观测面据此区分真实路由产物与注入回包
                    res.once('end', () => { res.complete = true; queueMicrotask(f_close); });
                    req.emit('response', res);
                    queueMicrotask(() => {
                        res.end(method === 'HEAD' || status === 204 || status === 304 ? undefined : Buffer.from(text));
                    });
                });
            }
            // wait 闸门串是 async：拒绝（闸门 promise 失败）按请求错误上抛，不静默吞掉
            // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
            queueMicrotask(() => { f_route().catch(error => { if (!aborted) { req.emit('error', error); f_close(); } }); });
            return req;
        };
        req.destroy = error => {
            if (aborted) return req;
            aborted = req.destroyed = true;
            queueMicrotask(() => { if (error) req.emit('error', error); f_close(); });
            return req;
        };
        return req;
    }

    return {
        request: f_request,
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        get(...args) {
            const req = f_request(...args);
            req.end(); // 原生 get 只自动 end，仍保留显式 method。
            return req;
        },
        // 私有实现：由本文件的公共门面或执行层分派，不单独导出。
        inject(fault) {
            const hasStatus = Number.isInteger(fault?.status) && fault.status >= 400 && fault.status <= 599;
            const hasWait = fault?.wait instanceof Promise;
            if (!hasStatus && !hasWait)
                throw new Error('lite-http 注入仅允许错误状态 400–599 或 wait 闸门（不允许成功回包替换）');
            for (const key of Object.keys(fault))
                if (!['url', 'method', 'path', 'query', 'status', 'body', 'error', 'wait', 'once'].includes(key))
                    throw new Error(`lite-http 注入不支持字段：${key}（服务端回包阶段故障经 lite-server.t_inject 注入）`);
            if (fault.url !== undefined) fault = { ...fault, url: f_normalizeFaultUrl(fault.url) };
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
    };
}

let f_memory = null; // 未设置 → 默认实现（真实 node:http）

const liteHttp = {
    // 外部方法：允许所有调用方使用，包括测试文件。
    request(...args) { return f_memory ? f_memory.request(...args) : http.request(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    get(...args) { return f_memory ? f_memory.get(...args) : http.get(...args); },
    // 设置内存 http 实现；返回公共门面，不暴露私有实现
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_mock() { f_memory ??= f_createMemoryHttp(); return liteHttp; },
    // 移除内存实现，回到真实 node:http；注入规则随实例一并丢弃
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_unmock() { f_memory = null; },
    // 内存实现是否已设置——lite-server socket 前端等回灌方据此防误用（未 mock 的
    // request 会真实外联，回环请求会自成环路）
    // 外部方法：允许所有调用方使用，包括测试文件。
    isMocked() { return f_memory !== null; },
    // 向内存实现注入错误规则；须先 t_mock()，返回移除函数
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_inject(fault) {
        if (!f_memory)
            throw new Error('lite-http.t_inject 需先 t_mock() 设置内存 http 实现');
        return f_memory.inject(fault);
    },
};

export default liteHttp;
