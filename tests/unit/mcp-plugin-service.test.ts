import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpPluginService } from '../../src/mcp/plugin-service.ts';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/echo-server.mjs');

async function makeService(): Promise<{ dataDir: string; service: McpPluginService }> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-svc-'));
  const service = await McpPluginService.create({ dataDir });
  return { dataDir, service };
}

test('插件服务：安装即连接，启停即时生效，删除后不可用', async () => {
  const { dataDir, service } = await makeService();
  const previous = process.env.BOLE_MCP_CONFIG;
  delete process.env.BOLE_MCP_CONFIG;
  try {
    const plugin = await service.install({
      id: 'echo',
      name: 'Echo 测试服务',
      command: process.execPath,
      args: [fixture],
      allowTools: ['echo:echo', 'echo:im.v1.message.create'],
    });
    assert.equal(plugin.enabled, true);

    const view = await service.view();
    assert.equal(view.enabled, true);
    assert.equal(view.status.tools, 2, 'allowTools 生效');
    assert.equal(view.status.servers[0].state, 'ready');

    const tools = service.managerRef().toolsFor(['*']);
    assert.deepEqual(tools.map((schema) => schema.function.name).sort(), ['mcp__echo__echo', 'mcp__echo__im_v1_message_create']);
    const called = await service.managerRef().callTool('mcp__echo__echo', JSON.stringify({ text: 'hi' }));
    assert.equal(called.message, 'echo:hi');

    const disabled = await service.setEnabled('echo', false);
    assert.equal(disabled.enabled, false);
    const afterDisable = await service.view();
    assert.equal(afterDisable.status.tools, 0);
    assert.equal(service.managerRef().toolsFor(['*']).length, 0);

    await service.setEnabled('echo', true);
    assert.equal((await service.view()).status.tools, 2);

    const tested = await service.test('echo');
    assert.equal(tested.ok, true);
    assert.deepEqual(tested.tools.sort(), ['echo', 'im.v1.message.create']);

    await service.remove('echo');
    const empty = await service.view();
    assert.deepEqual(empty.plugins, []);
    assert.equal(empty.status.tools, 0);
  } finally {
    if (previous !== undefined) process.env.BOLE_MCP_CONFIG = previous;
    await service.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('插件服务：坏插件只标记自己，其它插件照常可用', async () => {
  const { dataDir, service } = await makeService();
  try {
    await service.install({
      id: 'dead',
      name: '坏插件',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      startTimeoutMs: 5000,
    });
    await service.install({
      id: 'echo',
      name: '好插件',
      command: process.execPath,
      args: [fixture],
      allowTools: ['echo:echo'],
    });

    const view = await service.view();
    const dead = view.status.servers.find((server) => server.id === 'dead');
    const echo = view.status.servers.find((server) => server.id === 'echo');
    assert.equal(dead?.state, 'failed');
    assert.ok((dead?.error ?? '').length > 0);
    assert.equal(echo?.state, 'ready');
    assert.equal(view.status.tools, 1);
    assert.equal(view.plugins.length, 2);
  } finally {
    await service.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
