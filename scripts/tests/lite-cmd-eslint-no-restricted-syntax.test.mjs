// lite-cmd-eslint 独立用例文件：no-restricted-syntax 正常场景（按用户指示单独成文件；
// 门面主测试文件仍为 lite-cmd-eslint.test.mjs，此处不重复包自引用单例检查）。
// 核心规则 no-restricted-syntax 无需插件夹具，配置即可驱动；执行走 helpers 的 spawnEslint 公共门路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, write, spawnEslint } from './lite-cmd-eslint-helpers.mjs';

/** 场景：正常 lint 场景——核心规则 no-restricted-syntax 经 options 选择器命中并按真实引擎口径报告。 */
test('no-restricted-syntax 正常命中', async () => {
  const done = setup();
  try {
    // 输入：核心规则 + options 选择器（官方文档 object 形态，无需外置规则模块）
    write('/mock/project', 'eslint.config.mjs', `const config = [{
    rules: {
        'no-restricted-syntax': ['error', { selector: "CallExpression[callee.name='bad']", message: '禁止调用 bad()' }],
    },
}];

export default config;
`);
    write('/mock/project', 'a.js', 'bad();\n');
    const result = (await spawnEslint(['a.js'], { cwd: '/mock/project' }));
    // 预期：选择器命中，退出码与诊断为真实引擎口径
    assert.equal(result.status, 1, '规则命中应退出 1');
    assert.ok(result.stdout.includes('/mock/project/a.js'), '应报告内存卷文件路径');
    assert.ok(result.stdout.includes('no-restricted-syntax'), '应报告规则 ID');
    assert.ok(result.stdout.includes('禁止调用 bad()'), '应使用配置的自定义消息');
    assert.ok(result.stdout.includes('1:1'), '应报告调用起点行位列');
    assert.ok(result.stdout.includes('✖ 1 problem (1 error, 0 warnings)'), '汇总应为一条错误');
  } finally {
    done();
  }
});
