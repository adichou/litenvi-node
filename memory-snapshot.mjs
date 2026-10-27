// IPC 只同步变化的文件内容；Buffer 保持二进制，父进程只提供只读观测。
export function createSnapshotReader(volume) {
  let previous = {};
  return () => {
    const current = volume.toJSON(undefined, {}, false, true);
    const files = {};
    for (const [name, value] of Object.entries(current)) {
      const old = previous[name];
      const same = value === null ? old === null : Buffer.isBuffer(old) && value.equals(old);
      if (!same) files[name] = value;
    }
    const deleted = Object.keys(previous).filter(name => !Object.hasOwn(current, name));
    previous = Object.fromEntries(Object.entries(current).map(([name, value]) =>
      [name, value === null ? null : Buffer.from(value)]));
    return { files, deleted };
  };
}

export function applySnapshot(volume, { files, deleted }) {
  for (const name of deleted) volume.rmSync(name, { recursive: true, force: true });
  for (const [name, value] of Object.entries(files)) {
    if (volume.existsSync(name) && volume.statSync(name).isDirectory() !== (value === null))
      volume.rmSync(name, { recursive: true, force: true });
  }
  volume.fromJSON(files);
  // memfs fromJSON 为文件隐式建目录，而差量快照只输出空目录（null）与非空目录下的文件：
  // 业务删除目录后，该目录从未以条目形态出现，仅删其下文件会让隐式父目录残留空壳。
  // 向上清理这些空壳（REQ-20261024-001 process 后端观测保真）；本快照显式声明的
  // 目录（null 条目，含 fromJSON 重建的空目录）代表子进程真实存在，不得清理。
  const declared = new Set(Object.entries(files).filter(([, value]) => value === null).map(([name]) => name));
  for (const name of deleted) {
    let dir = name.slice(0, name.lastIndexOf('/'));
    while (dir && dir !== '/' && dir !== '.') {
      if (declared.has(dir)) break;
      try {
        if (volume.readdirSync(dir).length > 0) break;
        volume.rmdirSync(dir);
      } catch { break; }
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
}
