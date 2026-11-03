import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 把 async 请求处理函数安全地交给 createServer。
 *
 * `createServer(async (req, res) => ...)` 会把 Promise 交给 Node 的 HTTP 服务器，
 * 而服务器并不消费它：处理函数里未被 catch 的异常只会变成 unhandledRejection，
 * 测试用的假模型服务尤其容易被误判成"请求挂住"。这里显式 void 掉返回值，
 * 真实异常仍由请求侧（provider 抛错）暴露给断言。
 */
export function voidHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handler(req, res);
  };
}
