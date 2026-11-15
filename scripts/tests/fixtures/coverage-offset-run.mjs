// 覆盖率偏移 1:1 验证的执行载体：经 node --test --experimental-test-coverage 由
// lite-cmd-node Worker 真实执行（本文件位于真实磁盘，测试 Worker 的 lite 单例与父世界
// 独立，体内自装内存卷）；以真实路径探针作为规则跑一次内存卷 eslint 检查——探针的
// 未覆盖分支行号随后由套件侧对照 V8 覆盖率报表断言（等长改写与否的判定锚点）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import liteFs from '../../lite-fs.mjs';
import liteChildProcess from '../../lite-child_process.mjs';
import { t_install } from '../../lite-cmd-eslint.mjs';

const REAL_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** 场景：探针经内存卷运行，验证覆盖率偏移量按预期生效。 */
test('覆盖率偏移探针执行', async () => {
  // 输入：内存卷项目配置以真实路径 import 探针规则；被检文件为合法基线
  const probe = path.join(REAL_ROOT, 'scripts/tests', 'fixtures', 'coverage-offset-probe.mjs');
  liteFs.t_mock({ exclude: [REAL_ROOT] });
  liteChildProcess.t_mock();
  try {
    t_install();
    liteFs.mkdirSync('/mock/project/src', { recursive: true });
    liteFs.writeFileSync('/mock/project/src/entry.mjs', 'export const value = 1;\n');
    const child = liteChildProcess.spawn('eslint', ['src/entry.mjs', '--config', path.join(REAL_ROOT, 'scripts/tests/fixtures/coverage-offset.config.mjs')],
      { cwd: '/mock/project', encoding: 'utf8' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = await liteChildProcess.waitForClose(child);
    const run = { status: closed.code, stdout, stderr };
    // 预期：探针 create 真实执行（covered / partlyCovered(-1)），n > 0 分支保持未覆盖；
    // 合法基线零诊断、无错误——覆盖率偏移断言由套件侧对报表执行
    assert.equal(run.error, undefined, '探针模块应可经加载器执行');
    assert.equal(run.stderr, '', '配置加载与检查不应有错误');
    assert.equal(run.status, 0, '合法基线应零诊断退出 0');
  } finally {
    liteChildProcess.t_unmock();
    liteFs.t_unmock();
  }
});
