// 方法隔离：f_ 表示文件私有；pkg_ 表示仅包内协作；无前缀的接口允许所有调用方使用。
// lite-browser：Playwright 无头页承载——进程级共享单例浏览器与页面。纯浏览器承载：不感知
// 服务端口、不做请求拦截（旧 route 转发与观测账本已随真实 socket 前端迁入 lite-server——
// 浏览器经真实 loopback socket 访问服务，故障/观测管线在进程内一处回灌），调用方自行
// page.goto 导航到目标 origin。
// open({ locale, permissions }) 幂等：首个调用启动无头浏览器（locale 透传 newContext，
// 不传用浏览器默认）；后续调用直接复用既有实例——多用例共享同一 chrome 实例与页面，
// 无须每例重建。使用约定：每例断言前先导航回首页，DOM 从已知起点出发、选择器可精确定位。
// close() 关停并清空单例。
import { chromium } from '@playwright/test';

let f_shared = null; // 未启动 → null；启动后 { browser, context, page }

// 外部方法：启动或复用共享浏览器；允许所有调用方使用，包括测试文件。
export async function open({ locale, permissions } = {}) {
  if (f_shared) return f_shared;
  // --no-proxy-server：彻底绕过系统代理——开发机常驻本地代理（Clash 等）会把回环流量再转
  // 一道，挂起响应（wait 闸门）即堵死代理的上游连接，后续同源请求在代理处排队（实测闸门
  // 用例全程滞留浏览器侧）；测试流量全部回环，永不需要代理
  const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ serviceWorkers: 'block', ...(locale ? { locale } : {}), ...(permissions ? { permissions } : {}) });
  const page = await context.newPage();
  // 请求侧禁用 HTTP 缓存（CDP）：缺省缓存模式下首个同 URL 请求会持有缓存写锁，后续同 URL
  // 请求在锁上排队——闸门挂住首个响应时第二个永远滞留（no-store 响应头来不及生效，锁在请求
  // 侧已取得）。代价是静态资源缓存收益取消，回环建连成本可忽略
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable'); // Network 域命令需先启用才对 loader 生效
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  f_shared = { browser, context, page };
  return f_shared;
}

// 私有方法：取得已启动的浏览器实例；仅在本文件实现中使用，不导出。
function f_instance() {
  if (!f_shared) throw new Error('lite-browser.page 需先 open() 启动共享实例');
  return f_shared;
}

// 共享页（进程级单例）；pageerror/console 等监听由用例侧自行挂接
// 外部方法：取得共享页面；允许所有调用方使用，包括测试文件。
export function page() { return f_instance().page; }

// 共享浏览器上下文（弹层用例 waitForEvent('page') 等）
// 外部方法：取得共享浏览器上下文；允许所有调用方使用，包括测试文件。
export function context() { return f_instance().context; }

// 外部方法：关闭共享浏览器；允许所有调用方使用，包括测试文件。
export async function close() {
  if (!f_shared) return;
  const s = f_shared;
  f_shared = null;
  await s.browser.close().catch(() => {});
}

export default { open, page, context, close };
