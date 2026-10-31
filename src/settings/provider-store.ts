import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../util/ids.ts';
import { KeyStore } from './key-store.ts';

export type ProviderApi = 'deepseek' | 'openai';

interface EncryptedKey {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  flashModel: string;
  proModel: string;
  maskedKey: string | null;
  updatedAt: string;
  builtin?: boolean;
  key: EncryptedKey | null;
}

interface ProviderFile {
  version: 1;
  activeId: string | null;
  providers: ProviderRecord[];
}

export interface ProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  flashModel: string;
  proModel: string;
  maskedKey: string | null;
  hasKey: boolean;
  updatedAt: string;
  active: boolean;
  builtin: boolean;
}

export interface ProviderWithKey extends ProviderPublic {
  apiKey: string | null;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  flashModel: string;
  proModel: string;
  apiKey?: string;
}

const DEFAULT_PROVIDER = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  api: 'deepseek' as ProviderApi,
  flashModel: 'deepseek-flash',
  proModel: 'deepseek-v4-pro',
  builtin: true,
};

function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function validateBaseUrl(value: string): string {
  const url = value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
  return url;
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('提供商名称不能为空');
  return name;
}

function validateModel(value: string, label: string): string {
  const model = value.trim();
  if (!model) throw new Error(`${label}不能为空`);
  return model;
}

/**
 * 多模型提供商配置。Key 使用与 KeyStore 相同的主密钥（data/keyring.key）加密。
 * 首次启动会把旧版单一 DeepSeek Key 迁移为默认 provider，避免用户重新绑定。
 */
