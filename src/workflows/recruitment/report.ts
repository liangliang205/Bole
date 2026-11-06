import { z } from 'zod';
import type { AgentDeps } from '../../agents/deps.ts';
import type { PipelineRunOptions, RunSummary } from '../../agents/coordinator.ts';
import { buildReport, selectTopCandidates, type ReportData } from '../../report/builder.ts';
import { writeReports } from '../../report/render.ts';
import { loadJobAnalysis } from '../../agents/data.ts';
import { nodeExecution } from '../../scheduler/context.ts';

export const poolSchema = z.object({ name: z.string(), capacity: z.number(), active: z.number(), peak: z.number(), acquired: z.number(), refused: z.number(), released: z.number(), timeouts: z.number() });
export const publicationSchema = z.object({ report: z.json(), strict: z.boolean(), startedMs: z.number(), pools: z.array(poolSchema) });
export type Publication = z.infer<typeof publicationSchema>;
export const summarySchema: z.ZodType<RunSummary> = z.object({
  jobId: z.string(), runId: z.string(), runDir: z.string(), status: z.string(), counts: z.record(z.string(), z.number()),
  selfLoop: z.object({ revisions: z.number(), escalations: z.number() }), pools: z.array(poolSchema),
  top: z.array(z.object({ label: z.string(), totalScore: z.number(), conclusion: z.string() })),
  reports: z.object({ markdown: z.string(), json: z.string(), cost: z.string(), convergence: z.string() }),
  usage: z.object({ calls: z.number(), promptTokens: z.number(), completionTokens: z.number(), cachedTokens: z.number(), costUsd: z.number(), cacheHitRate: z.number() }), durationMs: z.number(),
});
export function assertScreeningComplete(deps: Pick<AgentDeps, 'ledger' | 'jobId'>): void {
  const unfinished = deps.ledger.listResumes(deps.jobId).filter((r) => !['verified', 'reported', 'quarantine', 'failed', 'duplicate'].includes(r.status));
  if (unfinished.length) throw new Error(`筛选尚未完成：${unfinished.length} 份材料仍待处理（${unfinished.map((r) => `${r.label}: ${r.status}`).join('、')}），禁止发布候选人结论`);
}
export async function prepareReport(deps: AgentDeps, pools: Publication['pools'], startedMs: number, strict: boolean): Promise<Publication> {
  assertScreeningComplete(deps);
  const analysis = loadJobAnalysis(deps.ledger.getJob(deps.jobId)!)!;
  const report = await buildReport(deps, analysis, { pools, startedMs, topN: deps.config.topN, interviewPlans: new Map(), status: 'draft' });
  return { report: JSON.parse(JSON.stringify(report)) as Publication['report'], pools, startedMs, strict };
}
export async function publishReport(deps: AgentDeps, opts: PipelineRunOptions, input: Publication): Promise<RunSummary> {
  assertScreeningComplete(deps);
  const reportData = input.report as unknown as ReportData;
  const verified = deps.ledger.listResumes(deps.jobId).filter((r) => r.status === 'verified');
  const prior = deps.ledger.listDecisions(deps.jobId).find((d) => d.node === 'final_confirmation');
  const confirmation = prior ? { answer: prior.answer, actor: prior.actor } : input.strict
    ? { answer: '确认输出终稿（严格审批通过）', actor: 'approval' }
    : await opts.hitl.ask({ id: 'final_report', node: 'final_confirmation',
      question: `已生成 Top${deps.config.topN} 推荐、证据链与合规报告（${verified.length} 人核查通过，${deps.ledger.selfLoopStats(deps.jobId).escalations} 人转人工）。是否确认输出终稿？`,
      options: ['确认输出终稿（推荐）', '保存为草稿，需 HR 修改'], recommendedOption: '确认输出终稿（推荐）', blocking: true });
  if (!prior) deps.ledger.addDecision({ jobId: deps.jobId, node: 'final_confirmation', question: '是否确认输出终稿', answer: confirmation.answer, actor: confirmation.actor });
  deps.events.emit(deps.jobId, 'coordinator', 'hitl.final_confirmation', { answer: confirmation.answer, actor: confirmation.actor });
  const finalStatus = /确认输出/.test(confirmation.answer) ? 'final' : 'draft';
  reportData.run.status = finalStatus;
  const reports = await writeReports(reportData, deps.runDir);
  nodeExecution.getStore()?.assertOwner();
  deps.ledger.setJobStatus(deps.jobId, finalStatus === 'final' ? 'completed' : 'draft');
  if (finalStatus === 'final') for (const resume of verified) deps.ledger.setResumeStatus(resume.id, 'reported');
  deps.events.emit(deps.jobId, 'coordinator', 'report.generated', { status: finalStatus, top: reportData.top.map((c) => `${c.label}:${c.totalScore}`), reports });
  const calls = deps.llm.calls;
  const promptTokens = calls.reduce((n, c) => n + c.promptTokens, 0);
  const cachedTokens = calls.reduce((n, c) => n + c.cachedPromptTokens, 0);
  const summary: RunSummary = { jobId: deps.jobId, runId: deps.runId, runDir: deps.runDir, status: finalStatus,
    counts: deps.ledger.resumeCounts(deps.jobId), selfLoop: deps.ledger.selfLoopStats(deps.jobId), pools: input.pools,
    top: selectTopCandidates(deps.ledger, deps.jobId, deps.config.topN).map((c) => ({ label: c.label, totalScore: c.totalScore, conclusion: c.conclusion })), reports,
    usage: { calls: calls.length, promptTokens, completionTokens: calls.reduce((n, c) => n + c.completionTokens, 0), cachedTokens,
      costUsd: Number(calls.reduce((n, c) => n + c.costUsd, 0).toFixed(6)), cacheHitRate: promptTokens ? Number((cachedTokens / promptTokens).toFixed(3)) : 0 }, durationMs: Date.now() - input.startedMs };
  deps.events.emit(deps.jobId, 'coordinator', 'run.completed', { status: finalStatus, resumeCounts: summary.counts, durationMs: summary.durationMs, usage: summary.usage, pools: summary.pools });
  return summary;
}
