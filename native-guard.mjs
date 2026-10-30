// 原生加载仍保留生产模块的目录边界和内建模块白名单，不改写业务源码。
import { isBuiltin } from 'node:module';
let root, allowed, port;

export function initialize(data) {
  ({ root, port } = data);
  allowed = new Set(data.allowed);
}

export async function resolve(specifier, context, next) {
  if (!context.parentURL?.startsWith(root)) return next(specifier, context);
  const builtin = isBuiltin(specifier);
  const name = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
  const result = await next(specifier, context);
  const packageHit = [...allowed].some((entry) => !entry.startsWith('node:') && specifier.startsWith(entry));
  if ((builtin && !allowed.has(name)) || (!builtin && !result.url.startsWith(root) && !packageHit)) {
    const message = `未声明的环境模块：${specifier}`;
    port.postMessage(message);
    throw new Error(message);
  }
  return result;
}
