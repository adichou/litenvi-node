// stdin 载荷回显 fixture：以 fd 0 读取标准输入并原样输出，验证虚拟子进程的 stdin 通道。
import fs from 'node:fs';
console.log(`stdin:${fs.readFileSync(0, 'utf8')}`);
