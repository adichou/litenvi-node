// 通过唯一公开装配入口验证资源初始化，不导出内部复制函数供测试调用。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Volume, createFsFromVolume } from 'memfs';
import { openBrowserEnvironment } from '../environment.mjs';
import { protocol } from './playwright-protocol.mjs';

test('资源参数复制目录与二进制，先复制全部资源再执行用例初始化', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'litenvi-resources-'));
  try {
    mkdirSync(join(directory, 'nested'));
    const binary = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(directory, 'nested/data.bin'), binary);
    const filesystem = createFsFromVolume(new Volume());
    const p = protocol();
    const fixture = await openBrowserEnvironment({
      ...p.options,
      resources: [{ source: directory, target: '/assets' }, { source: pathToFileURL(directory), target: '/other' }],
      initialData(fs) {
        assert.deepEqual(fs.readFileSync('/assets/nested/data.bin'), binary);
        assert.deepEqual(fs.readFileSync('/other/nested/data.bin'), binary);
        fs.writeFileSync('/assets/nested/data.bin', 'override');
      },
      createEnvironment: initialize => { initialize(filesystem); return p.environment; },
    });
    await fixture.dispose();
    assert.equal(filesystem.readFileSync('/assets/nested/data.bin', 'utf8'), 'override');

    for (const [mapping, expected] of [[{ source: directory, target: 'relative' }, /absolute/], [{ source: join(directory, 'missing'), target: '/missing' }, /ENOENT/]]) {
      await assert.rejects(openBrowserEnvironment({ ...p.options, resources: [mapping], createEnvironment: initialize => { initialize(filesystem); return p.environment; } }), expected);
    }
    symlinkSync(join(directory, 'nested'), join(directory, 'link'));
    await assert.rejects(openBrowserEnvironment({ ...p.options, resources: [{ source: directory, target: '/links' }], createEnvironment: initialize => { initialize(filesystem); return p.environment; } }), /Unsupported source entry/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('只初始化用例数据也可使用；工厂忽略有内容的初始化回调时拒绝假成功', async () => {
  const filesystem = createFsFromVolume(new Volume());
  const p = protocol();
  let initialized = 0;
  function initialData(fs) { initialized += 1; fs.mkdirSync('/custom'); }
  const fixture = await openBrowserEnvironment({ ...p.options, initialData, createEnvironment: initialize => { initialize(filesystem); return p.environment; } });
  assert.ok(filesystem.existsSync('/custom'));
  await fixture.dispose();
  const empty = protocol();
  const plain = await openBrowserEnvironment({ ...empty.options, createEnvironment: initialize => { initialize(filesystem); return empty.environment; } });
  await plain.dispose();
  for (const options of [{ resources: [{ source: '/ignored', target: '/ignored' }] }, { initialData }]) {
    const invalid = protocol();
    await assert.rejects(openBrowserEnvironment({ ...invalid.options, ...options }), /must invoke initialData/);
    assert.ok(invalid.calls.includes('environment.close'));
    assert.ok(!invalid.calls.includes('launch'));
  }
  assert.equal(initialized, 1, '忽略的初始化回调不得被库在装配之后补执行');
});
