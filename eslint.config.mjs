// litenvi-node ESLint 入口：接入 atb-eslint-plugin 公共工厂（仓库布局契约 v2）——布局事实
// 全部走默认，规则按模板逐条启用（当前已启用：通配符导入禁令）。下列本仓纪律选项随对应
// 规则块启用逐项回归（传参即生效）：
// - interfaceReturns: [{ module: 'scripts/lite-cmd-mgr.mjs', member: 'default.command' }]
//   （mgr.command 明确返回命令接口句柄，其成员继续按前缀检查；其他函数返回的数据不继承
//   接口访问级别）
// - entry: []（纯库设防：测试直启生产脚本即报）
// - entryExceptionFiles: ['lite-cmd-node.test.mjs', 'lite-cmd-os.test.mjs']
//   （被测对象就是命令机制本体：node --test 运行器参数向量、test/cd 无脚本 REPL 形态）
// - badTestExceptionFiles: ['scripts/tests/lite-timer.test.mjs', 'scripts/tests/lite-server.test.mjs',
//   'scripts/tests/lite-child_process.test.mjs', 'scripts/tests/lite-browser-timer.test.mjs',
//   'scripts/tests/native-reference.test.mjs']
//   （固定睡眠属内在真实时序：timer 透传真实定时器、server 真实 socket 观察窗、
//   child_process 真实 timeout 负空间、browser-timer gate 真实时间窗、native-reference
//   真实子进程信号/盘上时序观察窗）
import pluginPackageJson from 'eslint-plugin-package-json';
import { createConfig } from 'atb-eslint-plugin/config.mjs';

export default createConfig({
  root: import.meta.dirname,
  // package.json 清单面（JSON parser 自备依赖）：未使用运行时依赖 + 入口面指向核验 + dist-tag
  // 禁令；本地来源（file: 的 atb-eslint-plugin 平级仓）不检——开发分支联调形态，main 分支
  // 守护归交付流程（看板 REQ-20261116-003）。
  packageJson: { parser: pluginPackageJson.configs.recommended.languageOptions.parser },
  // 纯库无 UI 面：uiTest 关闭（测试三分区退化为 bin/export，ui/ 不设区）。
  uiTest: { enabled: false },
});
