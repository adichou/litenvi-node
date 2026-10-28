// lite-server：node:http 服务端面（createServer）的门面，机制与 lite-fs / lite-spawn 一致
//——lite-http 只承载客户端（request/get + 传输层故障），本门面承载服务端。默认（未 mock）
// 原样转发真实 http.createServer，生产行为不变。mock() 换内存实现：登记唯一内存服务
//（listen 只记端口，不绑真实端口、不监听 socket）；lite-http 内存客户端对同端口的 loopback
// 请求经 handle() 进入本服务——合成服务端 req/res 交给真实 handler，回包即真实路由代码产物。
// inject 注入服务端故障：handler 已执行，回包被 wait 闸门挂起或按 status 错误回包替换——
// 与 lite-http.inject（请求未达 handler 即被传输层拦截）分层归属，phase 不再需要：注入入口
// 本身即阶段。状态为模块级单例：同进程内经同一 specifier 导入（含动态 import）共享。
import http from 'node:http';
import { EventEmitter } from 'node:events';

function createMemoryServer() {
    const faults = [];
    let server = null; // 内存服务：{ handler, listening, port }

    // 服务端故障匹配面：method + path（字符串精确或正则）+ query（键值逐项比对搜索串）
    const matches = (fault, method, path, search) => (!fault.method || String(fault.method).toUpperCase() === method)
        && (!fault.path || (fault.path instanceof RegExp ? fault.path.test(path) : fault.path === path))
        && (!fault.query || Object.entries(fault.query).every(([key, value]) => new URLSearchParams(search).get(key) === String(value)));

    // 单次请求的完整服务端处理：合成 req/res → 真实 handler → 回包过服务端故障（wait 挂起、
    // status 替换）。isAborted 供客户端 destroy 联动取消（闸门放行后不再投递）。
    function handle(port, { method, raw, payload, isAborted }) {
        return new Promise((resolve) => {
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
            serverReq.headers = { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) };
            serverReq.socket = { remoteAddress: '127.0.0.1' };
            const serverRes = new EventEmitter();
            serverRes.statusCode = 200;
            serverRes.headers = {};
            serverRes.writeHead = (code, headers) => { serverRes.statusCode = code; Object.assign(serverRes.headers, headers || {}); return serverRes; };
            serverRes.setHeader = (name, value) => { serverRes.headers[String(name).toLowerCase()] = String(value); };
            let body = '', finished = false;
            serverRes.write = (chunk) => { body += chunk; return true; };
            serverRes.end = (chunk) => {
                if (chunk != null && chunk !== undefined)
                    body += chunk;
                if (finished)
                    return serverRes;
                finished = true;
                // 真实回包先落袋，过服务端故障闸门串（wait 挂起、带状态替换回包）再交还客户端
                const settle = async () => {
                    let status = serverRes.statusCode, headers = serverRes.headers, text = body, faulted = false;
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
                    resolve({ status, headers, body: text, faulted });
                };
                settle();
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

    return {
        handle,
        listening(port) { return !!server?.listening && port === server.port; },
        createServer(handler) {
            server = Object.assign(new EventEmitter(), {
                handler, listening: false, port: null,
                listen(portArg, _host, ready) {
                    if (Number.isFinite(Number(portArg)))
                        this.port = Number(portArg);
                    this.listening = true;
                    queueMicrotask(() => { ready?.(); this.emit('listening'); });
                    return this;
                },
                close(cb) {
                    this.listening = false;
                    queueMicrotask(() => cb?.());
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
    };
}

let memory = null; // 未设置 → 默认实现（真实 http.createServer）

const liteServer = {
    // 服务端唯一入口：真实分支透传 http.createServer；内存分支登记内存服务
    createServer(...args) { return memory ? memory.createServer(...args) : http.createServer(...args); },
    // 设置内存实现；返回该实现（一般无须直接持有）
    mock() { return memory ?? (memory = createMemoryServer()); },
    // 移除内存实现，回到真实 createServer；服务登记与故障随实例一并丢弃
    unmock() { memory = null; },
    // 门面间内部通道：lite-http 内存客户端按端口路由请求进来。返回回包
    // { status, headers, body, faulted }；未 mock 或该端口无监听内存服务返回 null（客户端按
    // ECONNREFUSED 拒连——未 mock 即无内存服务，与真实世界无监听同语义）
    handle(port, ctx) {
        return memory ? memory.handle(port, ctx) : Promise.resolve(null);
    },
    // 端口是否有监听中的内存服务（未 mock 恒 false）
    listening(port) {
        return memory ? memory.listening(port) : false;
    },
    // 向内存服务注入服务端故障（handler 已执行后回包阶段）；须先 mock()，返回移除函数
    inject(fault) {
        if (!memory)
            throw new Error('lite-server.inject 需先 mock() 设置内存实现');
        return memory.inject(fault);
    },
};

export default liteServer;
