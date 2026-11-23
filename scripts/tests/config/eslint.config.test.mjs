// 实际加载根 ESLint 配置，守护纯库入口及无项目例外的规则接线。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../../../eslint.config.mjs';

/** 场景：根配置启用插件、纯库入口检查和配置守护，原生权限交由规则内置。 */
test('根配置保留纯库测试与原生对照的边界', function test_根配置保留纯库测试与原生对照的边界() {
  assert.ok(config.some(block => block.plugins?.atb), 'plugins.atb 应真实注册');
  const entry = config.find(block => block.rules?.['atb/no-undeclared-entry-in-test']);
  assert.equal(entry.rules['atb/no-undeclared-entry-in-test'][1].uiTest.enabled, false, '纯库应关闭 UI 入口');
  assert.equal(Object.hasOwn(entry.rules['atb/no-undeclared-entry-in-test'][1], 'exceptionFilesAllowModules'), false, '入口规则不应暴露例外配置');
  const imports = config.find(block => block.rules?.['atb/no-blacklist-module-imports']);
  assert.deepEqual(imports.files, ['**/*.js', '**/*.mjs', '**/*.cjs'], '原生环境约束应同时覆盖生产和测试');
  assert.equal(Object.hasOwn(imports.rules['atb/no-blacklist-module-imports'][1], 'exceptionFilesAllowModules'), false, '原生底层权限应由规则内置');
  assert.ok(config.some(block => block.rules?.['atb/no-missing-config-tests']), '配置守护规则应保持启用');
});
