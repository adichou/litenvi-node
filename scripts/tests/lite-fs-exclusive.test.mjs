import assert from 'node:assert/strict';
import { test } from 'node:test';
import liteFs from '../lite-fs.mjs';

/** 场景：wx 形态独占创建在目标已存在（文件与符号链接）时明确失败。 */
test('独占创建不能覆盖已有文件或符号链接', () => {
  // 输入：对已存在的普通文件与符号链接分别执行 wx 独占创建。
  liteFs.t_mock({ exclude: ['/excluded-system-source'] });
  try {
    liteFs.mkdirSync('/mock/locks', { recursive: true });
    liteFs.writeFileSync('/mock/locks/existing', '原内容');
    liteFs.symlinkSync('existing', '/mock/locks/link');
    for (const flag of ['wx', 'ax']) {
      for (const name of ['existing', 'link']) {
        assert.throws(() => liteFs.openSync(`/mock/locks/${name}`, flag), { code: 'EEXIST' }, '独占打开已有路径应失败');
      }
    }
    assert.equal(liteFs.readFileSync('/mock/locks/existing', 'utf8'), '原内容', '失败不能截断原文件');
    const fd = liteFs.openSync('/mock/locks/new', 'wx');
    liteFs.writeFileSync(fd, '新内容');
    liteFs.closeSync(fd);
    assert.equal(liteFs.readFileSync('/mock/locks/new', 'utf8'), '新内容', '不存在时独占创建应成功');
  } finally {
    liteFs.t_unmock();
  }
});
