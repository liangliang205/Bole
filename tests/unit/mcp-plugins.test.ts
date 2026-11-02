import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpPluginError, McpPluginStore } from '../../src/mcp/plugins.ts';

function tempDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-plugins-'));
}

test('安装插件：落盘不含明文凭据，对外只暴露键名', async () => {
  const dataDir = tempDataDir();
  try {
    const store = new McpPluginStore({ dataDir });
    await store.ensureLoaded();
    const plugin = await store.install({
      name: '回显服务',
      description: '测试用',
      command: 'node',
      args: ['echo.mjs'],
      env: { API_TOKEN: 'super-secret-token' },
      allowTools: ['echo'],
    });
    assert.match(plugin.id, /^mcp-[a-z0-9]+$/);
    assert.equal(plugin.env.API_TOKEN, 'super-secret-token');

    const raw = readFileSync(path.join(dataDir, 'mcp', 'plugins.json'), 'utf8');
    assert.equal(raw.includes('super-secret-token'), false, '凭据不得明文落盘');
    assert.equal(raw.includes('API_TOKEN'), true, '键名可以明文（用于展示）');

    const view = store.public()[0];
    assert.deepEqual(view.envKeys, ['API_TOKEN']);
    assert.equal(view.hasCredentials, true);
    assert.equal(JSON.stringify(view).includes('super-secret-token'), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('重新打开插件库能解密凭据；*** 保留原值、新值覆盖', async () => {
  const dataDir = tempDataDir();
  try {
    const first = new McpPluginStore({ dataDir });
    await first.ensureLoaded();
    const installed = await first.install({
      id: 'echo',
      name: 'Echo',
      command: 'node',
      env: { TOKEN: 'v1', OTHER: 'x' },
    });
    assert.equal(installed.id, 'echo');

    const second = new McpPluginStore({ dataDir });
    await second.ensureLoaded();
    assert.equal(second.get('echo')?.env.TOKEN, 'v1');

    await second.update('echo', { env: { TOKEN: '***', OTHER: 'y', NEW: 'z' } });
    const updated = second.get('echo');
    assert.equal(updated?.env.TOKEN, 'v1');
    assert.equal(updated?.env.OTHER, 'y');
    assert.equal(updated?.env.NEW, 'z');

    await second.update('echo', { env: { TOKEN: '' } });
    assert.equal(second.get('echo')?.env.TOKEN, undefined, '空值表示删除该键');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('启停与删除，以及只把启用中的插件交给运行时', async () => {
  const dataDir = tempDataDir();
  try {
    const store = new McpPluginStore({ dataDir });
    await store.ensureLoaded();
    await store.install({ id: 'on', name: 'On', command: 'node', args: ['a.mjs'] });
    await store.install({ id: 'off', name: 'Off', command: 'node', args: ['b.mjs'], enabled: false });
    assert.deepEqual(store.serverConfigs().map((config) => config.id), ['on']);

    await store.setEnabled('off', true);
    assert.deepEqual(store.serverConfigs().map((config) => config.id).sort(), ['off', 'on']);

    await store.setEnabled('on', false);
    assert.deepEqual(store.serverConfigs().map((config) => config.id), ['off']);

    await store.remove('on');
    assert.equal(store.get('on'), undefined);
    await assert.rejects(() => store.remove('on'), McpPluginError);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('非法配置被拒绝：空名称、非法 id、重复 id、缺命令', async () => {
  const dataDir = tempDataDir();
  try {
    const store = new McpPluginStore({ dataDir });
    await store.ensureLoaded();
    await assert.rejects(() => store.install({ name: '' }), /名称不能为空/);
    await assert.rejects(() => store.install({ id: 'Bad Id', name: 'x', command: 'node' }), /id 非法/);
    await assert.rejects(() => store.install({ id: 'nourl', name: 'x', transport: 'http' }), /缺少地址/);
    await assert.rejects(() => store.install({ id: 'nocmd', name: 'x', transport: 'stdio', command: '' }), /缺少启动命令/);
    await store.install({ id: 'ok', name: 'x', command: 'node' });
    await assert.rejects(() => store.install({ id: 'ok', name: 'y', command: 'node' }), /已存在/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('主密钥丢失时只标记凭据错误，插件仍可见且可重填', async () => {
  const dataDir = tempDataDir();
  try {
    const store = new McpPluginStore({ dataDir });
    await store.ensureLoaded();
    await store.install({ id: 'echo', name: 'Echo', command: 'node', env: { TOKEN: 'secret-value' } });
    unlinkSync(path.join(dataDir, 'mcp', 'keyring.key'));

    const reopened = new McpPluginStore({ dataDir });
    await reopened.ensureLoaded();
    const plugin = reopened.get('echo');
    assert.match(plugin?.credentialError ?? '', /无法解密/);
    assert.equal(reopened.public()[0].hasCredentials, false, '解不开的凭据不冒充已配置');
    assert.match(reopened.serverConfigs()[0].configError ?? '', /无法解密/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('旧 config/mcp.json 首次导入为 imported 插件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-import-'));
  const dataDir = path.join(root, 'data');
  try {
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(
      path.join(root, 'config', 'mcp.json'),
      JSON.stringify({ version: 1, servers: { legacy: { command: 'node', args: ['legacy.mjs'], env: { TOKEN: '${ENV:BOLE_IMPORT_TOKEN}' } } } }),
      'utf8',
    );
    process.env.BOLE_IMPORT_TOKEN = 'imported-secret';
    const store = new McpPluginStore({ dataDir, root });
    await store.ensureLoaded();
    const plugin = store.get('legacy');
    assert.equal(plugin?.source, 'imported');
    assert.equal(plugin?.env.TOKEN, 'imported-secret');
    assert.equal(store.serverConfigs()[0].id, 'legacy');
  } finally {
    delete process.env.BOLE_IMPORT_TOKEN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('插件库损坏时记录 loadError 而不是抛异常', async () => {
  const dataDir = tempDataDir();
  try {
    mkdirSync(path.join(dataDir, 'mcp'), { recursive: true });
    writeFileSync(path.join(dataDir, 'mcp', 'plugins.json'), '{ oops', 'utf8');
    const store = new McpPluginStore({ dataDir });
    await store.ensureLoaded();
    assert.match(store.getLoadError() ?? '', /不是合法 JSON/);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
