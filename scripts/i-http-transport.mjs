// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// i-http-transport：客户端门面与服务端 socket 前端共用的内存 HTTP 管线，不依赖两个门面。
// 仅提供 i_ 接口：lite-http 开闭客户端配置并登记传输故障；lite-server 登记和撤销路由函数。
// 两侧生命周期独立：清客户端配置不撤服务路由，撤服务路由不清客户端故障。
// 请求进入时领取故障并消耗 once；传输故障先于路由，响应阶段故障仍由服务端处理。
// 不触网；无服务返回 ECONNREFUSED。取消后不路由或投递，闸门拒绝向调用方传播。
// 已进入管线的请求保留已领取配置；门面复位不追溯改写在途请求。无公共接口或独立测试开关。

let f_client = null;
let f_serverHandler = null;

// URL 规则在登记时规范化，保持来源与完整查询串匹配，fragment 不参与 HTTP 请求。
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

// 内部方法：将已归一化的客户端选项转换成两个入口共用的请求上下文。
export function i_requestContext(config) {
    const method = String(config.method || 'GET').toUpperCase();
    const raw = String((config instanceof URL ? config.pathname + config.search : config.path) || '/');
    const port = Number(config.port) || (config.protocol === 'https:' ? 443 : 80);
    // Host 保留真实 socket 的公开来源，路由地址仍由 hostname 和 port 决定。
    const host = Object.entries(config.headers || {}).find(([name]) => name.toLowerCase() === 'host')?.[1];
    const hostname = config.hostname || config.host || 'localhost';
    const authority = host || `${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${port}`;
    const url = new URL(raw, `${config.protocol || 'http:'}//${authority}`);
    return { method, raw, port, url, hostname, headers: config.headers };
}

// 私有方法：统一响应字节与头名，两个入口均遵循 HEAD/204/304 无正文语义。
function f_response(method, { status, headers, body, faulted = false }) {
    return {
        status,
        headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
        body: method === 'HEAD' || status === 204 || status === 304 ? Buffer.alloc(0) : Buffer.from(body),
        faulted,
    };
}

// 私有方法：创建一轮客户端配置；旧请求持有旧实例，重建不会改写其故障配置。
function f_createClient() {
    const faults = [];
    // 私有方法：仅在本文件实现中使用，不导出。
    const f_matches = (fault, method, path, search, url) => (fault.url === undefined || fault.url === (fault.url.startsWith('/') ? url.pathname + url.search : url.origin + url.pathname + url.search))
        && (!fault.method || String(fault.method).toUpperCase() === method)
        && (!fault.path || (fault.path instanceof RegExp ? fault.path.test(path) : fault.path === path))
        && (!fault.query || Object.entries(fault.query).every(([key, value]) => new URLSearchParams(search).get(key) === String(value)));

    return {
        // 内部方法：领取故障后异步分派，供客户端适配层和 socket 前端共用。
        i_dispatch(context) {
            const { method, raw, url, port, isAborted } = context;
            const at = raw.indexOf('?');
            const target = at === -1 ? raw : raw.slice(0, at);
            const search = at === -1 ? '' : raw.slice(at);
            const matched = faults.filter(rule => f_matches(rule, method, target, search, url));
            for (const fault of matched)
                if (fault.once) {
                    const i = faults.indexOf(fault);
                    if (i !== -1) faults.splice(i, 1);
                }
            // 同步领取 once，异步执行路由，保持 request.end() 的监听与分派时序。
            return Promise.resolve().then(async () => {
                for (const fault of matched) {
                    if (fault.wait instanceof Promise) await fault.wait;
                    if (isAborted()) return;
                    if (fault.status !== undefined) {
                        const body = JSON.stringify(fault.body ?? { error: fault.error || `注入的 HTTP ${fault.status} 错误` });
                        return f_response(method, { status: fault.status, headers: { 'content-type': 'application/json' }, body, faulted: true });
                    }
                }
                if (isAborted()) return;
                const response = f_serverHandler ? await f_serverHandler(port, context) : null;
                if (isAborted()) return;
                if (response === null)
                    throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port });
                return f_response(method, response);
            });
        },
        // 内部方法：由 lite-http 的测试注入入口登记传输故障。
        i_inject(fault) {
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
                if (at !== -1) faults.splice(at, 1);
            };
        },
    };
}

// 内部方法：由 lite-http 创建或复用当前客户端配置，无独立世界开关。
export function i_openClient() { return f_client ??= f_createClient(); }

// 内部方法：由 lite-http 卸载当前客户端配置，不撤销服务路由。
export function i_closeClient() { f_client = null; }

// 内部方法：供 socket 前端确认已启用内存传输，防止混用真实客户端。
export function i_isClientMocked() { return f_client !== null; }

// 内部方法：socket 前端使用当前客户端配置，直接取得响应，无须模拟客户端事件与流。
export function i_dispatch(context) {
    if (!f_client) throw new Error('内存 HTTP 传输需先 liteHttp.t_mock()');
    return f_client.i_dispatch(context);
}

// 内部方法：服务端登记路由函数；返回的撤销函数仅清理同一轮登记。
export function i_registerServer(handler) {
    f_serverHandler = handler;
    return () => { if (f_serverHandler === handler) f_serverHandler = null; };
}
