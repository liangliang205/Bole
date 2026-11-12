import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(ip, bits, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
export function publicDocumentAddress(ip: string): boolean {
  return isIP(ip) === 4 ? !blocked.check(ip, 'ipv4') : isIP(ip) === 6 && publicV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}

/** Fetch public HTTPS documentation with pinned DNS, bounded redirects and size. */
export async function readSetupDocument(input: string, redirects = 0): Promise<string> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 3) throw new Error('请提供公开的 HTTPS 安装文档地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !publicDocumentAddress(entry.address))) throw new Error('安装文档不能指向本机或内网地址');
  const target = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.address, family: target.family, servername: isIP(hostname) ? undefined : hostname, port: 443, path: url.pathname + url.search, headers: { Host: url.host, Accept: 'text/plain, text/markdown, text/html' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        res.resume(); resolve(readSetupDocument(new URL(res.headers.location, url).href, redirects + 1)); return;
      }
      if (res.statusCode !== 200 || !/text\/|application\/(?:json|xhtml\+xml)/i.test(String(res.headers['content-type'] ?? 'text/plain'))) { res.resume(); reject(new Error('无法读取安装文档，请提供文本或网页文档')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 100000) { res.destroy(new Error('安装文档超过 100KB，请提供具体安装页面')); } else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('读取安装文档超时')));
    req.on('error', reject); req.end();
  });
}
