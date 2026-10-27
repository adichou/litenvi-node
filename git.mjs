// 跨项目只读 git 视图：environment 暴露给用例的内存 Git 沙盒查询对象工厂。
// gitLog：提交数组 [{hash, subject, paths}]；committedPaths：已入库 pathspec 集合。
// 两者由沙盒在提交时写入，视图只读并输出副本（调用方改动不影响沙盒状态）。
export function createGitView(gitLog, committedPaths) {
  return Object.freeze({
    log() {
      return gitLog.map((entry) => Object.freeze({
        hash: entry.hash, subject: entry.subject, paths: [...entry.paths],
      }));
    },
    isCommitted(pathspec) { return committedPaths.has(pathspec); },
    // 已入库 pathspec 全量清单：process 后端经 IPC 快照整面回传父进程观测。
    committed() { return [...committedPaths]; },
  });
}
