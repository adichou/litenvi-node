#!/usr/bin/env node
// 测试聚合入口：逐个 spawn 测试文件（子进程继承 --experimental-vm-modules，VM Modules 需要），
// 汇总退出码——任一文件失败即非零退出。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ['browser-storage.test.mjs', 'environment.test.mjs', 'environment-assembly.test.mjs', 'files.test.mjs', 'http-faults.test.mjs', 'lite-browser.test.mjs', 'lite-http.test.mjs', 'lite-fs.test.mjs', 'lite-spawn.test.mjs', 'lite-server.test.mjs', 'network-guard.test.mjs', 'playwright.test.mjs', 'process-child.test.mjs', 'toolchain-matrix.test.mjs', 'process-environment.test.mjs', 'process-protocol.test.mjs', 'process-worker.test.mjs', 'process-worker-send.test.mjs'];

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--experimental-test-module-mocks', path.join(here, file)], {
    stdio: 'inherit',
    env: { ...process.env, TZ: 'Asia/Shanghai' },
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${file} 退出码 ${r.status}`);
  }
}
if (failed) {
  console.error(`\n${files.length} 个测试文件，失败 ${failed}`);
  process.exit(1);
}
console.log(`\n${files.length} 个测试文件，全部通过`);
