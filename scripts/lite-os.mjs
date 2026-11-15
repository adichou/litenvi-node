// 方法隔离：f_ 表示文件私有；i_ 表示仅同包协作；t_ 表示仅测试代码可引用或调用；无前缀的接口允许所有调用方使用。
// lite-os：node:os 的可切换门面（路径锚点与只读环境面）。默认（未设置内存覆盖）原样转发
// 真实 node:os，生产行为不变。t_mock({ homedir?, tmpdir?, platform?, arch?, hostname? }) 按
// 键覆盖（已设置时合并既有覆盖），t_unmock() 移除（覆盖随实例丢弃）。
// 覆盖语义：给出的键替换为指定值；未给出的键与本机同源（只读合理缺省，同 lite-process 的
// platform 口径）。homedir/tmpdir 是内存世界的路径锚点——注册表、用户级配置等 `<home>/.…`
// 路径的落点，覆盖后所有经本门面的路径解析随之落入调用方装配的世界；platform/arch/hostname
// 为只读标识，与本机同源即可满足常规用例（覆盖键仅留给环境敏感用例）。
// EOL 为静态字符串常量，原样透传（无覆盖面）。状态为模块级单例：同进程内经同一 specifier
// 导入（含动态 import）共享。
import os from 'node:os';

// 允许覆盖的键清单：homedir/tmpdir/hostname 为路径或主机名串，platform/arch 为标识串。
// 私有方法：仅在本文件实现中使用，不导出。
const f_OVERRIDABLE_KEYS = ['homedir', 'tmpdir', 'platform', 'arch', 'hostname'];

// 私有方法：校验覆盖键；仅在本文件实现中使用，不导出。
function f_validateOverrides(overrides) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))
        throw new Error('lite-os.t_mock 的参数须为覆盖对象（键：homedir/tmpdir/platform/arch/hostname）');
    for (const key of Object.keys(overrides))
        if (!f_OVERRIDABLE_KEYS.includes(key))
            throw new Error(`lite-os 覆盖不支持键：${key}（允许：${f_OVERRIDABLE_KEYS.join(' / ')}）`);
}

let f_memory = null; // 未设置 → 默认实现（真实 node:os）

const liteOs = {
    // 外部方法：允许所有调用方使用，包括测试文件。
    homedir() { return f_memory?.homedir ?? os.homedir(); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    tmpdir() { return f_memory?.tmpdir ?? os.tmpdir(); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    platform() { return f_memory?.platform ?? os.platform(); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    arch() { return f_memory?.arch ?? os.arch(); },
    // 外部方法：允许所有调用方使用，包括测试文件。
    hostname() { return f_memory?.hostname ?? os.hostname(); },
    // 行分隔符常量：与原生同源（无覆盖面）。
    // 外部属性：允许所有调用方使用，包括测试文件。
    EOL: os.EOL,
    // 设置内存覆盖（已有覆盖时按键合并）；返回公共门面，不暴露私有运行态
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_mock(overrides = {}) {
        f_validateOverrides(overrides);
        f_memory = { ...(f_memory || {}), ...overrides };
        return liteOs;
    },
    // 移除内存覆盖，回到真实 node:os
    // 测试专用方法：仅测试代码可引用或调用，生产代码禁止使用。
    t_unmock() { f_memory = null; },
    // 内存覆盖是否已设置
    // 外部方法：允许所有调用方使用，包括测试文件。
    isMocked() { return f_memory !== null; },
};

export default liteOs;
