import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ProviderStore } from '../../src/settings/provider-store.ts';
import { KeyStore } from '../../src/settings/key-store.ts';

test('ProviderStore：默认 DeepSeek 提供商，保存 Key 后加密且可读取', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-providers-'));
  try {
    const store = new ProviderStore(dir);
    const initial = await store.list();
    assert.equal(initial.providers.length, 1);
    assert.equal(initial.providers[0].id, 'deepseek');
    assert.equal(initial.providers[0].builtin, true);
    assert.equal(initial.providers[0].hasKey, false);

    await store.save({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      api: 'deepseek',
      flashModel: 'deepseek-flash',
      proModel: 'deepseek-v4-pro',
      apiKey: 'sk-test-1234567890abcdef',
    });
    const active = await store.getActive();
    assert.equal(active?.apiKey, 'sk-test-1234567890abcdef');
    assert.match(active?.maskedKey ?? '', /^sk-t…cdef$/);
    const raw = await readFile(path.join(dir, 'providers.json'), 'utf8');
    assert.doesNotMatch(raw, /sk-test-1234567890abcdef/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ProviderStore：新增、切换、删除提供商', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-providers-'));
  try {
    const store = new ProviderStore(dir);
    const xiaomi = await store.save({
      name: 'xiaomi',
      baseUrl: 'https://api.xiaomi.example/v1',
      api: 'openai',
      flashModel: 'mimo-flash',
      proModel: 'mimo-pro',
      apiKey: 'sk-xiaomi-1234567890',
    });
    assert.equal(xiaomi.hasKey, true);
    assert.equal((await store.list()).activeId, xiaomi.id);
    await store.activate('deepseek');
    assert.equal((await store.list()).activeId, 'deepseek');
    await store.remove(xiaomi.id);
    assert.equal((await store.list()).providers.length, 1);
    await assert.rejects(() => store.remove('deepseek'), /不能删除/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ProviderStore：迁移旧版单一 DeepSeek Key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-providers-'));
  try {
    await new KeyStore(dir).save('sk-legacy-1234567890abcdef');
    const store = new ProviderStore(dir);
    const active = await store.getActive();
    assert.equal(active?.id, 'deepseek');
    assert.equal(active?.apiKey, 'sk-legacy-1234567890abcdef');
    assert.equal(active?.hasKey, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
