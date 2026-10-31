import { sha256Hex } from '../util/ids.ts';

const PHONE_RE = /(?<!\d)(?:\+?86[- ]?)?(1[3-9]\d{9})(?!\d)/;
const PHONE_DASH_RE = /(?<!\d)(1[3-9]\d)[- ]?(\d{4})[- ]?(\d{4})(?!\d)/;
const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
const NAME_RE = /姓名\s*[:：]\s*([\u4e00-\u9fa5·]{2,6})/;

export interface Identity {
  name: string;
  phone: string;
  email: string;
}

export function extractIdentity(text: string): Identity {
  const phoneRaw = PHONE_RE.exec(text)?.[1] ?? PHONE_DASH_RE.exec(text)?.slice(1).join('') ?? '';
  const phone = phoneRaw.replace(/\D/g, '');
  const email = (EMAIL_RE.exec(text)?.[1] ?? '').toLowerCase();
  const name = (NAME_RE.exec(text)?.[1] ?? '').replace(/\s+/g, '');
  return { name, phone, email };
}

/** 正文指纹：姓名 + 手机 + 邮箱归一化后哈希；缺身份信息时退化为正文哈希。 */
export function dedupKeyFromText(text: string): string {
  const identity = extractIdentity(text);
  if (identity.phone || identity.email || identity.name) {
    return sha256Hex(`id|${identity.name}|${identity.phone}|${identity.email}`).slice(0, 32);
  }
  const normalized = text.replace(/\s+/g, '');
  return sha256Hex(`text|${normalized}`).slice(0, 32);
}

export function attachmentFingerprint(buffer: Buffer): string {
  return sha256Hex(buffer);
}
