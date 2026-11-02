import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpConfigError, loadMcpConfig, secretValues } from '../../src/mcp/config.ts';

function withConfig(content: string | null, run: (root: string) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-config-'));
  const file = path.join(root, 'config', 'mcp.json');
  mkdirSync(path.dirname(file), { recursive: true });
  if (content !== null) writeFileSync(file, content, 'utf8');
  const previous = process.env.BOLE_MCP_CONFIG;
  process.env.BOLE_MCP_CONFIG = file;
  const cleanup = () => {
    if (previous === undefined) delete process.env.BOLE_MCP_CONFIG;
    else process.env.BOLE_MCP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const result = run(root);
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('缺少配置文件时视为未配置，而不是错误', async () => {
  await withConfig(null, () => {
    const config = loadMcpConfig();
    assert.equal(config.file, null);
    assert.deepEqual(config.servers, []);
    assert.equal(config.defaults.callTimeoutMs, 60_000);
  });
});

test('解析 stdio 服务、展开 ${ENV:...}、合并默认值', async () => {
  process.env.BOLE_MCP_TEST_TOKEN = 'tok-123456';
  try {
    await withConfig(
      JSON.stringify({
        version: 1,
        defaults: { callTimeoutMs: 1234, maxToolsPerServer: 5 },
        servers: {
          echo: {
            command: 'node',
            args: ['server.mjs', '--token', '${ENV:BOLE_MCP_TEST_TOKEN}'],
            env: { API_TOKEN: '${ENV:BOLE_MCP_TEST_TOKEN:-fallback}' },
            description: '本地回显服务',
          },
        },
      }),
      () => {
        const config = loadMcpConfig();
        const server = config.servers[0];
        assert.equal(config.defaults.callTimeoutMs, 1234);
        assert.equal(config.defaults.maxToolsPerServer, 5);
        assert.equal(server.transport, 'stdio');
        assert.equal(server.enabled, true);
        assert.equal(server.configError, undefined);
        assert.equal(server.args[1], '--token');
        assert.equal(server.args[2], 'tok-123456');
        assert.equal(server.env.API_TOKEN, 'tok-123456');
        assert.deepEqual(server.allowTools, ['*']);
        assert.equal(secretValues(config.servers).includes('tok-123456'), true);
      },
    );
  } finally {
    delete process.env.BOLE_MCP_TEST_TOKEN;
  }
});

test('缺环境变量时只把该服务标记为配置错误', async () => {
  await withConfig(
    JSON.stringify({
      servers: {
        broken: { command: 'node', args: ['x.mjs', '${ENV:BOLE_MCP_DEFINITELY_MISSING}'] },
        healthy: { command: 'node', args: ['y.mjs'] },
      },
    }),
    () => {
      const config = loadMcpConfig();
      const broken = config.servers.find((server) => server.id === 'broken');
      const healthy = config.servers.find((server) => server.id === 'healthy');
      assert.match(broken?.configError ?? '', /环境变量未设置/);
      assert.equal(healthy?.configError, undefined);
    },
  );
});

test('transport 推断与冲突校验', async () => {
  await withConfig(
    JSON.stringify({
      servers: {
        byCommand: { command: 'node' },
        byUrl: { url: 'http://127.0.0.1:3001/mcp' },
        neither: {},
        both: { command: 'node', url: 'http://127.0.0.1:3001/mcp' },
        disabled: { command: 'node', enabled: false },
        badId: { command: 'node' },
      },
    }),
    () => {
      const config = loadMcpConfig();
      const get = (id: string) => config.servers.find((server) => server.id === id)!;
      assert.equal(get('byCommand').transport, 'stdio');
      assert.equal(get('byUrl').transport, 'http');
      assert.match(get('neither').configError ?? '', /http 服务缺少 url/);
      assert.match(get('both').configError ?? '', /二选一/);
      assert.equal(get('disabled').enabled, false);
      assert.equal(get('badId').configError, undefined);
    },
  );
});

test('非法服务 id 被标记为配置错误', async () => {
  await withConfig(JSON.stringify({ servers: { 'bad id!': { command: 'node' } } }), () => {
    const config = loadMcpConfig();
    assert.match(config.servers[0].configError ?? '', /非法/);
  });
});

test('非法 JSON 抛出 McpConfigError', async () => {
  await withConfig('{ oops', () => {
    assert.throws(() => loadMcpConfig(), McpConfigError);
  });
  await withConfig(JSON.stringify({ servers: [] }), () => {
    assert.throws(() => loadMcpConfig(), McpConfigError);
  });
});
