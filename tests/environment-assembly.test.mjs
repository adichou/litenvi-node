import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { buildMockEnvironment } from '../environment.mjs';

const srcRoot = new URL('./fixtures/entry.mjs', import.meta.url).pathname;

test('VM fallback validates entry, project and runtime support before loading', async () => {
  await assert.rejects(buildMockEnvironment(), /srcRoot/, '缺少入口应拒绝');
  await assert.rejects(buildMockEnvironment({ srcRoot }), /projectRoot/, '缺少项目根应拒绝');
  const module = new URL('../environment.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import{buildMockEnvironment}from${JSON.stringify(module)};try{await buildMockEnvironment({srcRoot:${JSON.stringify(srcRoot)},projectRoot:'/app'})}catch(error){console.error(error.message);process.exitCode=1}`], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'VM 后端缺少实验开关时应失败');
  assert.match(result.stderr, /experimental-vm-modules/, '错误应给出开关指引');
});

test('VM fallback supports null storage, repeated side entries and virtual Node children', async () => {
  const file = new URL('./fixtures/process-cli-client.mjs', import.meta.url).pathname;
  const environment = await buildMockEnvironment({ srcRoot, projectRoot: '/app',
    initialStorage: { local: null, session: null },
    sideEntries: [{ key: 'client', file }, { key: 'again', file }] });
  try {
    assert.equal(environment.global('sessionStorage'), null, '空存储配置应传给 VM');
    assert.equal(environment.exports.again, environment.exports.client, '重复入口应复用同一依赖图');
    const child = environment.exports.client.launch(new URL('./fixtures/process-cli.mjs', import.meta.url).pathname);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    assert.equal((await once(child, 'exit'))[0], 0, '既有虚拟 CLI 能力应保留');
    assert.equal(output, 'cli ready\n', '虚拟 CLI 应执行真实源码');
  } finally { await environment.dispose(); }
});
