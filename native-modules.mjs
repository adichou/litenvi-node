// 只在独立业务子进程内安装替身，Playwright 与宿主测试进程保持真实时间。
import { mock } from 'node:test';
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadNativeModules({ srcRoot, mocks, globals, unexpected }) {
  const originalProcess = process;
  const descriptors = new Map();
  const contexts = [];
  const { port1, port2 } = new MessageChannel();
  port1.on('message', message => unexpected.push(message));
  port1.unref();
  function restore() {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    for (const context of contexts.reverse()) context.restore();
    port1.close();
  }
  try {
    // mock.module 的 CJS 桥会把命名导出定义到 defaultExport 上，不能让代理目标指向真实 process。
    const processFace = new Proxy({ ...originalProcess, ...globals.process }, {
      get(_target, key) {
        if (key === 'getBuiltinModule') return () => {
          const message = '未声明的环境调用：process.getBuiltinModule';
          unexpected.push(message);
          throw new Error(message);
        };
        const owner = key in globals.process ? globals.process : originalProcess;
        const value = owner[key];
        return typeof value === 'function' ? value.bind(owner) : value;
      },
      set(_target, key, value) {
        globals.process[key] = value;
        return true;
      },
    });
    const modules = { ...mocks, 'node:fs/promises': mocks['node:fs'].promises, 'node:process': processFace };
    for (const [name, values] of Object.entries(modules))
      contexts.push(mock.module(name, { defaultExport: values, namedExports: { ...values } }));
    register(new URL('./native-guard.mjs', import.meta.url), {
      data: { root: pathToFileURL(fs.realpathSync(path.dirname(srcRoot)) + path.sep).href,
        allowed: [...Object.keys(modules), 'node:path', 'node:url', 'node:util'], port: port2 },
      transferList: [port2],
    });
    for (const [key, value] of Object.entries(globals)) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true,
        value: key === 'process' ? processFace : key === 'window' ? globalThis : value });
    }
    const entry = await import(pathToFileURL(srcRoot).href);
    return { exports: { entry }, restore };
  } catch (error) {
    restore();
    throw error;
  }
}
