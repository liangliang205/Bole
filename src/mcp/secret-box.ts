/**
 * 插件凭据的落盘加密：与 settings/key-store 同一套 AES-256-GCM 思路，
 * 但使用独立的 `data/mcp/keyring.key`，避免清空模型 Key 时连带破坏插件凭据。
 *
 * 说明：这是本机文件保护级别，不是 KMS/HSM。密文与主密钥分开存放，权限 0600。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface SealedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  private readonly keyFile: string;
  private cachedKey: Buffer | null = null;

  constructor(dataDir: string) {
    this.keyFile = path.join(dataDir, 'mcp', 'keyring.key');
  }

  private async masterKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    if (existsSync(this.keyFile)) {
      const key = await readFile(this.keyFile);
      if (key.length === 32) {
        this.cachedKey = key;
        return key;
      }
    }
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    const key = randomBytes(32);
    await writeFile(this.keyFile, key, { mode: 0o600 });
    this.cachedKey = key;
    return key;
  }

  async seal(value: unknown): Promise<string> {
    const key = await this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope: SealedEnvelope = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  async open<T>(sealed: string): Promise<T> {
    let envelope: SealedEnvelope;
    try {
      envelope = JSON.parse(sealed) as SealedEnvelope;
    } catch {
      throw new SecretBoxError('凭据密文格式损坏');
    }
    if (envelope?.v !== 1 || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
      throw new SecretBoxError('凭据密文格式损坏');
    }
    const key = await this.masterKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      throw new SecretBoxError('无法解密插件凭据：主密钥可能已更换，请在插件设置里重新填写');
    }
  }
}
