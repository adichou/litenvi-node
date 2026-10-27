// 服务器模式的内存 HTTP 通道：真实路由处理请求，替身只覆盖流与传输故障。
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
const BASE = 'http://mock-environment.local';
const namedError = (name, message) => Object.assign(new Error(message), { name });
// 响应头兼容读取与迭代；保留既有 request/fetch 回包的对象展开能力。
export class ResponseHeaders {
    #values = new Map();
    constructor(init = {}) {
        const entries = typeof init[Symbol.iterator] === 'function' ? init : Object.entries(init);
        for (const [name, value] of entries)
            this.#values.set(String(name).toLowerCase(), String(value));
        for (const [name, value] of this.#values) {
            if (!['get', 'has', 'entries', 'constructor'].includes(name)) {
                Object.defineProperty(this, name, { value, enumerable: true });
            }
        }
    }
    get(name) { return this.#values.get(String(name).toLowerCase()) ?? null; }
    has(name) { return this.#values.has(String(name).toLowerCase()); }
    entries() { return this.#values.entries(); }
    [Symbol.iterator]() { return this.entries(); }
}
export function createHttpTransport({ deny, clock, onSettle, onObserve }) {
    const requests = [], faults = [], pending = new Set();
    let server = null, disposed = false;
    const httpMock = {
        request: deny('http.request'), get: deny('http.get'),
        createServer(handler) {
            if (server)
                return deny('额外 HTTP 服务')();
            server = Object.assign(new EventEmitter(), {
                listening: false, handler,
                listen(_port, _host, ready) { this.listening = true; if (ready)
                    queueMicrotask(ready); queueMicrotask(() => this.emit('listening')); return this; },
                close(cb) { const active = this.listening; this.listening = false; if (cb)
                    queueMicrotask(() => cb(active ? null : Object.assign(new Error('ERR_SERVER_NOT_RUNNING'), { code: 'ERR_SERVER_NOT_RUNNING' }))); queueMicrotask(() => this.emit('close')); return this; },
            });
            return server;
        },
    };
    function injectFault(config) {
        if (config.status != null && (!Number.isInteger(config.status) || config.status < 400 || config.status > 599))
            throw new Error('HTTP 故障仅允许错误状态 400–599');
        if (config.body != null && config.status == null)
            throw new Error('响应错误正文必须指定错误状态');
        for (const key of Object.keys(config))
            if (!['path', 'method', 'phase', 'disconnect', 'error', 'status', 'body', 'wait', 'delayMs', 'once', 'query'].includes(key))
                throw new Error(`不支持的 HTTP 故障字段：${key}`);
        if (config.phase && !['request', 'response'].includes(config.phase))
            throw new Error('HTTP 故障阶段只能为 request 或 response');
        if (config.delayMs != null && (!Number.isFinite(config.delayMs) || config.delayMs < 0))
            throw new Error('HTTP 延迟必须是非负有限毫秒数');
        const fault = { phase: 'request', ...config, active: true };
        faults.push(fault);
        return () => { fault.active = false; };
    }
    function matching(request) {
        return faults.filter(f => f.active && (!f.method || f.method.toUpperCase() === request.method) && (!f.path || (f.path instanceof RegExp ? f.path.test(request.path) : f.path === request.path)) && (!f.query || Object.entries(f.query).every(([key, value]) => new URLSearchParams(request.query).get(key) === String(value))));
    }
    function request(method, pathname, body, options = {}) {
        if (disposed)
            return Promise.reject(new Error('Mock 环境已释放'));
        if (!server?.listening)
            return Promise.reject(new Error('主入口必须启动 HTTP 服务'));
        const url = new URL(pathname, BASE), record = { method: String(method).toUpperCase(), path: url.pathname, query: url.search, body, signal: options.signal, source: options.source || 'request', dispatched: false };
        requests.push(record); onObserve?.();
        const selected = matching(record);
        for (const fault of selected)
            if (fault.once)
                fault.active = false;
        return new Promise((resolve, reject) => {
            let settled = false, req, res;
            const timers = new Set(), signal = options.signal;
            const clear = () => { for (const timer of timers)
                clock.clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(cancel); };
            const finish = (fn, value) => { if (settled)
                return; settled = true; clear(); fn(value); onSettle?.(); };
            const cancel = () => { finish(reject, namedError('AbortError', '环境释放，请求取消')); req?.destroy(); res?.destroy(); };
            const abort = () => { finish(reject, signal.reason || namedError('AbortError', '请求取消')); req?.destroy(); res?.destroy(); };
            pending.add(cancel);
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort, { once: true });
            if (options.timeoutMs !== null) {
                const timeout = clock.setTimeout(() => finish(reject, namedError('TimeoutError', 'Mock 环境请求超时')), options.timeoutMs ?? 5000);
                timers.add(timeout);
            }
            const wait = async (fault) => {
                if (fault.delayMs) {
                    await new Promise(r => { const timer = clock.setTimeout(r, fault.delayMs); timers.add(timer); });
                }
                if (fault.wait)
                    await fault.wait;
                if (settled)
                    return false;
                if (fault.disconnect)
                    throw new Error('注入的 HTTP 断连');
                if (fault.error && !fault.status)
                    throw fault.error instanceof Error ? fault.error : new Error(String(fault.error));
                return true;
            };
            const errorResponse = fault => ({ status: fault.status, json: fault.body ?? { error: fault.error || '注入的 HTTP 错误' }, headers: { 'content-type': 'application/json' }, text: undefined });
            const dispatch = () => new Promise((ok, fail) => {
                req = new Duplex({ read() { } });
                req.method = record.method;
                req.url = `${url.pathname}${url.search}`;
                req.headers = { host: '127.0.0.1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
                req.socket = { remoteAddress: '127.0.0.1', remotePort: 0 };
                res = new Duplex({ read() { }, write(chunk, _enc, cb) { res.push(chunk); cb(); }, final(cb) { res.push(null); cb(); } });
                res.statusCode = 200;
                res.headers = {};
                res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res; };
                res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
                let text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { text += chunk; });
                res.on('error', fail);
                req.on('error', fail);
                res.on('end', () => { let json = null; try {
                    json = JSON.parse(text);
                }
                catch { } if (json === null && !text.trim()) {
                    fail(new Error('接口未返回 JSON：（空响应）'));
                    return;
                } const response = { status: res.statusCode, json, headers: res.headers, text: json === null ? text : undefined }; record.serverResponse = response; ok(response); });
                queueMicrotask(() => { if (body !== undefined)
                    req.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.push(null); });
                record.dispatched = true;
                try {
                    Promise.resolve(server.handler(req, res)).catch(fail);
                }
                catch (error) {
                    fail(error);
                }
            });
            (async () => {
                for (const fault of selected.filter(f => f.phase === 'request')) {
                    if (!await wait(fault))
                        return;
                    if (fault.status) {
                        record.response = errorResponse(fault);
                        finish(resolve, record.response);
                        return;
                    }
                }
                let response = await dispatch();
                for (const fault of selected.filter(f => f.phase === 'response')) {
                    if (!await wait(fault))
                        return;
                    if (fault.status)
                        response = errorResponse(fault);
                }
                record.response = response;
                finish(resolve, response);
            })().catch(error => finish(reject, error));
        });
    }
    function fetchMock(input, init = {}) {
        const url = String(input);
        if (!url.startsWith('/'))
            return deny('fetch 同源外地址')(url);
        const method = String(init.method || 'GET').toUpperCase();
        let body = init.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            }
            catch { }
        }
        return request(method, url, body, { signal: init.signal, source: 'fetch', timeoutMs: init.signal ? null : 5000 }).then(response => ({
            ok: response.status >= 200 && response.status < 300, status: response.status, statusText: response.status === 404 ? 'Not Found' : '', headers: new ResponseHeaders(response.headers),
            json: async () => { if (response.json !== null)
                return response.json; throw new SyntaxError(`Unexpected token in JSON（非 JSON 响应：${String(response.text).slice(0, 40)}）`); },
            text: async () => response.text !== undefined ? response.text : JSON.stringify(response.json),
        }));
    }
    return {
        httpMock, request, requests, fetch: fetchMock, injectFault, pendingCount: () => pending.size, isListening: () => !!server?.listening,
        waitForListening() { return server?.listening ? Promise.resolve() : Promise.reject(new Error('主入口必须启动 HTTP 服务')); },
        async close() { disposed = true; for (const cancel of [...pending])
            cancel(); if (server?.listening)
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server?.removeAllListeners(); },
    };
}
