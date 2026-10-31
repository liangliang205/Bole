import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newId(prefix: string, bytes = 5): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function uuid(): string {
  return randomUUID();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortHash(input: string, length = 8): string {
  return sha256Hex(input).slice(0, length);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
