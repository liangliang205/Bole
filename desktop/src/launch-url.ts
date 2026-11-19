/** 从服务端 stdout 里解析启动 URL；兼容带 ANSI 颜色码的行。 */
const ANSI = /\u001b\[[0-9;]*m/g;
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+/;

export function parseServerUrl(line: string): string | null {
  const clean = line.replace(ANSI, '');
  const match = URL_PATTERN.exec(clean);
  return match ? match[0] : null;
}
