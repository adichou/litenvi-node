// lite-server：node:http 服务端面（createServer）的门面，机制与 lite-fs / lite-child_process 一致
//——lite-http 只承载客户端（request/get + 传输层故障），本门面承载服务端。默认（未 mock）
// 原样转发真实 http.createServer，生产行为不变。mock() 换内存实现：登记唯一内存服务，
// listen 真实绑定 127.0.0.1（显式端口即绑该口，缺省 listen(0) 取动态空闲口）——浏览器等真实
// 客户端经真实 loopback socket 到达 socket 前端；前端把每个到达的请求回灌进程内管线：
// liteHttp.request（内存客户端，传输层故障对浏览器流量同样生效）→ handle()（服务端故障）
// → 真实 handler，回包写回真实 socket——真实 socket 流量与进程内直调共用同一故障/观测
// 管线（观测账本也记在前端，契约沿旧 lite-browser route 账本）。进程内直调 liteHttp.request
// 仍走 handle() 内存路径，不经 socket。inject 注入服务端故障：handler 已执行，回包被 wait
// 闸门挂起或按 status 错误回包替换——与 lite-http.inject（请求未达 handler 即被传输层拦截）
// 分层归属，phase 不再需要：注入入口本身即阶段。状态为模块级单例：同进程内经同一 specifier
// 导入（含动态 import）共享。
import http from 'node:http';
import { EventEmitter } from 'node:events';
import liteHttp from './lite-http.mjs';

