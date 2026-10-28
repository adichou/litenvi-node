// lite-browser：Playwright 无头页承载——进程级共享单例浏览器与页面；浏览器请求经
// route 拦截转发到 lite-http 内存通道（内存路由无真实端口，浏览器不监听、不外联，
// 回包即真实路由代码产物）。
// open({ host, port, locale }) 幂等：首个调用启动无头浏览器（locale 透传 newContext，
// 不传用浏览器默认）并挂全量路由转发；后续调用直接复用既有实例——多用例共享同一
// chrome 实例与页面，无须每例重建。使用约定：每例断言前先 home() 回首页，DOM 从
// 已知起点出发、选择器可精确定位。close() 关停并清空单例。
import { chromium } from '@playwright/test';
import liteHttp from './lite-http.mjs';

const forwarded = []; // 转发观测：{ method, path, query, body, status, response, serverResponse }

let shared = null; // 未启动 → null；启动后 { browser, context, page, origin }

export async function open({ host = '127.0.0.1', port = 8888, locale, permissions } = {}) {
  if (shared) return shared;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', ...(locale ? { locale } : {}), ...(permissions ? { permissions } : {}) });
  const page = await context.newPage();
  const origin = `http://${host}:${port}`;
  // 上下文级路由：主页面与新开弹层（演示文档 target=_blank 等）一并走内存转发
  await context.route('**/*', async (route) => {
    try {
      const u = new URL(route.request().url());
      const postBody = route.request().postData();
      // 观测记录对齐旧 environment.http.requests 契约：path 不含查询串（query 单列）、
      // body 为请求体文本；response=最终送达回包（故障或真实），serverResponse 仅真实路由产物
      const rec = { method: route.request().method(), path: u.pathname, query: u.search, body: postBody ?? null, status: 0 };
      forwarded.push(rec);
      const res = await new Promise((resolve, reject) => {
        const chunks = [];
        const req = liteHttp.request({ hostname: host, port, path: u.pathname + u.search, method: route.request().method() }, (r) => {
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8'), faulted: r.faulted === true }));
        });
        req.on('error', reject);
        if (postBody != null) req.write(postBody);
        req.end();
      });
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
      rec.status = res.status; // 拦截即入账（闸门挂起期间可计数），状态回填在放行后
      let json = null, text = undefined;
      if (res.body) {
        try { json = JSON.parse(res.body); } catch { text = res.body; }
      }
      rec.response = { status: res.status, json, headers: res.headers, ...(text !== undefined ? { text } : {}) };
      if (!res.faulted) rec.serverResponse = rec.response;
    } catch {
      await route.abort('failed');
    }
  });
  forwarded.length = 0;
  shared = { browser, context, page, origin };
  return shared;
}

function instance() {
  if (!shared) throw new Error('lite-browser.page 需先 open({ host, port }) 启动共享实例');
  return shared;
}

// 共享页（进程级单例）；pageerror/console 等监听由用例侧自行挂接
export function page() { return instance().page; }

// 共享浏览器上下文（弹层用例 waitForEvent('page') 等）
export function context() { return instance().context; }

// 回首页（默认 '/'）：用例起点复位——SPA 视图与 DOM 从已知状态出发
export async function home(pathname = '/') {
  const { page: p, origin } = instance();
  await p.goto(origin + pathname);
  return p;
}

export async function close() {
  if (!shared) return;
  const s = shared;
  shared = null;
  await s.browser.close().catch(() => {});
}

// 已转发的请求快照（method/path/query/body/status/response/serverResponse）；open 重建实例时自动清零
export function requests() { return [...forwarded]; }

// 活账本：同一数组实例随请求实时增长（resetRequests 原地清空不换引用）——轮询观测用
export function liveRequests() { return forwarded; }

export function resetRequests() { forwarded.length = 0; }

export default { open, page, context, home, close, requests, liveRequests, resetRequests };
