import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { KeyStore } from '../../src/settings/key-store.ts';

const KEY = 'sk-test-1234567890abcdef';

test('KeyStore：绑定后加密持久化，新实例可读取，清除后失效', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-keyring-'));
  try {
    const store = new KeyStore(dir);
    assert.deepEqual(await store.status(), { bound: false, masked: null, updatedAt: null });
    const status = await store.save(KEY);
    assert.equal(status.bound, true);
    assert.match(status.masked ?? '', /^sk-t…cdef$/);
    assert.equal(await store.get(), KEY);

    const reopened = new KeyStore(dir);
    assert.equal(await reopened.get(), KEY);
    const reopenedStatus = await reopened.status();
    assert.equal(reopenedStatus.bound, true);
    assert.equal(reopenedStatus.masked, status.masked);

    await reopened.clear();
    assert.equal(await reopened.get(), null);
    assert.equal((await reopened.status()).bound, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('KeyStore：密文文件损坏时不泄露也不误报已绑定', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-keyring-'));
  try {
    await writeFile(path.join(dir, 'keyring.json'), '{not-json', 'utf8');
    const store = new KeyStore(dir);
    assert.equal(await store.get(), null);
    assert.equal((await store.status()).bound, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('KeyStore：拒绝空 Key 与含空白的 Key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-keyring-'));
  try {
    const store = new KeyStore(dir);
    await assert.rejects(() => store.save(''), /不能为空/);
    await assert.rejects(() => store.save('sk-abc def'), /格式/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
