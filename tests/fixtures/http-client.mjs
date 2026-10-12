import {spawn,spawnSync,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
// 浏览器请求入口：保持真实 fetch 调用，故障只在传输层注入。
export const request = (path, options) => fetch(path, options);
export async function runChild(file, args=[]) {

 const child=spawn(process.execPath,[file,...args],{cwd:process.cwd()});
 return new Promise(resolve=>{let stdout='',stderr='';child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});child.on('close',code=>resolve({code,stdout,stderr}));});
}

export async function gitChannels(){const root=process.cwd();return {direct:spawnSync('git',['-C',root,'branch','--show-current'],{encoding:'utf8'}),file:execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}),async:await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'})};}
