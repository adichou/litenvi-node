// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-http：node:http 与 node:https 的可切换门面（客户端面：request/get 与 httpsRequest/
// httpsGet）。默认（未设置内存实现）原样转发真实 node:http / node:https，生产行为不变。
// t_mock() 设置内存实现（幂等：已设置时复用当前实例）、t_unmock() 移除（规则随实例丢弃）。
// https 面：未 mock 原样转发 node:https（对象形态 options 缺省补 protocol 'https:'，与原生
// 语义一致——显式给出的 protocol 优先）；mock 后走同一内存传输，协议标记进入匹配 URL 与
// 端口缺省（443），故障注入与 loopback 路由同口径——内存世界不真实外联。
// 内存实现不触网：经包内 i-http-transport 分派到服务端登记的真实 handler；客户端事件与
// 响应流仍由本门面适配，服务登记与响应阶段故障归 lite-server。传输层故障（inject）按
// url/method/path（字符串精确或正则）/query 匹配——请求未达 handler 即被拦截应答错误，wait 闸门
// 挂起请求放行后继续，once 命中即自毁；端口无监听内存服务按 ECONNREFUSED 拒连。状态为模块
// 级单例：同进程内经同一 specifier 导入（含动态 import）共享。
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { urlToHttpOptions } from 'node:url';
import { i_requestContext, i_openClient, i_closeClient } from './i-http-transport.mjs';

// 内存 http 实现：回调式 request/get 经共用管线取得响应，适配客户端事件与流。
// req 形状对齐真实 ClientRequest 的常用消费面（on('error')/on('response')/end/
// destroy）；res 形状对齐 IncomingMessage（statusCode / headers / data / end 事件 + faulted
// 标记）。
// 私有方法：创建内存 HTTP 客户端；仅在本文件实现中使用，不导出。
function f_createMemoryHttp() {
    const transport = i_openClient();

    // 私有方法：仅在本文件实现中使用，不导出。
    function f_request(options, extra, callback) {
        if (typeof extra === 'function') { callback = extra; extra = undefined; }
        const config = typeof options === 'string' || options instanceof URL
            ? { ...urlToHttpOptions(new URL(options)), ...extra } : (options || {});
        const context = i_requestContext(config);
        const req = new EventEmitter();
        const chunks = [];
        let ended = false, aborted = false, closed = false;
        req.destroyed = false;
        req.writableEnded = false;
        if (callback) req.once('response', callback);
        // 私有方法：关闭当前请求；仅在本文件实现中使用，不导出。
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
            const pending = transport.i_dispatch({ ...context, payload: Buffer.concat(chunks), isAborted: () => aborted });
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
                        res.end(text);
                    });
                });
            }
            // 共用管线拒绝时按请求错误上抛；取消后的响应与错误均不再投递。
            pending.then(response => {
                if (response) f_deliverResponse(response.status, response.headers, response.body, response.faulted);
            }).catch(error => { if (!aborted) { req.emit('error', error); f_close(); } });
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
        inject(fault) { return transport.i_inject(fault); },
    };
}

let f_memory = null; // 未设置 → 默认实现（真实 node:http）

const liteHttp = {
    // 外部方法：允许所有调用方使用，包括测试文件。
    request(...args) { return f_memory ? f_memory.request(...args) : http.request(...args); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    get(...args) { return f_memory ? f_memory.get(...args) : http.get(...args); },
    // https 客户端面：未 mock 原样转发 node:https（对象形态缺省补 protocol，URL/string 形态
    // 自带协议）；mock 后走同一内存传输——协议标记由 options 携带进入匹配与端口缺省。
    // 外部方法：允许所有调用方使用，包括测试文件。
    httpsRequest(...args) {
        const [first, ...rest] = args;
        const normalized = first && typeof first === 'object' && !(first instanceof URL) ? { protocol: 'https:', ...first } : first;
        return f_memory ? f_memory.request(normalized, ...rest) : https.request(...args);
    },
    // 外部方法：允许所有调用方使用，包括测试文件。
    httpsGet(...args) {
        const [first, ...rest] = args;
        const normalized = first && typeof first === 'object' && !(first instanceof URL) ? { protocol: 'https:', ...first } : first;
        return f_memory ? f_memory.get(normalized, ...rest) : https.get(...args);
    },
    // 设置内存 http 实现；返回公共门面，不暴露私有实现
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_mock() { f_memory ??= f_createMemoryHttp(); return liteHttp; },
    // 移除内存实现，回到真实 node:http；注入规则随实例一并丢弃
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_unmock() { f_memory = null; i_closeClient(); },
    // 内存实现是否已设置。
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
