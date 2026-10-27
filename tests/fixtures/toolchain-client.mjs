// 工具链探测 fixture：经业务世界的 child_process 替身执行 spawnSync / spawn 组合，
// 供矩阵用例断言 git 路由（cwd / -C / 工作树）、版本查询与 npm test 出口。
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';

export const probe = (command, args, options) => spawnSync(command, args, options ?? { cwd: process.cwd() });
export const spawnProbe = (command, args, options) => new Promise((resolve) => {
  const child = spawn(command, args, options ?? { cwd: process.cwd() });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => resolve({ code, out, err }));
});
export const writeMarker = (path, text) => {
  fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(path, text);
};
