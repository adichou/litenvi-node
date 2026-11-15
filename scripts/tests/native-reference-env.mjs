// 原生对照子进程使用固定环境，避免 IDE 自动附加调试器和终端颜色设置改变被测输出。
// 保留 PATH、安装配置和业务变量；不修改宿主环境，也不处理或删减实际 stdout/stderr。
export function nativeReferenceEnv(overrides = {}, inherited = process.env) {
  const env = { ...inherited, ...overrides, LC_ALL: 'C', TERM: 'dumb',
    CLICOLOR: '0', NO_COLOR: '1', NODE_DISABLE_COLORS: '1' };
  // CLICOLOR_FORCE 即使值为 "0" 也会让 macOS ls 强制着色，必须移除此键。
  for (const key of ['NODE_OPTIONS', 'VSCODE_INSPECTOR_OPTIONS', 'FORCE_COLOR', 'CLICOLOR_FORCE']) delete env[key];
  return env;
}
