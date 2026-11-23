// lite-os 门面的黑盒用例：路径锚点覆盖、只读标识透传与单例契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import liteOs from '../../lite-os.mjs';
import os from 'node:os';

/** 场景：未 mock 时全部面原样转发真实 node:os——生产行为不变。 */
test('默认透传：真实 homedir/tmpdir/标识面，isMocked 为假', function test_默认透传_真实_homedir_tmpdir_标识面_isMocked_为假() {
  // 输入：未 mock 状态下逐面调用 os 接口并与 node:os 原生值对比。
  liteOs.t_unmock();
  assert.equal(liteOs.isMocked(), false, '未 mock 不应处于内存覆盖态');
  assert.equal(liteOs.homedir(), os.homedir(), '未 mock 的 homedir 应转发原生');
  assert.equal(liteOs.tmpdir(), os.tmpdir(), '未 mock 的 tmpdir 应转发原生');
  assert.equal(liteOs.platform(), os.platform(), '未 mock 的 platform 应与本机同源');
  assert.equal(liteOs.arch(), os.arch(), '未 mock 的 arch 应与本机同源');
  assert.equal(liteOs.hostname(), os.hostname(), '未 mock 的 hostname 应与本机同源');
  assert.equal(liteOs.EOL, os.EOL, 'EOL 常量应与原生同源');
});

/** 场景：mock 后路径锚点取覆盖值、未覆盖键与本机同源；EOL 常量不受覆盖影响。 */
  // 输入：未 mock 状态下逐面调用 os 接口并与 node:os 原生值对比。
test('内存覆盖：路径锚点取覆盖值，未覆盖键同源', function test_内存覆盖_路径锚点取覆盖值_未覆盖键同源() {
  // 输入：t_mock 覆盖 homedir/tmpdir 后逐面读取，并与本机未覆盖键对比。
  liteOs.t_unmock();
  liteOs.t_mock({ homedir: '/mock/home', tmpdir: '/mock/tmp' });
  try {
    assert.equal(liteOs.isMocked(), true, 'mock 后应处于内存覆盖态');
    assert.equal(liteOs.homedir(), '/mock/home', 'homedir 应取覆盖值');
    assert.equal(liteOs.tmpdir(), '/mock/tmp', 'tmpdir 应取覆盖值');
    assert.equal(liteOs.platform(), os.platform(), '未覆盖的 platform 应与本机同源');
    assert.equal(liteOs.EOL, os.EOL, 'EOL 常量不随覆盖变化');
  } finally {
    liteOs.t_unmock();
  }
});

  // 输入：t_mock 覆盖 homedir/tmpdir 后逐面读取，并与本机未覆盖键对比。
/** 场景：已覆盖时再次 mock 按键合并——新键追加、旧键保留；unmock 后回到原生。 */
test('覆盖合并：增量追加且互不覆盖，unmock 复位', function test_覆盖合并_增量追加且互不覆盖_unmock_复位() {
  // 输入：两次增量 t_mock 合并覆盖键，随后 t_unmock 复位。
  liteOs.t_unmock();
  liteOs.t_mock({ homedir: '/mock/home' });
  liteOs.t_mock({ tmpdir: '/mock/tmp', platform: 'mockos' });
  try {
    assert.equal(liteOs.homedir(), '/mock/home', '既有覆盖键应保留');
    assert.equal(liteOs.tmpdir(), '/mock/tmp', '新增覆盖键应生效');
    assert.equal(liteOs.platform(), 'mockos', '新增覆盖键应生效');
  } finally {
    liteOs.t_unmock();
  }
  assert.equal(liteOs.homedir(), os.homedir(), 'unmock 后应回到真实 homedir');
  assert.equal(liteOs.platform(), os.platform(), 'unmock 后应回到真实 platform');
});
  // 输入：两次增量 t_mock 合并覆盖键，随后 t_unmock 复位。

/** 场景：未支持的覆盖键明确报错，不静默忽略。 */
test('覆盖校验：未知键明确报错', function test_覆盖校验_未知键明确报错() {
  // 输入：向 t_mock 传入未知键与非对象参数。
  liteOs.t_unmock();
  assert.throws(() => liteOs.t_mock({ userInfo: {} }), /不支持键/, '未知覆盖键应报错');
  assert.throws(() => liteOs.t_mock(null), /须为覆盖对象/, '非对象参数应报错');
  assert.equal(liteOs.isMocked(), false, '报错后不应留下半套覆盖');
});

/** 场景：包自引用 specifier 与相对导入共享同一单例——业务经 litenvi-node/lite-os.mjs 导入的
 * 路径锚点与库内部相对导入必须是同一实例，否则覆盖会静默分裂（exports 变动先红）。 */
test('包自引用 specifier 与相对导入共享同一单例', async function test_包自引用_specifier_与相对导入共享同一单例() {
  // 输入：经 litenvi-node 包 specifier 动态导入本模块并与相对导入实例对比。
  const selfRef = await import('litenvi-node/lite-os.mjs');
  assert.equal(selfRef.default, liteOs, '同一模块经不同 specifier 应共享同一实例');
});
