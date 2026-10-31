import { sha256Hex } from '../util/ids.ts';
import { maskPII } from '../util/text.ts';

export { maskPII };

/** 台账/日志中只保存 PII 的哈希，不保存明文。 */
export function hashPII(value: string): string {
  return sha256Hex(value.trim().toLowerCase()).slice(0, 16);
}

export function containsPlainPII(text: string): boolean {
  return /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
}

/** 报告使用的脱敏文本：姓名、手机号、邮箱、身份证号。 */
export function redactForReport(text: string): string {
  return maskPII(text);
}
