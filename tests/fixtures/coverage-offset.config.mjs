// 原生配置用于覆盖率位置验证，不经过源码改写。
import probe from './coverage-offset-probe.mjs';
export default [{ plugins: { probe: { rules: { exercise: probe } } }, rules: { 'probe/exercise': 'error' } }];
