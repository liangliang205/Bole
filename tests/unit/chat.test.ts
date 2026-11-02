import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Ledger } from '../../src/core/ledger.ts';
import { buildJobChatContext, chatWithJob } from '../../src/chat/service.ts';
import type { LlmRouter } from '../../src/llm/router.ts';
import type { McpManager } from '../../src/mcp/manager.ts';
import type { ReportData } from '../../src/report/builder.ts';

test('面试建议 skill 只在 HR 明确询问时加载', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: '后端工程师', requirements: '3 年后端经验。' });
    const systems: string[] = [];
    const llm = {
      chat: async (req: { system: string }) => {
        systems.push(req.system);
        return { text: '回答', usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 }, stopReason: 'completed', model: 'fake', latencyMs: 1, cacheHit: false };
      },
    } as unknown as LlmRouter;
    await chatWithJob({ job, report: null, ledger, llm, message: '为什么 R08 不推荐？' });
    await chatWithJob({ job, report: null, ledger, llm, message: 'R08 面试应该怎么问？' });
    assert.doesNotMatch(systems[0], /【技能 interview-advice】/);
    assert.match(systems[1], /【技能 interview-advice】/);
  } finally {
    ledger.close();
  }
});

test('对话附件文本进入模型上下文，但客户端只返回附件名', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: '后端工程师', requirements: '3 年后端经验。' });
    const requests: { messages?: { role: string; content: string }[] }[] = [];
    const llm = {
      chat: async (req: { messages?: { role: string; content: string }[] }) => {
        requests.push(req);
        return { text: '已阅读附件', usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 }, stopReason: 'completed', model: 'fake', latencyMs: 1, cacheHit: false };
      },
    } as unknown as LlmRouter;
    const result = await chatWithJob({
      job,
      report: null,
      ledger,
      llm,
      message: '总结附件',
      attachments: [{ name: 'notes.md', text: '# 面试笔记\n\n重点验证项目证据。' }],
    });
    assert.match(String(requests[0].messages?.at(-1)?.content), /面试笔记/);
    assert.equal(result.messages[0].attachments?.[0]?.name, 'notes.md');
    assert.equal(result.messages[0].attachments?.[0]?.text, '');
    assert.match(String(ledger.listChat(job.id)[0].attachments?.[0]?.text), /面试笔记/);
  } finally {
    ledger.close();
  }
});

test('外接 MCP 工具进入主 Agent 工具池，工具调用被路由到 MCP 管理器', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({ title: '后端工程师', requirements: '3 年后端经验。' });
    const requests: { system: string; messages?: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] }[] = [];
    const toolCalls: { name: string; args: string }[] = [];
    const mcp = {
      start: async () => {},
      toolsFor: (patterns: string[]) =>
        patterns.includes('*')
          ? [
              {
                type: 'function',
                function: {
                  name: 'mcp__echo__echo',
                  description: '[MCP:echo] Echo the given text back.',
                  parameters: { type: 'object', properties: { text: { type: 'string' } } },
                },
              },
            ]
          : [],
      callTool: async (name: string, raw: string) => {
        toolCalls.push({ name, args: raw });
        return { ok: true, message: 'echo:hi' };
      },
      status: () => ({
        enabled: true,
        configFile: null,
        tools: 1,
        servers: [{ id: 'echo', transport: 'stdio', enabled: true, state: 'ready', tools: 1, toolNames: ['echo'], description: '' }],
      }),
    } as unknown as McpManager;
    const llm = {
      chat: async (req: { system: string; messages?: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] }) => {
        requests.push(req);
        if (requests.length === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__echo__echo', arguments: '{"text":"hi"}' } }],
            usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 },
            stopReason: 'completed',
            model: 'fake',
            latencyMs: 1,
            cacheHit: false,
          };
        }
        return {
          text: '已调用外部工具',
          usage: { promptTokens: 12, completionTokens: 4, cachedPromptTokens: 0 },
          stopReason: 'completed',
          model: 'fake',
          latencyMs: 1,
          cacheHit: false,
        };
      },
    } as unknown as LlmRouter;
    const report = { top: [], escalations: [], others: [], compliance: { duplicates: [], failed: [] } } as unknown as ReportData;
    const result = await chatWithJob({ job, report, ledger, llm, message: '把结论写进飞书表格', runDir: os.tmpdir(), dataDir: os.tmpdir(), mcp });
    assert.equal(result.answer, '已调用外部工具');
    assert.deepEqual(
      requests[0].tools?.map((tool) => tool.function.name).sort(),
      ['export_word', 'load_workspace_dependencies', 'mcp__echo__echo', 'office_export_pdf', 'python_exec'],
    );
    assert.match(requests[0].system, /【外接工具（MCP）】/);
    assert.deepEqual(toolCalls, [{ name: 'mcp__echo__echo', args: '{"text":"hi"}' }]);
    assert.ok(requests[1].messages?.some((message) => message.role === 'tool' && String(message.content).includes('echo:hi')));
  } finally {
    ledger.close();
  }
});

test('筛选完成后的主 Agent 对话：持久化多轮消息并复用稳定上下文前缀', async () => {
  const ledger = new Ledger(':memory:');
  try {
    const job = ledger.createJob({
      title: '前端工程师',
      requirements: '2 年以上前端经验，熟悉 React/Vue。',
    });
    const requests: { system: string; messages?: { role: string; content: string }[]; user: string; tools?: unknown[] }[] = [];
    const llm = {
      chat: async (req: { system: string; messages?: { role: string; content: string }[]; user: string; tools?: unknown[] }) => {
        requests.push(req);
        return { text: `回答 ${requests.length}`, usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 }, stopReason: 'completed', model: 'fake', latencyMs: 1, cacheHit: false };
      },
    } as unknown as LlmRouter;

    const first = await chatWithJob({ job, report: null, ledger, llm, message: '为什么 R08 不推荐？' });
    assert.equal(first.answer, '回答 1');
    assert.equal(first.messages.length, 2);
    const second = await chatWithJob({ job, report: null, ledger, llm, message: '那双非呢？' });
    assert.equal(second.messages.length, 4);
    assert.equal(requests[0].system, requests[1].system);
    assert.deepEqual(requests[1].messages?.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.match(requests[0].system, /只由你回答/);
    assert.equal(requests[0].tools, undefined, '没有报告时不应向模型暴露导出工具');
    assert.match(buildJobChatContext(job, null), /岗位需求/);
  } finally {
    ledger.close();
  }
});
