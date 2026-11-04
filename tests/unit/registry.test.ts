import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry, KNOWN_TOOLS } from '../../src/core/registry.ts';

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config');

test('注册表：6 个 preset，工具声明必须真实存在，能力标签独立', () => {
  const registry = AgentRegistry.load();
  const agents = registry.list();
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ['coordinator', 'profiler', 'fetcher', 'parser', 'assessor', 'auditor'],
  );
  for (const agent of agents) {
    for (const tool of agent.tools) assert.ok(KNOWN_TOOLS.has(tool), `${agent.id} 声明了未知工具 ${tool}`);
  }
  const coordinator = registry.get('coordinator');
  assert.ok(coordinator.tools.includes('export_word'));
  assert.ok(!coordinator.tools.includes('dispatch'), '幽灵工具 dispatch 不应再出现');
  assert.ok(!coordinator.tools.includes('delegate_assistant'), '对话不再派生额外子 Agent');
  assert.deepEqual(registry.get('profiler').tools, []);
  assert.ok((registry.get('auditor').capabilities ?? []).includes('span_verify'));
});

test('注册表：声明未实现的工具时启动失败', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bole-registry-'));
  try {
    cpSync(configDir, path.join(root, 'config'), { recursive: true });
    const file = path.join(root, 'config', 'agents.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { agents: { coordinator: { tools: string[] } } };
    config.agents.coordinator.tools.push('phantom_tool');
    writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
    assert.throws(() => AgentRegistry.load(root), /未实现的工具: phantom_tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
