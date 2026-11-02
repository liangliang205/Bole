import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/core/ledger.ts';
import { buildJobChatContext, chatWithJob } from '../../src/chat/service.ts';
import type { LlmRouter } from '../../src/llm/router.ts';

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
