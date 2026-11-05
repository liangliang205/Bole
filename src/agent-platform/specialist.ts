import { readFile } from 'node:fs/promises';
import { AgentStore } from './store.ts';
import { findingsSchema } from './catalog.ts';
import { callAgentJson } from '../agents/structured-call.ts';
import type { AgentDeps } from '../agents/deps.ts';
import { systemPrompt } from '../agents/prompts.ts';
import { resolveRawSpans } from '../util/text.ts';
import { memoryHash } from '../memory/service.ts';
import { roleKnowledge } from '../agents/knowledge.ts';

export async function runSpecialist(deps: AgentDeps, resumeId: string): Promise<void> {
  const store = new AgentStore(deps.ledger);
  const binding = store.manifest(deps.jobId)?.bindings.specialist;
  if (!binding) return;
  store.assertUsable(binding);
  const resume = deps.ledger.getResume(resumeId);
  if (!resume || resume.job_id !== deps.jobId || !resume.norm_path) throw new Error('专职检查仅可读取当前任务候选人');
  const text = await readFile(resume.norm_path, 'utf8');
  const hash = memoryHash(text);
  const old = deps.ledger.db.prepare('SELECT document_hash FROM specialist_results WHERE job_id=? AND resume_id=? AND version_key=?').get(deps.jobId, resumeId, binding.key);
  if (old?.document_hash === hash) return;
  const result = await callAgentJson(deps, { agent: 'specialist', tier: binding.definition.tier,
    schemaName: 'specialist_findings', schema: findingsSchema,
    system: systemPrompt(deps, 'specialist') + '\n只检查当前候选人；输出不得改变评分卡、自动淘汰或代替核查。所有非空发现必须有原文证据。',
    user: `【岗位】${deps.ledger.getJob(deps.jobId)?.requirements}\n【候选人原文】${text}${await roleKnowledge(deps, 'specialist', deps.ledger.getJob(deps.jobId)?.requirements ?? '')}`,
    phase: 'specialist-check', resumeId, meta: { jobId: deps.jobId, resumeId },
    postValidate: (value) => {
      try { return value.findings.flatMap((finding) => resolveRawSpans(text, finding.evidence, finding.code).errors); }
      catch (error) { return [String(error)]; }
    } });
  if (!result.ok) throw new Error(`专职检查失败：${result.errors.join('；')}`);
  const output = { findings: result.value.findings.map(({ evidence, ...finding }) => ({ ...finding, spans: resolveRawSpans(text, evidence, finding.code).spans })) };
  deps.ledger.db.prepare('INSERT OR REPLACE INTO specialist_results VALUES (?,?,?,?,?,?)').run(deps.jobId, resumeId, binding.key, JSON.stringify(output), hash, new Date().toISOString());
  deps.events.emit(deps.jobId, binding.definition.id, 'specialist.completed', { resumeId, agentVersion: binding.key, findings: output.findings.length, documentHash: hash });
}

export function specialistReference(deps: AgentDeps, resumeId: string): string {
  const binding = new AgentStore(deps.ledger).manifest(deps.jobId)?.bindings.specialist;
  if (!binding) return '';
  const row = deps.ledger.db.prepare('SELECT result_json FROM specialist_results WHERE job_id=? AND resume_id=? AND version_key=?').get(deps.jobId, resumeId, binding.key);
  return row ? `\n【专职检查参考：非权威结论，须根据原文自行核验，不得覆盖评分标准】${String(row.result_json)}` : '';
}
