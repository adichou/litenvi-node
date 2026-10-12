// 通用环境用例的真实服务器入口：路由结果由服务端产生，不固定替换客户端成功回包。
// 路由声明：/counter 计数器（查询参数不影响命中，路径精确匹配）；未声明路径返回 404。
import http from 'node:http';
let count=0;
http.createServer((req,res)=>{
  const path=req.url.split('?')[0];
  if(path!=='/counter'){res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'未声明路由',path}));return;}
  count++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count,method:req.method}));
}).listen(8888,'127.0.0.1');
export const ready=true;
export const requestCount=()=>count;
