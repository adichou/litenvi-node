// 方法隔离：f_ 表示文件私有；i_ 表示仅包内协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-process-exit-error：无依赖的公开异常类型，供调用方识别虚拟进程退出意图。
// 仅携带退出码，不记录退出、不终止宿主；记录与收场由调用方负责。
// 所有调用方直接从本模块导入 ProcessExitError，命令实现与执行层共用同一类型。
export class ProcessExitError extends Error {
    // 外部构造方法：允许所有调用方创建退出异常，包括测试文件。
    constructor(code) {
        super(`ProcessExitError：假世界 process.exit(${code})——退出码已记录，宿主进程不终止`);
        this.name = 'ProcessExitError';
        this.exitCode = code;
    }
}
