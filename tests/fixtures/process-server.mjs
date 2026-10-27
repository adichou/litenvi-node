// 独立示例服务只依赖环境边界；用正常 ESM 导入验证真实模块缓存与系统替身。
import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import importedProcess from 'node:process';
import { bump } from './process-state.mjs';

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://example.test');
  let result;
  if (url.pathname === '/timer') {
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync('/app/tick', String(Date.now()));
  }
  if (url.pathname === '/write') {
    fs.writeFileSync('/app/value', 'changed');
    fs.unlinkSync('/app/remove');
  }
  if (url.pathname === '/deny') {
    try { process.getBuiltinModule('fs'); } catch { /* 验证吞掉异常仍会记账。 */ }
  }
  if (url.pathname === '/module-deny') {
    try { await import('node:worker_threads'); } catch { /* 动态导入失败也必须保留违规记录。 */ }
  }
  if (url.pathname === '/spawn') {
    try { spawn('/mock/node', ['/app/cli.mjs']); } catch { /* 入口缺失由子进程自身退出码体现。 */ }
  }
  if (url.pathname === '/child') {
    // 虚拟 Node 子进程驱动口：spawn 真实入口源码并回流输出（stdout/stderr/退出码）。
    const file = url.searchParams.get('file');
    const args = JSON.parse(url.searchParams.get('args') || '[]');
    const stdin = url.searchParams.get('stdin');
    const child = spawn(process.execPath, [file, ...args], { cwd: process.cwd(), ...(stdin == null ? {} : { stdin }) });
    if (url.searchParams.has('kill'))
      child.kill(); // kill 语义探针：未收 done 的强杀收场口径
    result = await new Promise(resolve => {
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }
  if (url.pathname === '/git') result = spawnSync('git', ['status', '--porcelain'], { cwd: '/app' });
  if (url.pathname === '/process-write') {
    process.env = { ...process.env, LITENVI_PROCESS_VALUE: 'isolated' };
    process.exitCode = 0;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ value: await readFile('/app/value', 'utf8'), count: bump(), now: Date.now(),
    cwd: process.cwd(), sameProcess: importedProcess === process, result,
    processValue: process.env.LITENVI_PROCESS_VALUE, exitCode: process.exitCode }));
}).listen(8888, '127.0.0.1');
