// litenvi-node ESLint 入口：接入 atb-eslint-plugin 公共工厂（仓库布局契约 v2）——布局事实
// 全部走默认，规则按模板逐条启用（当前已启用：通配符导入禁令）。下列本仓纪律选项随对应
// 规则块启用逐项回归（传参即生效）：
// - interfaceReturns: [{ module: 'scripts/lite-cmd-mgr.mjs', member: 'default.command' }]
//   （mgr.command 明确返回命令接口句柄，其成员继续按前缀检查；其他函数返回的数据不继承
//   接口访问级别）
// - 测试入口来自 package.json exports：本包公开子进程 API 可在 export 中自测；
//   原生底层及原生对照权限由插件内置，无需项目例外参数。
import { createConfig } from 'atb-eslint-plugin/config.mjs';

export default createConfig({
  // 纯库无 UI 面：uiTest 关闭，保留 bin/export/config 分区。
  uiTest: { enabled: false },
});
