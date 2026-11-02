import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { executeTool, toolSchemas, toolSchemasWithMcp } from '../../src/tools/tools-call.ts';
import type { McpManager } from '../../src/mcp/manager.ts';
import type { OpenAiToolSchema } from '../../src/types.ts';
import type { ReportData } from '../../src/report/builder.ts';

/** 只实现 MCP 路由需要的两个方法，避免测试真的拉起进程。 */
function stubManager(overrides: Partial<Record<keyof McpManager, unknown>> = {}): McpManager {
  return {
    callTool: async (name: string, raw: string) => ({ ok: true, message: `${name}|${raw}` }),
    toolsFor: () => [] as OpenAiToolSchema[],
    ...overrides,
  } as unknown as McpManager;
}

const ctx = {
  report: {} as ReportData,
  runDir: os.tmpdir(),
  dataDir: os.tmpdir(),
};

test('mcp__ 前缀的工具被路由到 MCP 管理器', async () => {
  const result = await executeTool('mcp__x__y', '{"a":1}', { ...ctx, mcp: stubManager() });
  assert.equal(result.ok, true);
  assert.equal(result.message, 'mcp__x__y|{"a":1}');
});

test('未启用 MCP 时给出明确错误，而不是“未知工具”', async () => {
  const result = await executeTool('mcp__x__y', '{}', ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /未启用外接 MCP/);
});

test('内置工具的行为不受影响', async () => {
  const result = await executeTool('no_such_tool', '{}', { ...ctx, mcp: stubManager() });
  assert.equal(result.ok, false);
  assert.match(result.message, /未知工具：no_such_tool/);
  assert.equal(toolSchemas().length, 4);
});

test('toolSchemasWithMcp 合并内置与外接工具；未配置时只有内置', () => {
  const remote: OpenAiToolSchema = {
    type: 'function',
    function: { name: 'mcp__x__y', description: '外部工具', parameters: { type: 'object', properties: {} } },
  };
  const manager = stubManager({ toolsFor: (patterns: string[]) => (patterns.includes('*') ? [remote] : []) });
  assert.deepEqual(toolSchemasWithMcp(undefined, ['*']).map((schema) => schema.function.name), toolSchemas().map((schema) => schema.function.name));
  assert.equal(toolSchemasWithMcp(manager, []).length, 4);
  assert.equal(toolSchemasWithMcp(manager, ['*']).length, 5);
});
