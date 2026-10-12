import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { buildMockEnvironment } from '../environment.mjs';
import { runCases } from './run-cases.mjs';
const guard = new URL('../network-guard.cjs', import.meta.url).pathname;
const environment = new URL('../environment.mjs', import.meta.url).href;
const server = new URL('./fixtures/entry.mjs', import.meta.url).pathname;
function child(script) {
  return spawnSync(process.execPath, ['--require', guard, '--experimental-vm-modules', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 30_000 });
}
function summary(result) {
  const line=result.stdout.split('\n').find(value=>value.startsWith('NETWORK_MOCK_SUMMARY '));
  assert.ok(line, result.stderr);
  return JSON.parse(line.slice('NETWORK_MOCK_SUMMARY '.length));
}
await runCases([
  /** 场景：mock 正常与失败均不发网；输入：内存服务、真实路由、503 与断连；预期：可恢复且原生网络调用为零。 */
  async function mockTransportNeverCallsNativeNetwork() {
    const result=child(`
      import assert from 'node:assert/strict';
      const {buildMockEnvironment}=await import(${JSON.stringify(environment)});
      const env=await buildMockEnvironment({srcRoot:${JSON.stringify(server)},projectRoot:'/mock/project'});
      try {
        assert.equal((await env.http.request('GET','/counter')).json.count,1);
        let remove=env.http.injectFault({path:'/counter',status:503,body:{error:'mock 错误'}});
        assert.equal((await env.http.request('GET','/counter')).status,503);remove();
        remove=env.http.injectFault({path:'/counter',disconnect:true});
        await assert.rejects(env.http.request('GET','/counter'),/断连/);remove();
        assert.equal((await env.http.request('GET','/counter')).json.count,2);
      }finally{await env.dispose();}
    `);
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    assert.equal(summary(result).attempts,0);
  },
  /** 场景：吞掉原生错误仍判红；输入：捕获 fetch、ESM 具名 HTTP 请求与 TCP 监听错误；预期：全被 mock 拦截，退出失败并记录三次。 */
  async function caughtNativeNetworkStillFailsProcess() {
    const result=child(`
      import {request} from 'node:http';import {Server} from 'node:net';
      try{await fetch('http://127.0.0.1:1');}catch{}
      try{request('http://127.0.0.1:1');}catch{}
      try{new Server().listen(0);}catch{}
    `);
    assert.equal(result.status,1);
    assert.deepEqual(summary(result),{attempts:3,channels:['fetch','http.request','Server.listen']});
  },
  /** 场景：封锁只在明确的测试进程开启；输入：普通 VM 环境装配和清理；预期：不会改变宿主 fetch/http 函数。 */
  async function ordinaryEnvironmentKeepsHostFunctions() {
    const nativeFetch=globalThis.fetch,nativeRequest=http.request;
    const env=await buildMockEnvironment({srcRoot:server,projectRoot:'/mock/project'});
    await env.dispose();
    assert.equal(globalThis.fetch,nativeFetch);
    assert.equal(http.request,nativeRequest);
  },
]);
