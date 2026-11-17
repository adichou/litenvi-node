// litenvi-node ESLint 入口：接入 atb-eslint-plugin 公共工厂（仓库布局契约 v2）——布局事实
// 全部走默认，规则按模板逐条启用（当前已启用：通配符导入禁令）。下列本仓纪律选项随对应
// 规则块启用逐项回归（传参即生效）：
// - interfaceReturns: [{ module: 'scripts/lite-cmd-mgr.mjs', member: 'default.command' }]
//   （mgr.command 明确返回命令接口句柄，其成员继续按前缀检查；其他函数返回的数据不继承
//   接口访问级别）
// - 测试入口来自 package.json exports：本包公开子进程 API 可在 export 中自测；
//   原生对照的进程调用通过 exceptionFilesAllowModules 按文件、模块与理由登记。
import pluginPackageJson from 'eslint-plugin-package-json';
import { createConfig } from 'atb-eslint-plugin/config.mjs';

export default createConfig({
  root: import.meta.dirname,
  // package.json 清单面（JSON parser 自备依赖）：未使用运行时依赖 + 入口面指向核验 + dist-tag
  // 禁令；本地来源（file: 的 atb-eslint-plugin 平级仓）不检——开发分支联调形态，main 分支
  // 守护归交付流程（看板 REQ-20261116-003）。
  packageJson: { parser: pluginPackageJson.configs.recommended.languageOptions.parser },
  // 纯库无 UI 面：uiTest 关闭，保留 bin/export/config 分区。
  uiTest: { enabled: false },
  // 这些用例的验证对象就是原生接口身份、真实回环 socket 或原生对照结果，不能改走内存响应。
  // 仅登记具体测试文件；其他门面测试继续遵守环境模块导入限制（黑名单走工厂缺省环境组）。
  exceptionFilesAllowModules: [
    {
      file: 'export/native-reference.test.mjs',
      modules: ['node:child_process', 'node:fs', 'node:http'],
      reason: '对照原生进程、文件和网络行为，用独立进程隔离真实 IO',
    },
  ],
});
