// 覆盖率偏移探针（真实磁盘模块，经 sourceURL 归属进 V8 覆盖率）：顶部两行长 import 供改写
// 清空——若改写抹除行内字符（清空 / 前缀剥除），后续字符偏移整体左移，未覆盖函数体会被
// 映射到错误行号；等长改写下偏移 1:1，未覆盖行恰为源文件内锚点语句所在行（锚点行由用例
// 从本文件源码按语句形态实时计算，注释不重复锚点字面量）。
import { createRequire } from 'node:module';
import path from 'node:path';

// 探针以规则形态被加载执行：create 内 covered(1) 与 partlyCovered(-1) 都真实执行，
// neverCalled 定义后从不调用——其函数体是覆盖率偏移映射的判定锚点（未覆盖行）。
export function covered(n) {
  return n + 1;
}

export function partlyCovered(n) {
  if (n > 0) {
    return n * 2;
  }
  return n + 2;
}

export function neverCalled(n) {
  return n * 3;
}

export default {
  create() {
    covered(1);
    partlyCovered(-1);
    return {};
  },
};