export class ProviderStore {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly dataDir: string;
  private cache: ProviderFile | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'providers.json');
    this.keyFile = path.join(dataDir, 'keyring.key');
  }

  private async masterKey(): Promise<Buffer> {
    if (existsSync(this.keyFile)) {
      const key = await readFile(this.keyFile);
      if (key.length === 32) return key;
    }
    await mkdir(this.dataDir, { recursive: true });
    const key = randomBytes(32);
    await writeFile(this.keyFile, key, { mode: 0o600 });
    return key;
  }

  private async encrypt(apiKey: string): Promise<EncryptedKey> {
    const master = await this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private async decrypt(key: EncryptedKey | null): Promise<string | null> {
    if (!key) return null;
    try {
      const master = await this.masterKey();
      const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(key.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(key.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(key.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private async load(): Promise<ProviderFile> {
    if (this.cache) return this.cache;
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as ProviderFile;
        if (parsed?.version === 1 && Array.isArray(parsed.providers)) {
          let changed = false;
          for (const provider of parsed.providers) {
            const builtin = provider.id === DEFAULT_PROVIDER.id;
            if (provider.builtin !== builtin) {
              provider.builtin = builtin;
              changed = true;
            }
          }
          if (!parsed.providers.some((provider) => provider.id === DEFAULT_PROVIDER.id)) {
            parsed.providers.unshift({
              ...DEFAULT_PROVIDER,
              maskedKey: null,
              updatedAt: new Date().toISOString(),
              key: null,
            });
            changed = true;
          }
          if (!parsed.activeId) {
            parsed.activeId = parsed.providers[0]?.id ?? DEFAULT_PROVIDER.id;
            changed = true;
          }
          this.cache = parsed;
          if (changed) await this.persist(parsed);
          return parsed;
        }
      } catch {
        // 损坏时重建默认配置
      }
    }
    const legacyKey = await new KeyStore(this.dataDir).get();
    const provider: ProviderRecord = {
      ...DEFAULT_PROVIDER,
      maskedKey: legacyKey ? maskKey(legacyKey) : null,
      updatedAt: new Date().toISOString(),
      key: legacyKey ? await this.encrypt(legacyKey) : null,
    };
    const store: ProviderFile = { version: 1, activeId: provider.id, providers: [provider] };
    this.cache = store;
    await this.persist(store);
    return store;
  }

  private async persist(store: ProviderFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
    this.cache = store;
  }

  private public(provider: ProviderRecord, activeId: string | null): ProviderPublic {
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      flashModel: provider.flashModel,
      proModel: provider.proModel,
      maskedKey: provider.maskedKey,
      hasKey: Boolean(provider.key),
      updatedAt: provider.updatedAt,
      active: provider.id === activeId,
      builtin: provider.id === DEFAULT_PROVIDER.id || Boolean(provider.builtin),
    };
  }

  async list(): Promise<{ providers: ProviderPublic[]; activeId: string | null }> {
    const store = await this.load();
    const activeId = store.activeId ?? store.providers[0]?.id ?? null;
    return { providers: store.providers.map((provider) => this.public(provider, activeId)), activeId };
  }

  async getActive(): Promise<ProviderWithKey | null> {
    const store = await this.load();
    const activeId = store.activeId ?? store.providers[0]?.id ?? null;
    const provider = store.providers.find((item) => item.id === activeId) ?? null;
    if (!provider) return null;
    return { ...this.public(provider, activeId), apiKey: await this.decrypt(provider.key) };
  }

  async getKey(id: string): Promise<string | null> {
    const store = await this.load();
    const provider = store.providers.find((item) => item.id === id);
    if (!provider) return null;
    return this.decrypt(provider.key);
  }

  async save(input: ProviderInput): Promise<ProviderPublic> {
    const store = await this.load();
    const name = validateName(input.name);
    const baseUrl = validateBaseUrl(input.baseUrl);
    const flashModel = validateModel(input.flashModel, 'Flash 模型');
    const proModel = validateModel(input.proModel, 'Pro 模型');
    if (input.api !== 'deepseek' && input.api !== 'openai') throw new Error(`不支持的 API 类型：${input.api}`);
    const id = input.id?.trim() || newId('prov');
    if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(id)) throw new Error('Provider ID 只能使用小写字母、数字、- 或 _，且以字母/数字开头');
    const index = store.providers.findIndex((provider) => provider.id === id);
    const existing = index >= 0 ? store.providers[index] : null;
    const builtin = existing?.builtin ?? id === DEFAULT_PROVIDER.id;
    const newKey = input.apiKey?.trim() ?? '';
    const encrypted = newKey ? await this.encrypt(newKey) : existing?.key ?? null;
    if (!encrypted) throw new Error('API Key 不能为空');
    const record: ProviderRecord = builtin
      ? {
          ...DEFAULT_PROVIDER,
          id: DEFAULT_PROVIDER.id,
          maskedKey: newKey ? maskKey(newKey) : existing?.maskedKey ?? null,
          updatedAt: new Date().toISOString(),
          key: encrypted,
        }
      : {
          id,
          name,
          baseUrl,
          api: input.api,
          flashModel,
          proModel,
          maskedKey: newKey ? maskKey(newKey) : existing?.maskedKey ?? null,
          updatedAt: new Date().toISOString(),
          builtin: false,
          key: encrypted,
        };
    if (index >= 0) store.providers[index] = record;
    else store.providers.push(record);
    const active = store.providers.find((provider) => provider.id === store.activeId);
    if (!store.activeId || !active || (!active.key && encrypted)) store.activeId = id;
    await this.persist(store);
    return this.public(record, store.activeId);
  }

  async activate(id: string): Promise<ProviderPublic> {
    const store = await this.load();
    const provider = store.providers.find((item) => item.id === id);
    if (!provider) throw new Error(`提供商不存在：${id}`);
    store.activeId = id;
    await this.persist(store);
    return this.public(provider, id);
  }

  async remove(id: string): Promise<void> {
    const store = await this.load();
    const index = store.providers.findIndex((provider) => provider.id === id);
    if (index < 0) throw new Error(`提供商不存在：${id}`);
    if (store.providers[index].builtin || id === DEFAULT_PROVIDER.id) {
      throw new Error('DeepSeek 是内置提供商，不能删除');
    }
    store.providers.splice(index, 1);
    if (store.activeId === id) store.activeId = store.providers.find((provider) => provider.key)?.id ?? store.providers[0]?.id ?? null;
    await this.persist(store);
  }
}
