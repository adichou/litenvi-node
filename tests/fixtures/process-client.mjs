// node:process 模块替身探针：sideEntries 加载，验证模块导入（默认导出与具名导出 cwd）与
// 全局 process 指向同一隔离替身——cwd / env / pid 等进程面来自装配参数而非宿主真实进程。
import importedProcess, { cwd as importedCwd } from 'node:process';

export function cwd() {
  return importedProcess.cwd();
}

export function namedCwd() {
  return importedCwd();
}

export function sameAsGlobal() {
  return importedProcess === process;
}

export function envHome() {
  return importedProcess.env.HOME;
}

export function pid() {
  return importedProcess.pid;
}
