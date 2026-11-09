// 多行 import、具名再导出与顶层 await 均由 Node 原生处理。
import {
  default as rule,
} from './native-eslint-rule.mjs';
export { moduleURL } from './native-eslint-rule.mjs';
await Promise.resolve();
export default [{ plugins: { native: { rules: { probe: rule } } }, rules: { 'native/probe': 'error' } }];
