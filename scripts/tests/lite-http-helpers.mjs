// HTTP 门面测试共用的请求夹具；仅提供辅助函数，不注册用例。
/** URL 注入请求夹具：公开 request 接口，超时销毁请求以保证失败用例能收尾。 */
export function i_urlInjectionRequest(client, options) {
  return new Promise((resolve, reject) => {
    const req = client.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, body }); });
      res.on('error', error => { clearTimeout(deadline); reject(error); });
    });
    const deadline = setTimeout(() => req.destroy(new Error('URL 注入请求超时')), 2000);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    req.end();
  });
}
