import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface KeyRecord {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
  masked: string;
  updatedAt: string;
}

export interface KeyStatus {
  bound: boolean;
  masked: string | null;
  updatedAt: string | null;
}

export interface BindResult {
  status: KeyStatus;
  verified: boolean;
  warning?: string;
}

/**
 * DeepSeek Key 的服务端持久化。
 *
 * - 不读环境变量，避免进程级泄露与"重启后忘记绑定"。
 * - 使用随机 256-bit 主密钥 + AES-256-GCM 加密后落盘；主密钥与密文分开存放。
 * - 仍然属于本机文件保护级别，不是 HSM/KMS；生产环境应换用密钥管理服务。
 */
export class KeyStore {
  private readonly keyFile: string;
  private readonly recordFile: string;

  constructor(dataDir: string) {
    this.keyFile = path.join(dataDir, 'keyring.key');
    this.recordFile = path.join(dataDir, 'keyring.json');
  }

  private async masterKey(): Promise<Buffer> {
    if (existsSync(this.keyFile)) {
      const key = await readFile(this.keyFile);
      if (key.length === 32) return key;
    }
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    const key = randomBytes(32);
    await writeFile(this.keyFile, key, { mode: 0o600 });
    return key;
  }

  async get(): Promise<string | null> {
    try {
      const record = JSON.parse(await readFile(this.recordFile, 'utf8')) as KeyRecord;
      if (record.version !== 1 || !record.iv || !record.tag || !record.ciphertext) return null;
      const key = await this.masterKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }

  async status(): Promise<KeyStatus> {
    const apiKey = await this.get();
    if (!apiKey) return { bound: false, masked: null, updatedAt: null };
    try {
      const record = JSON.parse(await readFile(this.recordFile, 'utf8')) as KeyRecord;
      return { bound: true, masked: record.masked, updatedAt: record.updatedAt };
    } catch {
      return { bound: true, masked: maskKey(apiKey), updatedAt: null };
    }
  }

  async save(apiKey: string): Promise<KeyStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('API Key 不能为空');
    if (trimmed.length < 20 || /\s/.test(trimmed)) throw new Error('API Key 格式不正确');
    const key = await this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
    const record: KeyRecord = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      masked: maskKey(trimmed),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.recordFile), { recursive: true });
    const temp = `${this.recordFile}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.recordFile);
    return { bound: true, masked: record.masked, updatedAt: record.updatedAt };
  }

  async clear(): Promise<void> {
    for (const file of [this.recordFile, this.keyFile, `${this.recordFile}.tmp`]) {
      try {
        await unlink(file);
      } catch {
        // 不存在即视为已清除
      }
    }
  }
}

export function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return '****';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * 用 /models 做一次轻量校验。只把 401/403 判为 Key 无效；
 * 网络/网关不支持时仍允许绑定，但返回 warning，避免离线时无法保存。
 */
export async function verifyDeepSeekKey(apiKey: string, baseUrl = 'https://api.deepseek.com'): Promise<{ verified: boolean; warning?: string }> {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('DeepSeek 拒绝了该 API Key（401/403），请检查后重试');
    }
    if (response.status === 404 || response.status === 405) {
      return { verified: false, warning: '网关不支持 /models 校验，已保存 Key；如调用失败请检查网关配置。' };
    }
    if (!response.ok) {
      return { verified: false, warning: `Key 校验返回 HTTP ${response.status}，已保存；如调用失败请检查网关。` };
    }
    return { verified: true };
  } catch (error) {
    if (error instanceof Error && /401|403|拒绝/.test(error.message)) throw error;
    return { verified: false, warning: '无法连接 DeepSeek 校验 Key，已保存；请确认网络/网关后使用。' };
  }
}
