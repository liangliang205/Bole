import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

/** 日志文件名按本地日期切日：server-YYYYMMDD.log */
export function formatLogName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `server-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.log`;
}

/** 超过 5MB 时改用 -2 后缀；已存在更多分片时交给调用方继续序号。 */
export function pickLogPath(dir: string, currentSize: number, now: Date): string {
  const base = formatLogName(now);
  if (currentSize < MAX_BYTES) return path.join(dir, base);
  return path.join(dir, base.replace(/\.log$/, '-2.log'));
}
