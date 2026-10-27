// lite-http：node:http 的可切换门面（客户端 request/get + 服务端 createServer 双面）。
// 默认（未设置内存实现）全部原样转发真实 node:http，生产行为不变。mock() 设置内存实现
//（幂等：已设置时复用当前实例）、unmock() 移除（规则与服务随实例丢弃）。
// 内存实现不触网：createServer 登记内存服务（listen 记端口），同端口的 loopback 请求经内存
// 路由到真实 handler（拿到真实路由代码的正确回包）；错误注入（inject，状态 400..599）优先于
// 路由——命中规则的请求收到注入的错误响应（如 500 模拟心跳接口不可达）；无服务或端口不符按
// ECONNREFUSED 拒连。状态为模块级单例：同进程内经同一 specifier 导入（含动态 import）共享。
// 请求体为最小口径（异步消费 handler 可读）；同步 end 的 handler 不保证请求体到达。
import http from 'node:http';
import { EventEmitter } from 'node:events';

// 内存 http 实现：回调式 request/get 按注入规则应答错误、按内存服务路由真实 handler。
// req/res 形状对齐真实 ClientRequest / IncomingMessage / ServerResponse 的常用消费面
//（on('error')/on('response')/end/destroy；statusCode / data / end 事件；writeHead /
// setHeader / end）。
function createMemoryHttp() {
    const faults = [];
    let server = null; // 内存服务：{ handler, listening, port }
    const matches = (fault, method, path) => (!fault.method || String(fault.method).toUpperCase() === method)
        && (!fault.path || fault.path === path);

    function request(options, callback) {
        const config = typeof options === 'string' || options instanceof URL ? new URL(options) : (options || {});
        const method = String(config.method || 'GET').toUpperCase();
        const raw = String((config instanceof URL ? config.pathname + config.search : config.path) || '/');
        const target = raw.split('?')[0];
        const port = Number(config.port) || 80;
        const req = new EventEmitter();
        const chunks = [];
        let ended = false, aborted = false;
        req.write = (chunk) => { chunks.push(String(chunk)); return req; };
        req.end = (body) => {
            if (body !== undefined && body !== null)
                chunks.push(String(body));
            if (ended)
                return req;
            ended = true;
            const payload = chunks.join('');
            queueMicrotask(() => {
                if (aborted)
                    return;
                const fault = faults.find(rule => matches(rule, method, target));
                if (fault) {
                    deliverResponse(fault.status, { 'content-type': 'application/json' },
                        JSON.stringify(fault.body ?? { error: fault.error || `注入的 HTTP ${fault.status} 错误` }));
                    return;
                }
                if (!server?.listening || port !== server.port) {
                    req.emit('error', Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', syscall: 'connect' }));
                    return;
                }
                // 内存路由：合成服务端 req/res，交给真实 handler——回包来自真实路由代码
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
                    deliverResponse(serverRes.statusCode, serverRes.headers, body);
                    return serverRes;
                };
                function deliverResponse(status, headers, text) {
                    queueMicrotask(() => {
                        if (aborted)
                            return;
                        const res = new EventEmitter();
                        res.statusCode = status;
                        res.headers = headers;
                        callback?.(res);
                        req.emit('response', res);
                        queueMicrotask(() => {
                            res.emit('data', Buffer.from(text)); // 同上：响应 data 也按 Buffer 语义
                            res.emit('end');
                        });
                    });
                }
                // 请求体缓冲语义（对齐真实流：data 事件在首个监听挂上后才流动）——payload 先存，
            // 等 handler 侧首个 data 监听（newListener）挂上再投递；handler 内部任意深度的
            // 先行 await（跨站防护、路由分派等）都不会丢 data/end 事件（POST 悬挂根因）
            let pendingBody = payload;
            serverReq.on('newListener', (event) => {
                if (event === 'data' && pendingBody) {
                    const chunk = pendingBody;
                    pendingBody = '';
                    queueMicrotask(() => {
                        serverReq.emit('data', Buffer.from(chunk)); // 对齐真实流：data 事件载荷是 Buffer
                        serverReq.emit('end');
                    });
                }
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
            return req;
        };
        req.destroy = () => { aborted = true; };
        return req;
    }

    return {
        request,
        get(options, callback) {
            const req = request(typeof options === 'string' || options instanceof URL ? options : { ...options, method: 'GET' }, callback);
            req.end(); // 真实 http.get 自动 end，内存实现同口径
            return req;
        },
        // 服务端面：登记唯一内存服务（默认实现转发真实 http.createServer，不经过本函数）
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
            if (!Number.isInteger(fault?.status) || fault.status < 400 || fault.status > 599)
                throw new Error('lite-http 注入仅允许错误状态 400–599（不允许成功回包替换）');
            faults.push(fault);
            return () => {
                const at = faults.indexOf(fault);
                if (at !== -1)
                    faults.splice(at, 1);
            };
        },
    };
}

let memory = null; // 未设置 → 默认实现（真实 node:http）

const liteHttp = {
    request(...args) { return memory ? memory.request(...args) : http.request(...args); },
    get(...args) { return memory ? memory.get(...args) : http.get(...args); },
    createServer(...args) { return memory ? memory.createServer(...args) : http.createServer(...args); },
    // 设置内存 http 实现；返回该实现（inject 已在门面上代理，一般无须直接持有）
    mock() { return memory ?? (memory = createMemoryHttp()); },
    // 移除内存实现，回到真实 node:http；注入规则与内存服务随实例一并丢弃
    unmock() { memory = null; },
    // 向内存实现注入错误规则；须先 mock()，返回移除函数
    inject(fault) {
        if (!memory)
            throw new Error('lite-http.inject 需先 mock() 设置内存 http 实现');
        return memory.inject(fault);
    },
};

export default liteHttp;
