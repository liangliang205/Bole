import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowsTool,
  dedupeToolName,
  isMcpToolName,
  mcpToolName,
  sanitizeFragment,
  toOpenAiToolSchema,
} from '../../src/mcp/schema.ts';

test('工具名清洗：点号变下划线、最长 64 字符、稳定可反查', () => {
  assert.equal(mcpToolName('lark', 'im.v1.message.create'), 'mcp__lark__im_v1_message_create');
  assert.equal(sanitizeFragment('a b/c'), 'a_b_c');
  assert.equal(sanitizeFragment('!!!'), 'x');

  const longTool = 'x'.repeat(80);
  const first = mcpToolName('server', longTool);
  assert.equal(first.length, 64);
  assert.equal(mcpToolName('server', longTool), first);
  assert.notEqual(mcpToolName('server', `${longTool}y`), first);
  assert.equal(isMcpToolName(first), true);
  assert.equal(isMcpToolName('export_word'), false);
});

test('同一服务内重名工具会得到不同名字', () => {
  const used = new Set<string>();
  const a = dedupeToolName(used, 'srv', 'a.b');
  const b = dedupeToolName(used, 'srv', 'a b');
  assert.notEqual(a, b);
  assert.equal(a.length <= 64 && b.length <= 64, true);
});

test('输入 schema 规整：去掉 $schema/$id、强制 object、补 properties', () => {
  const schema = toOpenAiToolSchema('srv', {
    name: 'search',
    description: '搜索',
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', $id: 'x', properties: { q: { type: 'string' } } },
  });
  assert.equal(schema.function.name, 'mcp__srv__search');
  assert.match(schema.function.description, /\[MCP:srv\] 搜索/);
  assert.equal(schema.function.parameters.type, 'object');
  assert.equal(schema.function.parameters.$schema, undefined);
  assert.equal(schema.function.parameters.$id, undefined);
  assert.deepEqual(schema.function.parameters.properties, { q: { type: 'string' } });

  const empty = toOpenAiToolSchema('srv', { name: 'noop', inputSchema: 'not-an-object' });
  assert.deepEqual(empty.function.parameters, { type: 'object', properties: {} });
});

test('白名单匹配：* / server / server:tool / server:* / *:tool', () => {
  assert.equal(allowsTool(['*'], 'lark', 'im.v1.message.create'), true);
  assert.equal(allowsTool(['lark'], 'lark', 'anything'), true);
  assert.equal(allowsTool(['lark:im.v1.message.create'], 'lark', 'im.v1.message.create'), true);
  assert.equal(allowsTool(['lark:im.v1.message.create'], 'lark', 'bitable.v1.app.create'), false);
  assert.equal(allowsTool(['lark:*'], 'lark', 'bitable.v1.app.create'), true);
  assert.equal(allowsTool(['*:echo'], 'fs', 'echo'), true);
  assert.equal(allowsTool([], 'fs', 'echo'), false);
  assert.equal(allowsTool(['fs'], 'lark', 'echo'), false);
});
