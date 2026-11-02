import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../../src/mcp/manager.ts';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/echo-server.mjs');

interface Harness {
  manager: McpManager;
  cleanup: () => Promise<void>;
}

async function createManager(servers: unknown, defaults?: unknown): Promise<Harness> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-run-'));
  const file = path.join(root, 'mcp.json');
  writeFileSync(file, JSON.stringify({ version: 1, ...(defaults ? { defaults } : {}), servers }), 'utf8');
  const previous = process.env.BOLE_MCP_CONFIG;
  process.env.BOLE_MCP_CONFIG = file;
  const manager = await McpManager.create({ root });
  return {
    manager,
    cleanup: async () => {
      await manager.close();
      if (previous === undefined) delete process.env.BOLE_MCP_CONFIG;
      else process.env.BOLE_MCP_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('连接 stdio 服务：发现工具、按白名单过滤、调用并回灌文本', async () => {
  const { manager, cleanup } = await createManager({
    echo: { command: process.execPath, args: [fixture], startTimeoutMs: 20000 },
  });
  try {
    await manager.start();
    const status = manager.status();
    assert.equal(status.servers[0].state, 'ready');
    assert.equal(status.tools, 4);
    assert.deepEqual(status.servers[0].toolNames.sort(), ['big', 'echo', 'fail', 'im.v1.message.create']);

    const all = manager.toolsFor(['*']);
    assert.equal(all.length, 4);
    assert.ok(all.some((schema) => schema.function.name === 'mcp__echo__im_v1_message_create'));
    assert.equal(manager.toolsFor(['echo:echo']).length, 1);
    assert.equal(manager.toolsFor(['other']).length, 0);
    assert.equal(manager.toolsFor([]).length, 0);

    const echoed = await manager.callTool('mcp__echo__echo', JSON.stringify({ text: 'hi' }));
    assert.equal(echoed.ok, true);
    assert.equal(echoed.message, 'echo:hi');

    const dotted = await manager.callTool('mcp__echo__im_v1_message_create', JSON.stringify({ text: 'yo' }));
    assert.equal(dotted.ok, true);
    assert.equal(dotted.message, 'sent:yo');

    const failed = await manager.callTool('mcp__echo__fail', '{}');
    assert.equal(failed.ok, false);
    assert.equal(failed.message, 'boom');

    const unknown = await manager.callTool('mcp__echo__nope', '{}');
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /未知 MCP 工具/);

    const badJson = await manager.callTool('mcp__echo__echo', '{oops');
    assert.equal(badJson.ok, false);
    assert.match(badJson.message, /不是合法 JSON/);
  } finally {
    await cleanup();
  }
});

test('allowTools 白名单只暴露指定工具', async () => {
  const { manager, cleanup } = await createManager({
    echo: { command: process.execPath, args: [fixture], allowTools: ['echo:echo', 'echo:im.v1.message.create'] },
  });
  try {
    await manager.start();
    assert.equal(manager.status().tools, 2);
    assert.deepEqual(
      manager.toolsFor(['*']).map((schema) => schema.function.name).sort(),
      ['mcp__echo__echo', 'mcp__echo__im_v1_message_create'],
    );
  } finally {
    await cleanup();
  }
});

test('超长工具结果按 maxResultChars 截断', async () => {
  const { manager, cleanup } = await createManager(
    { echo: { command: process.execPath, args: [fixture] } },
    { maxResultChars: 60 },
  );
  try {
    await manager.start();
    const result = await manager.callTool('mcp__echo__big', JSON.stringify({ size: 5000 }));
    assert.equal(result.ok, true);
    assert.equal(result.message.length, 60);
    assert.ok(result.message.endsWith('…'));
  } finally {
    await cleanup();
  }
});

test('单服务启动失败只标记该服务，不影响其它服务', async () => {
  const { manager, cleanup } = await createManager({
    dead: { command: process.execPath, args: ['-e', 'process.exit(1)'], startTimeoutMs: 10000 },
    echo: { command: process.execPath, args: [fixture] },
  });
  try {
    await manager.start();
    const status = manager.status();
    const dead = status.servers.find((server) => server.id === 'dead');
    const echo = status.servers.find((server) => server.id === 'echo');
    assert.equal(dead?.state, 'failed');
    assert.ok((dead?.error ?? '').length > 0);
    assert.equal(echo?.state, 'ready');
    assert.equal(status.tools, 4);
    const failedCall = await manager.callTool('mcp__dead__echo', '{}');
    assert.equal(failedCall.ok, false);
    assert.match(failedCall.message, /未知 MCP 工具/);
  } finally {
    await cleanup();
  }
});

test('enabled=false 不启动，close 不改变禁用状态', async () => {
  const { manager, cleanup } = await createManager({
    off: { command: process.execPath, args: [fixture], enabled: false },
  });
  try {
    await manager.start();
    assert.equal(manager.status().servers[0].state, 'disabled');
    assert.equal(manager.status().tools, 0);
    assert.deepEqual(manager.toolsFor(['*']), []);
  } finally {
    await manager.close();
    assert.equal(manager.status().servers[0].state, 'disabled');
    if (process.env.BOLE_MCP_CONFIG) delete process.env.BOLE_MCP_CONFIG;
  }
});

test('配置整体损坏时降级为空管理器并保留错误', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bole-mcp-bad-'));
  const file = path.join(root, 'mcp.json');
  writeFileSync(file, '{ not json', 'utf8');
  const previous = process.env.BOLE_MCP_CONFIG;
  process.env.BOLE_MCP_CONFIG = file;
  try {
    const manager = await McpManager.create({ root });
    await manager.start();
    const status = manager.status();
    assert.equal(status.tools, 0);
    assert.match(status.configError ?? '', /不是合法 JSON/);
    await manager.close();
  } finally {
    if (previous === undefined) delete process.env.BOLE_MCP_CONFIG;
    else process.env.BOLE_MCP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
