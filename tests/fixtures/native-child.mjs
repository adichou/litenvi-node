// 原生虚拟子进程 fixture：按首个参数驱动行为。默认链路覆盖 argv 回显、父世界文件读取、
// 写入 / 删除回流、Git 提交与依赖图新鲜度（每次 spawn 都从 0 重新计数）；
// 其余模式分别验证退出码语义、入口失败与未声明调用记账。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bump } from './native-state.mjs';

const mode = process.argv[2];
if (mode === 'exit3') {
  process.exit(3);
}
else if (mode === 'exit-bare') {
  process.exit();
}
else if (mode === 'exitcode2') {
  process.exitCode = 2;
}
else if (mode === 'fail') {
  throw new Error('入口执行失败');
}
else if (mode === 'deny') {
  try { execFileSync('curl', ['https://example.test']); } catch { /* 未声明调用由环境记账 */ }
}
else if (mode === 'hang') {
  // 挂起模式：假时钟无人推进，await 定时器永不落定——供 kill 语义用例确定化竞态
  await new Promise(resolve => setTimeout(resolve, 60_000));
}
else if (mode === 'stderr') {
  // stderr 通道与 cwd 口径：console.error 经子世界 process 替身回流出错输出，argv cwd 生效
  console.error(`stderr 输出 cwd=${process.cwd()}`);
}
else {
  const input = fs.readFileSync('/app/input.txt', 'utf8');
  fs.writeFileSync('/app/out.txt', `child-write:${input}`);
  fs.rmSync('/app/remove.txt', { force: true });
  execFileSync('git', ['init'], { cwd: '/app' });
  execFileSync('git', ['add', '-A', '--', 'out.txt'], { cwd: '/app' });
  execFileSync('git', ['commit', '--only', '-m', 'child commit', '--', 'out.txt'], { cwd: '/app' });
  console.log(`echo:${mode || '默认'}:${input}:count=${bump()}`);
}
