// 仅供隔离测试进程预加载：原生网络入口统一替换为拒绝 mock。
// 即使调用方捕获错误，退出审计仍使测试失败；绝不尝试连接外部或本机端口。
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const attempts = [];
function forbidden(channel) {
  attempts.push(channel);
  throw new Error(`测试禁止真实网络调用：${channel}；请使用内存 HTTP mock 或注入故障`);
}
function replace(target, name, channel) {
  target[name] = function () { return forbidden(channel); };
}
globalThis.fetch = async function () { return forbidden('fetch'); };
for (const [module, prefix] of [[http, 'http'], [https, 'https']]) {
  replace(module, 'request', `${prefix}.request`);
  replace(module, 'get', `${prefix}.get`);
}
replace(net, 'connect', 'net.connect');
replace(net, 'createConnection', 'net.createConnection');
replace(net.Socket.prototype, 'connect', 'Socket.connect');
replace(net.Server.prototype, 'listen', 'Server.listen');
// 已绑定的 ESM 具名导出也必须接到同一 mock，不能绕回原生函数。
syncBuiltinESMExports();
process.on('exit', () => {
  const summary = { attempts: attempts.length, channels: [...attempts] };
  process.stdout.write(`NETWORK_MOCK_SUMMARY ${JSON.stringify(summary)}\n`);
  if (attempts.length) {
    process.stderr.write(`禁止真实网络调用：${attempts.join('、')}\n`);
    process.exitCode = 1;
  }
});
