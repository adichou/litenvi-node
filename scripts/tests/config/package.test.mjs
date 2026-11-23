// 本包真实清单的公开门面与测试入口声明守护。
// 清单读取经 lite-fs 门面并完成 mock 装配（排除仓库根——真实清单由透传承接，内存卷不遮蔽）：
// 装配纪律要求 t_mock/t_unmock 配对，守护测试不豁免；new URL(import.meta.url) 是配置守护的
// 真实读取证据形态（lite-fs mock 分派对 file: URL 归一为真实路径后按排除目录透传）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'litenvi-node/lite-fs.mjs';

const REAL_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 场景：发布清单保留公开门面的子路径与 lint 前置检查。 */
test('清单公开 lite 门面并在测试前执行 lint', function test_清单公开_lite_门面并在测试前执行_lint() {
  fs.t_mock({ exclude: [REAL_ROOT] });
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.name, 'litenvi-node', '包名应与使用方导入约定一致');
    assert.equal(manifest.exports['./lite-*.mjs'], './scripts/lite-*.mjs', '公开门面应映射到发布源码');
    assert.equal(manifest.scripts.pretest, 'npm run lint', '测试前应执行完整 lint');
  } finally { fs.t_unmock(); }
});
