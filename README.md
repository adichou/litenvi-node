# litenvi-node

在独立 VM 中加载完整生产源码，以内存文件系统、时钟、Git 沙盒和 HTTP 流隔离外部环境。业务逻辑、路由和成功回包来自生产源码，HTTP 请求本身始终经内存 mock。成功、失败、重试和超时均不会发出真实网络请求。

## 服务器模式

`buildMockEnvironment({ srcRoot, projectRoot, initialData, sideEntries })` 的主入口必须调用 `http.createServer(...).listen(...)`。没有监听服务时装配失败；不提供无服务器模式或成功回包脚本。此处 listen 只建立内存服务器状态，不绑定任何 TCP 端口。

- `initialData(fs)`：装配期播种项目文件；业务运行后的文件观测面只读。
- `sideEntries`：在服务器的同一依赖图中加载完整客户端/action 模块，通过 `environment.exports` 调用。
- `initialStorage: { local, session }`：播种浏览器存储；传 `local: null` 可模拟本地存储不可用。
- `environment.expose(values)`：装配组件/界面输入；禁止覆盖 fetch、process、时钟、存储等环境通道。
- `environment.clock`、`until(predicate)`：推进虚拟时钟、等待微任务和异步结果收敛。
- `environment.git.run(argv)`：准备内存 Git 世界；`git.log()` 返回实际沙盒提交。
- Node 子进程在独立 VM 执行真实 `.mjs` 入口，独立 argv/输出，共享隔离文件系统与 Git。源码加载仍限制在主入口所在目录内，不拉起真实子进程。

## HTTP 故障

```js
const remove = environment.http.injectFault({
  method: 'GET',
  path: '/api/items',
  query: { page: '2' },
  phase: 'response',
  delayMs: 30,
  once: true,
});
// 正常调用真实客户端；推进时钟后交付真实服务器响应。
await environment.clock.tickAsync(30);
remove();
```

匹配字段是可选的 `method`、`path`（字符串或正则）和 `query`。`phase` 为 `request` 或 `response`：请求阶段故障可阻止路由执行；响应阶段先执行真实路由，再延迟/破坏响应。

故障能力包括 `delayMs`、`wait`（手动控制的 Promise）、`disconnect`、`error`（传输异常），以及 `status: 400..599` 搭配 `body`/`error`（HTTP 错误）。禁止 2xx 成功替换和无错误状态的固定正文。调用返回移除函数，`once` 可限定一次请求。

`http.requests` 保留 method/path/query/body、客户端来源、是否已派发，以及 `serverResponse` 和实际交付的 `response`；响应后故障不会抹去真实服务器的执行证据。fetch 支持标准响应头读取/迭代及 AbortSignal；释放环境会取消悬挂请求、关闭服务并清理计时器。

文件写入故障通过 `failWrite(path)` 或 `setFileWriteError()` 注入，不修改业务方法。

## 验证

运行 `npm test`。通用环境测试与项目的业务测试互补；内存 Git、工具链和浏览器组件模拟不代表真实网络、真实浏览器或平台验收。


## 测试进程禁止原生网络

隔离的 action 测试进程可用 `node --require litenvi-node/network-guard.cjs ...` 预加载网络 mock；单独运行 action 用例时，测试装配助手也须导入该模块。它封锁宿主原生 fetch、HTTP/HTTPS request/get、TCP connect 与 listen，ESM 具名导出同步到同一 mock。默认 `buildMockEnvironment` 的 VM 装配本身不修改宿主函数。

封锁发生在任何连接/监听之前。即使业务捕获了错误，退出审计仍以非零状态报告原生入口尝试，防止失败回退绕开 mock。`NETWORK_MOCK_SUMMARY` 记录尝试数和通道名称，聚合器须检查每个文件的审计结果为零。该模块只在专用测试进程使用；HTTP 场景和故障仍通过内存传输与 `injectFault` 声明，不通过原生请求制造失败。
