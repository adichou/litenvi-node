// 实际加载根 ESLint 配置，守护纯库入口及原生对照授权。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../../../eslint.config.mjs';

/** 场景：根配置启用插件、纯库入口检查和配置守护，原生对照按文件登记。 */
test('根配置保留纯库测试与原生对照的边界', () => {
  assert.ok(config.some(block => block.plugins?.atb), 'plugins.atb 应真实注册');
  const entry = config.find(block => block.rules?.['atb/no-undeclared-entry-in-test']);
  assert.equal(entry.rules['atb/no-undeclared-entry-in-test'][1].uiTest.enabled, false, '纯库应关闭 UI 入口');
  const exceptions = entry.rules['atb/no-undeclared-entry-in-test'][1].exceptionFilesAllowModules;
  assert.ok(exceptions.some(item => item.file === 'export/native-reference.test.mjs' && item.modules.includes('node:child_process') && item.reason.trim()), '原生对照必须登记具体文件、子进程模块和理由');
  const imports = config.find(block => block.rules?.['atb/no-modules-import-in-test']);
  assert.deepEqual(imports.rules['atb/no-modules-import-in-test'][1].exceptionFilesAllowModules, exceptions, '入口与模块导入规则必须使用同一份例外登记');
  assert.ok(exceptions.filter(item => item.file && item.file !== 'export/native-reference.test.mjs').every(item => !item.modules.includes('node:child_process')), '文件例外不得扩大为原生进程授权（全局黑名单段无 file，不算文件例外）');
  assert.ok(config.some(block => block.rules?.['atb/no-missing-config-tests']), '配置守护规则应保持启用');
});
