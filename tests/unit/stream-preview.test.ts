import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPreviewer } from '../../src/web/stream-preview.ts';
import type { StreamToken } from '../../src/types.ts';

function token(delta: string, extra: Partial<StreamToken> = {}): StreamToken {
  return {
    type: 'token',
    agent: 'parser',
    taskId: 'task_1',
    phase: 'parse',
    resumeId: 'res_1',
    label: 'R01',
    attempt: 1,
    delta,
    ...extra,
  };
}

function feed(presenter: StreamPreviewer, text: string, extra: Partial<StreamToken> = {}) {
  let preview;
  for (let i = 0; i < text.length; i += 7) {
    preview = presenter.push(token(text.slice(i, i + 7), extra));
  }
  return preview!;
}

test('流式预览：解析 JSON 转成字段，不展示原始 JSON 符号', () => {
  const presenter = new StreamPreviewer();
  const preview = feed(
    presenter,
    JSON.stringify({
      resumeId: 'R01',
      fields: {
        name: { value: '张伟', confidence: 0.95 },
        skills: { value: 'Java, Spring Boot, MySQL', confidence: 0.9 },
        years: { value: '7 年', confidence: 0.8 },
      },
      summary: '7 年后端经验，支付系统背景。',
    }),
  );
  assert.match(preview.title, /R01/);
  const flat = preview.lines.map((line) => `${line.label}=${line.value}`).join('|');
  assert.match(flat, /姓名=张伟/);
  assert.match(flat, /技能=Java/);
  assert.match(flat, /工作年限=7 年/);
  assert.doesNotMatch(flat, /resumeId|fields|confidence|\{|\}/);
});

test('流式预览：评估维度显示为“维度名 + 分数 + 理由”', () => {
  const presenter = new StreamPreviewer();
  const preview = feed(
    presenter,
    JSON.stringify({
      resumeId: 'R01',
      dimensions: [
        { key: 'java', name: 'Java 基础', score: 4, rationale: '有 Spring Boot 项目经验', evidence: [{ field: 'skills', quote: 'Java' }] },
        { key: 'db', name: '数据库', score: 3, rationale: 'MySQL 分库分表经验', evidence: [{ field: 'projects', quote: '分库分表' }] },
      ],
      totalScore: 82,
      conclusion: 'yes',
      uncertainties: ['团队规模未知'],
    }),
    { agent: 'assessor', taskId: 'eval_1', phase: 'deep' },
  );
  const flat = preview.lines.map((line) => `${line.label}=${line.value}`).join('|');
  assert.match(flat, /Java 基础 4\/5=有 Spring Boot 项目经验/);
  assert.match(flat, /数据库 3\/5=MySQL 分库分表经验/);
  assert.match(flat, /总分=82 \/ 100/);
  assert.match(flat, /结论=推荐/);
  assert.doesNotMatch(flat, /dimensions|evidence|\{|\}/);
});

test('流式预览：核查显示裁决与逐条证据，不含 JSON 键名', () => {
  const presenter = new StreamPreviewer();
  const preview = feed(
    presenter,
    JSON.stringify({
      resumeId: 'R01',
      verdict: 're_eval',
      checks: [
        { claim: '主导微服务拆分', verdict: 'supported', note: '原文有主导' },
        { claim: 'QPS 提升 10 倍', verdict: 'unsupported', note: '原文只写提升' },
      ],
      requiredFixes: ['补充 QPS 口径'],
      compliance: { risk: 'low', findings: [] },
    }),
    { agent: 'auditor', taskId: 'review_1', phase: 'review' },
  );
  const flat = preview.lines.map((line) => `${line.label}=${line.value}`).join('|');
  assert.match(flat, /裁决=打回重评/);
  assert.match(flat, /✓ 有据=主导微服务拆分/);
  assert.match(flat, /✗ 无据=QPS 提升 10 倍/);
  assert.match(flat, /需修正=补充 QPS 口径/);
  assert.doesNotMatch(flat, /checks|verdict|compliance|\{|\}/);
});

test('流式预览：换 attempt 时重置缓冲，不把坏 JSON 与重试拼接', () => {
  const presenter = new StreamPreviewer();
  presenter.push(token('{"resumeId":"broken', { attempt: 1 }));
  const preview = feed(
    presenter,
    JSON.stringify({ resumeId: 'R01', fields: { name: { value: '李娜', confidence: 0.9 } } }),
    { attempt: 2 },
  );
  assert.match(preview.lines.map((line) => line.value).join('|'), /李娜/);
});
