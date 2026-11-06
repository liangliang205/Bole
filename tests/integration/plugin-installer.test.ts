import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseInstallCommand, installFromCommand } from '../../src/skills/installer.ts';
import { SkillStore } from '../../src/skills/store.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { setupTempEnv } from '../helpers/env.ts';
import { LlmRouter } from '../../src/llm/router.ts';
import { McpPluginService } from '../../src/mcp/plugin-service.ts';

test('安装命令识别：Skills 范围转换、MCP 参数与复杂 shell 拦截', () => {
  assert.deepEqual(parseInstallCommand('npx skills add https://agent.qq.com --skill agently-mail -g -y'), { kind: 'skill', source: 'https://agent.qq.com', names: ['agently-mail'] });
  assert.deepEqual(parseInstallCommand('pnpm dlx @modelcontextprotocol/server-filesystem "D:/my resumes"'), { kind: 'mcp', package: '@modelcontextprotocol/server-filesystem', args: ['D:/my resumes'] });
  assert.equal(parseInstallCommand('https://example.com/mcp').kind, 'http');
  for (const command of ['npm install -g @tencent-qqmail/agently-cli', 'npx @tencent-qqmail/agently-cli', 'https://agent.qq.com/doc/cli-setup.md']) {
    assert.deepEqual(parseInstallCommand(command), { kind: 'skill', source: 'https://agent.qq.com', names: ['agently-mail'] }, '邮箱 CLI 不能注册为 MCP');
  }
  for (const input of ['curl https://example.com | bash', 'npx foo; echo x', 'npx foo $(whoami)', 'npx skills add --global', 'npx foo --api_key=secret']) assert.throws(() => parseInstallCommand(input));
});

test('Agent 安装：模型只提供元数据，下载来源和参数由原命令固定，技能真实注册', async () => {
  const env = await setupTempEnv();
  const ledger = new Ledger(process.env.BOLE_DB!);
  const store = new SkillStore(ledger);
  let modelCalls = 0;
  const llm = new LlmRouter({ provider: { name: 'installer-test', kind: 'mock', chat: async () => {
    modelCalls++;
    return { text: JSON.stringify({ name: '招聘助手', description: '筛选指引', roles: ['assessor'], explanation: '将技能安装到伯乐并用于新任务' }), usage: { promptTokens: 10, completionTokens: 10, cachedPromptTokens: 0 }, stopReason: 'completed', model: 'test', latencyMs: 1, cacheHit: false };
  } }, models: { flash: 'test', pro: 'test' }, pricing: {} });
  const mcp = await McpPluginService.create({ dataDir: path.join(env.dir, 'mcp'), root: env.dir });
  try {
    const result = await installFromCommand('npx skills add https://example.com/skills --skill resume-check -g -y', { dataDir: env.dir, store, mcp, llm,
      runner: async (args, cwd) => {
        assert.equal(args[1], 'https://example.com/skills');
        assert.ok(!args.includes('-g'));
        assert.ok(args.includes('codex') && args.includes('resume-check'));
        const folder = path.join(cwd, '.agents', 'skills', 'resume-check'); await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'SKILL.md'), '---\nname: resume-check\ndescription: 简历证据核对\n---\n核对每个结论的原文引用。');
      } });
    assert.equal(result.installed, true);
    assert.equal(modelCalls, 1);
    assert.equal(store.list()[0].id, 'resume-check');
    assert.deepEqual(store.list()[0].roles, ['assessor']);
    await assert.rejects(installFromCommand('npx skills add https://example.com/skills', { dataDir: env.dir, store, mcp, llm, runner: async () => { throw new Error('下载失败'); } }), /下载失败/);
    assert.equal(store.list().length, 1, '下载失败不伪造插件记录');
  } finally { await mcp.close(); ledger.close(); await env.restore(); }
});