function createMemoryServer() {
    const faults = [];
    const forwarded = []; // socket 前端观测账本：{ method, path, query, body, status, response, serverResponse }
    let server = null; // 内存服务：{ handler, listening, port }
    let httpServer = null; // 真实 socket 载体（node:http 绑 127.0.0.1）；未 listen → null

    // 服务端故障匹配面：method + path（字符串精确或正则）+ query（键值逐项比对搜索串）
    const matches = (fault, method, path, search) => (!fault.method || String(fault.method).toUpperCase() === method)
        && (!fault.path || (fault.path instanceof RegExp ? fault.path.test(path) : fault.path === path))
        && (!fault.query || Object.entries(fault.query).every(([key, value]) => new URLSearchParams(search).get(key) === String(value)));

    // 单次请求的完整服务端处理：合成 req/res → 真实 handler → 回包过服务端故障（wait 挂起、
    // status 替换）。isAborted 供客户端 destroy 联动取消（闸门放行后不再投递）。
    function handle(port, { method, raw, payload, headers: requestHeaders = {}, isAborted }) {
        return new Promise((resolve, reject) => {
            if (!server?.listening || port !== server.port) {
                resolve(null); // 无内存服务：客户端按 ECONNREFUSED 拒连
                return;
            }
            const at = raw.indexOf('?');
            const target = at === -1 ? raw : raw.slice(0, at);
            const search = at === -1 ? '' : raw.slice(at);
            const matched = faults.filter(rule => matches(rule, method, target, search));
            for (const fault of matched)
                if (fault.once) { // once：命中即自毁（跨用例不泄漏；闸门期间到达的后续请求不再被拦）
                    const i = faults.indexOf(fault);
                    if (i !== -1)
                        faults.splice(i, 1);
                }
            const faultBody = (fault) => JSON.stringify(fault.body ?? { error: fault.error || `注入的 HTTP ${fault.status} 错误` });
            // 合成服务端 req/res，交给真实 handler——回包来自真实路由代码
            const serverReq = new EventEmitter();
            serverReq.method = method;
            serverReq.url = raw;
            serverReq.headers = { host: `127.0.0.1:${port}`, ...Object.fromEntries(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value])) };
            serverReq.socket = { remoteAddress: '127.0.0.1' };
            const serverRes = new EventEmitter();
            serverRes.statusCode = 200;
            serverRes.headers = {};
            serverRes.setHeader = (name, value) => { serverRes.headers[String(name).toLowerCase()] = value; return serverRes; };
            serverRes.getHeader = name => serverRes.headers[String(name).toLowerCase()];
            serverRes.writeHead = (code, message, headers) => {
                serverRes.statusCode = code;
                for (const [name, value] of Object.entries((typeof message === 'string' ? headers : message) || {})) serverRes.setHeader(name, value);
                return serverRes;
            };
            const chunks = [];
            let finished = false;
            serverRes.write = (chunk, encoding) => { chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding)); return true; };
            serverRes.end = (chunk) => {
                if (chunk != null && chunk !== undefined)
                    serverRes.write(chunk);
                if (finished)
                    return serverRes;
                finished = true;
                // 真实回包先落袋，过服务端故障闸门串（wait 挂起、带状态替换回包）再交还客户端
                const settle = async () => {
                    let status = serverRes.statusCode, headers = serverRes.headers, text = Buffer.concat(chunks), faulted = false;
                    for (const fault of matched) {
                        if (fault.wait instanceof Promise)
                            await fault.wait;
                        if (isAborted())
                            return;
                        if (fault.status !== undefined) {
                            status = fault.status;
                            headers = { 'content-type': 'application/json' };
                            text = faultBody(fault);
                            faulted = true;
                        }
                    }
                    resolve({ status, headers, body: method === 'HEAD' || status === 204 || status === 304 ? Buffer.alloc(0) : text, faulted });
                };
                settle().catch(reject); // 闸门失败按请求错误上抛（客户端 error 路径），不静默吞掉
                return serverRes;
            };
            // 请求体缓冲语义（对齐真实流：data 事件在首个监听挂上后才流动）——payload 先存，
            // 等 handler 侧首个 data/end 监听（newListener）挂上再投递；空请求体同样补发 end，
            // 否则只读流的 handler 永远收不到结束
            let pendingBody = payload, bodyScheduled = false;
            serverReq.on('newListener', (event) => {
                if ((event !== 'data' && event !== 'end') || bodyScheduled)
                    return;
                bodyScheduled = true;
                queueMicrotask(() => {
                    if (pendingBody)
                        serverReq.emit('data', Buffer.from(pendingBody)); // 对齐真实流：data 载荷是 Buffer
                    serverReq.emit('end');
                });
            });
            const handled = server.handler(serverReq, serverRes);
            Promise.resolve(handled)
                    .catch(error => {
                        if (!finished) {
                            serverRes.statusCode = 500;
                            serverRes.end(JSON.stringify({ error: String(error?.message || error) }));
                        }
                    });
        });
    }

    // socket 前端回写头：静态资源缓存覆盖（逻辑与理由自旧 lite-browser 迁移）——服务端静态
    // 回包恒带 no-store，共享页逐例导航会全量重拉；/api/ 保持禁缓存——故障注入（once 挂起/
    // 替换）与轮询语义都依赖新鲜回包，禁止任何缓存。头名按小写比对替换，避免与原头大小写
    // 并存成对；回写体已是解码全量文本，content-length 按字节重算（多字节正文不受字符数误导）
    function deliverHeaders(path, headers, body) {
        const out = {};
        let keepCache = false;
        for (const [name, value] of Object.entries(headers || {})) {
            const key = String(name).toLowerCase();
            if (key === 'content-length')
                continue;
            if (key === 'cache-control') {
                if (path.startsWith('/api/')) { out['cache-control'] = 'no-store'; keepCache = true; } // API 强制 no-store（见下）
                continue; // 非 /api/：丢弃 no-store，下方统一覆盖
            }
            out[name] = value;
        }
        if (!keepCache && !path.startsWith('/api/'))
            out['cache-control'] = 'public, max-age=3600';
        else if (path.startsWith('/api/'))
            out['cache-control'] = 'no-store'; // 服务端 API 回包本无 cache-control——缺省时 Chromium 会尝试
        // 写缓存并持该 URL 的写锁，同 URL 的后续请求在锁上排队（闸门挂住 #1 时 #2 全程滞留）；no-store 跳过缓存即无锁
        out['content-length'] = String(Buffer.byteLength(body || ''));
        return out;
    }

    // socket 前端：真实到达的请求（method/url/body 收全后）→ 组装观测记录 → liteHttp.request
    // 回灌进程内管线 → 回包写回真实 socket → 回填记录。记录在收到时创建（闸门挂起期间可
    // 计数）、完成时回填 status/response；socket 中断（客户端弃连）对应 isAborted——联动
    // destroy 内存请求，放行后不投递，记录停在 status 0（对齐旧 route.abort 观测）。
    function frontend(realReq, realRes) {
        const chunks = [];
        let aborted = false, client = null; // client：lite-http 内存请求句柄
        const done = () => { aborted = true; client?.destroy?.(); };
        realReq.on('aborted', done); // 客户端中途弃连（请求体未收全）
        realRes.on('close', () => { if (!realRes.writableEnded) done(); }); // 回写完成前连接断开
        realReq.on('data', (chunk) => chunks.push(chunk));
        realReq.on('end', () => {
            const raw = String(realReq.url);
            const at = raw.indexOf('?');
            // 观测记录对齐旧 lite-browser 账本契约：path 不含查询串（query 单列）、body 为请求体
            // 文本；response=最终送达回包（故障或真实），serverResponse 仅真实路由产物
            const rec = {
                method: realReq.method,
                path: at === -1 ? raw : raw.slice(0, at),
                query: at === -1 ? '' : raw.slice(at),
                body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
                status: 0,
            };
            forwarded.push(rec);
            if (!liteHttp.isMocked()) { // 防误用：未 mock 的 liteHttp.request 会真实外联（回环自环）
                const error = JSON.stringify({ error: 'lite-server socket 前端需先 liteHttp.mock()：回灌管线走内存客户端，未 mock 会真实外联' });
                realRes.writeHead(500, { 'content-type': 'application/json' });
                realRes.end(error);
                rec.status = 500;
                return;
            }
            (async () => {
                try {
                    const res = await new Promise((resolve, reject) => {
                        client = liteHttp.request({ hostname: '127.0.0.1', port: server.port, path: raw, method: realReq.method, headers: realReq.headers }, (r) => {
                            const out = [];
                            r.on('data', (chunk) => out.push(chunk));
                            r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(out), faulted: r.faulted === true }));
                        });
                        client.on('error', reject);
                        if (chunks.length) client.write(Buffer.concat(chunks));
                        client.end();
                    });
                    if (aborted)
                        return; // 客户端已弃连：回包丢弃（连接已断，无从送达）
                    // connection:close——每请求独立连接：Chromium 会把后续同源请求排在挂起响应的
                    // keep-alive 连接后面（H1 队头阻塞，实测闸门挂住 #1 时 #2 全程滞留浏览器侧），
                    // 旧 CDP 路由为独立虚拟通道无此问题；回环建连开销可忽略，按请求关停对齐该语义
                    realRes.writeHead(res.status, { ...deliverHeaders(rec.path, res.headers, res.body), connection: 'close' });
                    realRes.end(res.body);
                    rec.status = res.status;
                    let json = null, text = undefined;
                    if (res.body.length) {
                        try { json = JSON.parse(res.body.toString('utf8')); } catch { text = res.body.toString('utf8'); }
                    }
                    rec.response = { status: res.status, json, headers: res.headers, ...(text !== undefined ? { text } : {}) };
                    if (!res.faulted) rec.serverResponse = rec.response;
                } catch {
                    realRes.destroy(); // 管线异常（拒连/闸门失败等）：对齐旧 route.abort——账本停在 status 0
                }
            })();
        });
    }

    return {
        handle,
        listening(port) { return !!server?.listening && port === server.port; },
        createServer(handler) {
            server = Object.assign(new EventEmitter(), {
                handler, listening: false, port: null,
                address() { return httpServer?.address() ?? null; },
                listen(portArg, host, ready) {
                    const callback = typeof host === 'function' ? host : ready;
                    if (callback) this.once('listening', callback);
                    const want = Number(portArg);
                    httpServer = http.createServer(frontend);
                    httpServer.on('error', error => this.emit('error', error));
                    httpServer.listen(Number.isFinite(want) ? want : 0, '127.0.0.1', () => {
                        this.port = httpServer.address().port;
                        this.listening = true;
                        this.emit('listening');
                    });
                    return this;
                },
                close(callback) {
                    this.listening = false;
                    if (callback) this.once('close', callback);
                    if (httpServer) {
                        httpServer.closeIdleConnections?.();
                        httpServer.close(() => this.emit('close'));
                    } else queueMicrotask(() => this.emit('close', Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
                    return this;
                },
            });
            return server;
        },
        inject(fault) {
            const hasStatus = Number.isInteger(fault?.status) && fault.status >= 400 && fault.status <= 599;
            const hasWait = fault?.wait instanceof Promise;
            if (!hasStatus && !hasWait)
                throw new Error('lite-server 注入仅允许错误状态 400–599 或 wait 闸门（不允许成功回包替换）');
            for (const key of Object.keys(fault))
                if (!['method', 'path', 'query', 'status', 'body', 'error', 'wait', 'once'].includes(key))
                    throw new Error(`lite-server 注入不支持字段：${key}`);
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
        // 实际绑定端口（未 listen → null）：动态端口世界由调用方从这里取源推 origin
        port() { return server?.port ?? null; },
        // socket 前端观测账本（旧 lite-browser 账本等价 API）：requests 快照 / liveRequests
        // 活账本（同一数组实例随请求实时增长，resetRequests 原地清空不换引用）
        requests() { return [...forwarded]; },
        liveRequests() { return forwarded; },
        resetRequests() { forwarded.length = 0; },
        // 真实关停 socket 载体（活跃连接一并断开——mock 拆除口径，非优雅关停）
        dispose() {
            if (!httpServer) return;
            httpServer.closeIdleConnections?.();
            httpServer.closeAllConnections?.();
            httpServer.close();
            httpServer = null;
        },
    };
}

let memory = null; // 未设置 → 默认实现（真实 http.createServer）

const liteServer = {
    // 服务端唯一入口：真实分支透传 http.createServer；内存分支登记内存服务
    createServer(...args) { return memory ? memory.createServer(...args) : http.createServer(...args); },
    // 设置内存实现；返回该实现（一般无须直接持有）
    mock() { return memory ?? (memory = createMemoryServer()); },
    // 移除内存实现，回到真实 createServer；服务登记、故障与真实 socket 随实例一并关停丢弃
    unmock() { if (memory) { memory.dispose(); memory = null; } },
    // 门面间内部通道：lite-http 内存客户端（及 socket 前端回灌的请求）按端口路由进来。返回回包
    // { status, headers, body, faulted }；未 mock 或该端口无监听内存服务返回 null（客户端按
    // ECONNREFUSED 拒连——未 mock 即无内存服务，与真实世界无监听同语义）
    handle(port, ctx) {
        return memory ? memory.handle(port, ctx) : Promise.resolve(null);
    },
    // 端口是否有监听中的内存服务（未 mock 恒 false）
    listening(port) {
        return memory ? memory.listening(port) : false;
    },
    // 实际绑定端口（未 mock / 未 listen 为 null）
    port() { return memory ? memory.port() : null; },
    // 向内存服务注入服务端故障（handler 已执行后回包阶段）；须先 mock()，返回移除函数
    inject(fault) {
        if (!memory)
            throw new Error('lite-server.inject 需先 mock() 设置内存实现');
        return memory.inject(fault);
    },
    // socket 前端观测账本快照：{ method, path, query, body, status, response, serverResponse }；
    // 未 mock 时空集
    requests() { return memory ? memory.requests() : []; },
    // 活账本：同一数组实例随请求实时增长（resetRequests 原地清空不换引用）——轮询观测用
    liveRequests() { return memory ? memory.liveRequests() : []; },
    resetRequests() { if (memory) memory.resetRequests(); },
};

export default liteServer;
