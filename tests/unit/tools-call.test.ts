import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool, toolSchemas } from '../../src/tools/tools-call.ts';
import type { ReportData } from '../../src/report/builder.ts';

function sampleReport(): ReportData {
  return {
    job: {
      id: 'job_1',
      title: 'Java 后端工程师',
      requirements: '3-5 年，base 上海',
      jd: {
        title: 'Java 后端工程师',
        responsibilities: [],
        hardRequirements: ['3 年以上 Java 经验'],
        niceToHave: [],
        exclusions: [],
        location: '上海',
        compensation: '30-45k',
        teamContext: '',
      },
      scorecard: { version: '1', dimensions: [{ key: 'java', name: 'Java 深度', weight: 50, anchors: {} }] },
    },
    run: {
      runId: 'run_1',
      status: 'final',
      generatedTs: '2026-01-01T00:00:00.000Z',
      durationMs: 1000,
      provider: 'DeepSeek',
      seed: 'seed',
    },
    top: [
      {
        resumeId: 'R01',
        label: '张三',
        totalScore: 86,
        conclusion: 'yes',
        reason: '核心维度匹配度高',
        batchId: 1,
        dimensions: [{ key: 'java', name: 'Java 深度', weight: 50, score: 90, rationale: '多年 Java 经验。' }],
        evidenceChain: [
          {
            dimension: 'Java 深度',
            field: 'skill',
            quote: '负责电商交易系统的 Java 后端开发',
            charStart: 0,
            charEnd: 16,
            verified: true,
            verdict: 'supported',
            rationale: '直接相关',
          },
        ],
        uncertainties: [],
        redFlags: [],
        anomalies: [],
        evalTier: 'pro',
        evalPhase: 'deep',
        sourceFormat: 'pdf',
        review: { verdict: 'pass', loopCount: 0, compliance: { risk: 'none', findings: [] }, checks: 1, supported: 1 },
      },
    ],
    escalations: [],
    others: [],
    compliance: {
      fairnessRemovals: [],
      fairnessFindings: [],
      piiRedaction: 'PII 已脱敏。',
      duplicates: [],
      failed: [],
      reviewStats: { total: 1, pass: 1, re_eval: 0, escalate: 0, vetoRate: 0 },
      rubberStampWarning: null,
    },
    hitl: [],
    cost: {
      byAgent: [],
      totalCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      baselineCostUsd: 0,
      cacheSavingsUsd: 0,
      cacheHitRate: 0,
      byStage: [],
    },
    pools: [],
    convergence: [],
    eventsCount: 0,
    limitations: ['模型输出可能存在 ±1 分波动。'],
  };
}

test('工具注册表符合 OpenAI Function Calling 格式且包含四个工具', () => {
  const schemas = toolSchemas();
  const names = schemas.map((schema) => schema.function.name).sort();
  assert.deepEqual(names, ['export_word', 'load_workspace_dependencies', 'office_export_pdf', 'python_exec']);
  for (const schema of schemas) {
    assert.equal(schema.type, 'function');
    assert.ok(schema.function.description.length > 10);
    assert.equal(schema.function.parameters.type, 'object');
  }
});

test('export_word 生成合法 docx（PK 魔数）', async () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'bole-tools-'));
  try {
    const result = await executeTool('export_word', '{}', { report: sampleReport(), runDir, dataDir: runDir });
    assert.equal(result.ok, true, result.message);
    const file = path.join(runDir, 'report.docx');
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file).subarray(0, 2).toString(), 'PK');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('office_export_pdf 把 docx 转成合法 pdf；未知工具被拒绝', async (t) => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'bole-tools-'));
  try {
    const unknown = await executeTool('no_such_tool', '{}', { report: sampleReport(), runDir, dataDir: runDir });
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /未知工具/);

    const word = await executeTool('export_word', '{}', { report: sampleReport(), runDir, dataDir: runDir });
    assert.equal(word.ok, true, word.message);
    const pdf = await executeTool('office_export_pdf', '{}', { report: sampleReport(), runDir, dataDir: runDir });
    if (!pdf.ok && /unavailable|LibreOffice/i.test(pdf.message)) {
      t.skip(`本机缺少 LibreOffice 引擎：${pdf.message}`);
      return;
    }
    assert.equal(pdf.ok, true, pdf.message);
    const file = path.join(runDir, 'report.pdf');
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file).subarray(0, 5).toString(), '%PDF-');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
