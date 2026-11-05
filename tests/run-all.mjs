#!/usr/bin/env node
// 测试聚合入口：自动发现并逐个执行当前目录中的原生测试文件，
// 汇总退出码——任一文件失败即非零退出。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(file => file.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(here, file)], {
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
