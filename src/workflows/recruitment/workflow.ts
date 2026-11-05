import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runSpecialist } from '../../agent-platform/specialist.ts';
import { MemoryService } from '../../memory/service.ts';
import { ApprovalStore } from '../../core/approvals.ts';
import { CapacityPool, withAgentSlot, admissionOptions } from '../../core/pool.ts';
import { chunk } from '../../core/pipeline.ts';
import { loadPrompt, loadSkill } from '../../config.ts';
import { writeJson } from '../../util/fsx.ts';
import { runProfiler, buildProfileSearchQuery } from '../../agents/profiler.ts';
import { runFetcher } from '../../agents/fetcher.ts';
import { planScreening } from '../../agents/planner.ts';
import { ParserWorker } from '../../agents/parser.ts';
import { AssessorWorker } from '../../agents/assessor.ts';
import { AuditorWorker } from '../../agents/auditor.ts';
import { loadJobAnalysis, loadParseResult, loadLatestEval, loadLatestReview } from '../../agents/data.ts';
import { screeningPlanSchema } from '../../schemas.ts';
import type { AgentDeps } from '../../agents/deps.ts';
import type { PipelineRunOptions } from '../../agents/coordinator.ts';
import type { RatingThresholds } from '../../tools/scorecard.ts';
import { defineWorkflow, task, sequence, retain, parallel, condition, loop, subworkflow, approval, WorkflowRegistry } from '../../workflow/index.ts';
import type { Node, Outcome } from '../../workflow/index.ts';
import { publicationSchema, summarySchema, prepareReport, publishReport } from './report.ts';

export const RECRUITMENT_KEY = 'recruitment@1.0.0';
const inputSchema = z.object({ requirements: z.string(), files: z.array(z.object({ uploadId: z.string(), filename: z.string(), path: z.string(), size: z.number(), contentType: z.string() })), resumeOnly: z.boolean(), config: z.json() });
const planSchema = screeningPlanSchema.extend({ source: z.enum(['agent', 'fallback']) });
const preparedSchema = z.object({ plan: planSchema, resumeIds: z.array(z.string()), startedMs: z.number(), strict: z.boolean() });
type Prepared = z.infer<typeof preparedSchema>;
const candidateSchema = z.object({ resumeId: z.string(), batchId: z.number(), prepared: preparedSchema });
const evalSchema = candidateSchema.extend({ evalTaskId: z.string(), evalTier: z.enum(['flash', 'pro']), evalPhase: z.enum(['screen', 'deep', 'revise']), loopIndex: z.number().int(), verdict: z.enum(['pass', 're_eval', 'escalate_human']).nullable(), reviewTaskId: z.string().nullable() });
type Evaluated = z.infer<typeof evalSchema>;
const batchSchema = z.object({ batchId: z.number(), resumeIds: z.array(z.string()), prepared: preparedSchema, parsed: z.array(candidateSchema), screened: z.array(evalSchema), shortlist: z.array(z.string()) });
type Batch = z.infer<typeof batchSchema>;
const resultSchema = z.object({ resumeId: z.string(), status: z.string(), score: z.number(), tier: z.enum(['flash', 'pro']), phase: z.enum(['screen', 'deep', 'revise']) });
const batchResultSchema = z.object({ batchId: z.number(), parsed: z.number(), evaluated: z.number() });
function outcomeSchema<T>(value: z.ZodType<T>): z.ZodType<Outcome<T>> { return z.union([z.object({ key: z.string(), ok: z.literal(true), value }), z.object({ key: z.string(), ok: z.literal(false), error: z.string() })]); }
function identity<T>(id: string, schema: z.ZodType<T>): Node<T, T> { return task({ id, input: schema, output: schema, recovery: 'retry', handler: (v) => v }); }

/** Trusted source modules, including imported business handlers, are fingerprinted. */
function implementationHash(): string {
  const files = ['./workflow.ts', './report.ts', '../../agents/coordinator.ts', '../../agents/profiler.ts', '../../agents/fetcher.ts', '../../agents/parser.ts', '../../agents/assessor.ts', '../../agents/auditor.ts', '../../agents/planner.ts', '../../agents/data.ts', '../../agent-platform/specialist.ts', '../../core/structured.ts', '../../workflow/builders.ts', '../../workflow/engine.ts'];
  return createHash('sha256').update(files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')).digest('hex');
}
export function recruitmentRegistry(deps: AgentDeps, opts: PipelineRunOptions): WorkflowRegistry {
  const implementation = implementationHash();
  const registry = new WorkflowRegistry();
  const approvals = new ApprovalStore(deps.ledger);
  let pools: { parse: CapacityPool; assess: CapacityPool; review: CapacityPool; agents: CapacityPool } | undefined;
  const capacity = (prepared: Prepared) => pools ??= { parse: new CapacityPool('parse', prepared.plan.pools.parse), assess: new CapacityPool('assess', prepared.plan.pools.assess), review: new CapacityPool('review', prepared.plan.pools.review), agents: new CapacityPool('agents', prepared.plan.maxActiveAgents) };
  const stats = (prepared: Prepared) => Object.values(capacity(prepared)).map((p) => p.stats());
  const slot = <T>(prepared: Prepared, role: 'parse' | 'assess' | 'review', label: string, run: () => Promise<T>) => withAgentSlot(capacity(prepared).agents, capacity(prepared)[role], label, admissionOptions(deps.config.admission), run);
  const analysis = () => { const value = loadJobAnalysis(deps.ledger.getJob(deps.jobId)!); if (!value) throw new Error('岗位画像缺失'); return value; };
  const assessor = (prepared: Prepared) => {
    const profile = analysis(); const binding = new MemoryService(deps.ledger).binding(deps.jobId);
    return new AssessorWorker(deps, capacity(prepared).assess.stats().acquired + 1, { jd: profile.jd, scorecard: profile.scorecard, thresholds: (binding ? JSON.parse(binding.snapshot_json).thresholds : deps.config.conclusionScale) as RatingThresholds, knowledgeQuery: buildProfileSearchQuery(profile) });
  };
  const parsed = (resumeId: string) => { const value = loadParseResult(deps.ledger, resumeId); if (!value) throw new Error('解析结果缺失'); return value; };
  const resume = (id: string) => { const value = deps.ledger.getResume(id); if (!value) throw new Error(`简历不存在：${id}`); return value; };
  const emit = (type: string, data: Record<string, unknown>) => deps.events.emit(deps.jobId, 'coordinator', type, data);
  const restoreStage = (id: string, target: 'queued' | 'parsed' | 'evaluated') => {
    const current = resume(id);
    if (['parsing', 'evaluating', 'verifying', 'failed'].includes(current.status)) deps.ledger.forceResumeStatus(id, target, 'workflow checkpoint recovery');
  };

  const profile = task({ id: 'profile', input: inputSchema, output: inputSchema, recovery: 'retry', handler: async (input) => {
    if (!loadJobAnalysis(deps.ledger.getJob(deps.jobId)!)) await runProfiler(deps, { jobId: deps.jobId, requirements: input.requirements, hitl: opts.hitl });
    const value = analysis(); const memory = new MemoryService(deps.ledger); const binding = memory.binding(deps.jobId);
    const thresholds = binding ? JSON.parse(binding.snapshot_json).thresholds : deps.config.conclusionScale;
    memory.bindJob(deps.jobId, { jd: value.jd, scorecard: value.scorecard, thresholds }, binding?.version_id ?? null);
    return input;
  } });
  const ingest = task({ id: 'ingest', input: inputSchema, output: inputSchema, recovery: 'retry', handler: async (input) => {
    if (!input.resumeOnly) {
      if (!input.files.length) throw new Error('请至少上传一份简历（支持 PDF / DOCX / 图片 / 文本）');
      await runFetcher(deps, { files: input.files });
      if (!deps.ledger.listResumes(deps.jobId).some((r) => !['failed', 'duplicate'].includes(r.status))) throw new Error('所有简历均未能接入（无可用简历）');
    }
    return input;
  } });
  const plan = task({ id: 'plan', input: inputSchema, output: preparedSchema, recovery: 'retry', handler: async (input) => {
    const resumes = deps.ledger.listResumes(deps.jobId); const counts = deps.ledger.resumeCounts(deps.jobId); const formats: Record<string, number> = {};
    resumes.forEach((r) => { formats[r.format || 'unknown'] = (formats[r.format || 'unknown'] ?? 0) + 1; });
    const resumeIds = resumes.filter((r) => ['queued', 'parsed'].includes(r.status)).map((r) => r.id);
    const saved = approvals.list(deps.jobId).find((a) => a.kind === 'screening-plan');
    const selected = saved ? JSON.parse(saved.payload_json).plan as Prepared['plan'] : await planScreening(deps, {
      usable: resumeIds.length, duplicates: counts.duplicate ?? 0, failed: counts.failed ?? 0, formats, resumeOnly: input.resumeOnly,
      defaults: { batchSize: deps.config.batchSize, maxBatchesInFlight: deps.config.maxBatchesInFlight, maxActiveAgents: deps.config.maxActiveAgents, pools: deps.config.pools, deepEval: { enabled: deps.config.deepEval.enabled, percent: deps.config.deepEval.percent } },
    });
    const artifact = path.join(deps.runDir, 'artifacts', 'plan', 'screening_plan.json'); await writeJson(artifact, { ...selected, inventory: { usable: resumeIds.length, formats } });
    emit('screening.plan', { ...selected, usable: resumeIds.length, artifact });
    emit('pipeline.started', { resumes: resumes.length, workItems: resumeIds.length, ...selected, pools: { ...selected.pools, agents: selected.maxActiveAgents }, planSource: selected.source, resumeOnly: input.resumeOnly });
    return { plan: selected, resumeIds, startedMs: Date.now(), strict: approvals.mode(deps.jobId) === 'strict' };
  } });
  const planApproval = condition('approve-plan-if-strict', { test: (v: Prepared) => v.strict,
    then: approval('approve-plan', { title: '批准筛选计划', kind: 'screening-plan', input: preparedSchema, payload: (v) => ({ plan: v.plan, ...analysis(), registry: deps.registry.fingerprint, revisionBudget: deps.config.selfLoop,
      materials: deps.ledger.listResumes(deps.jobId).map((r) => ({ id: r.id, sha256: r.sha256 })),
      promptHash: createHash('sha256').update(deps.registry.list().map((p) => loadPrompt(p, deps.paths)).join('\n') + loadSkill('screening-plan', deps.paths)).digest('hex'), scope: '本岗位材料的解析、初筛、深评、核查及预算内重评；外部工具另行审批。' }) }),
    otherwise: identity('plan-approved-by-policy', preparedSchema) });

  const parse = task({ id: 'parse', input: candidateSchema, output: candidateSchema, recovery: 'retry', handler: async (item) => {
    if (loadParseResult(deps.ledger, item.resumeId)) { emit('parse.reused', { resumeId: item.resumeId, label: resume(item.resumeId).label, batchId: item.batchId }); return item; }
    restoreStage(item.resumeId, 'queued');
    const worker = new ParserWorker(deps, capacity(item.prepared).parse.stats().acquired + 1);
    const result = await slot(item.prepared, 'parse', `parse:${item.resumeId}`, () => worker.parse({ resume: resume(item.resumeId), batchId: item.batchId }));
    if (!result.ok) throw new Error(`解析失败：${result.errors.join('；')}`);
    parsed(item.resumeId); return item;
  } });
  const screen = task({ id: 'screen', input: candidateSchema, output: evalSchema, recovery: 'retry', handler: async (item) => {
    await slot(item.prepared, 'assess', `specialist:${item.resumeId}`, () => runSpecialist(deps, item.resumeId));
    let prior = loadLatestEval(deps.ledger, item.resumeId);
    if (!prior || prior.task.phase !== 'screen') {
      restoreStage(item.resumeId, 'parsed');
      const worker = assessor(item.prepared);
      const result = await slot(item.prepared, 'assess', `screen:${item.resumeId}`, () => worker.evaluate({ resume: resume(item.resumeId), parsed: parsed(item.resumeId), batchId: item.batchId, loopIndex: 0, tier: deps.registry.get('assessor').tier, phase: 'screen' }));
      if (!result.ok) throw new Error(`初筛评估失败：${result.errors.join('；')}`);
      prior = loadLatestEval(deps.ledger, item.resumeId);
    }
    if (!prior) throw new Error('初筛未提交');
    return { ...item, evalTaskId: prior.task.id, evalTier: prior.task.tier as Evaluated['evalTier'], evalPhase: 'screen' as const, loopIndex: 0, verdict: null, reviewTaskId: null };
  } });
  const deep = task({ id: 'deep-evaluate', input: evalSchema, output: evalSchema, recovery: 'retry', handler: async (item) => {
    let prior = loadLatestEval(deps.ledger, item.resumeId);
    if (!prior || prior.task.phase !== 'deep') {
      restoreStage(item.resumeId, 'evaluated');
      const worker = assessor(item.prepared);
      const result = await slot(item.prepared, 'assess', `deep:${item.resumeId}`, () => worker.evaluate({ resume: resume(item.resumeId), parsed: parsed(item.resumeId), batchId: item.batchId, loopIndex: 0, tier: deps.config.deepEval.tier, phase: 'deep' }));
      if (!result.ok) { emit('deep_eval.failed', { resumeId: item.resumeId, label: resume(item.resumeId).label, batchId: item.batchId, errors: result.errors, fallback: 'flash' }); return item; }
      prior = loadLatestEval(deps.ledger, item.resumeId);
    }
    if (!prior) throw new Error('深评未提交');
    emit('deep_eval.completed', { resumeId: item.resumeId, label: resume(item.resumeId).label, batchId: item.batchId, totalScore: prior.evaluation.totalScore, tier: deps.config.deepEval.tier, evalTaskId: prior.task.id });
    return { ...item, evalTaskId: prior.task.id, evalTier: deps.config.deepEval.tier, evalPhase: 'deep' };
  } });
  const revise = task({ id: 'revise', input: evalSchema, output: evalSchema, recovery: 'retry', handler: async (item) => {
    const feedback = loadLatestReview(deps.ledger, item.resumeId);
    if (!feedback || feedback.task.id !== item.reviewTaskId) throw new Error('核查反馈版本不一致');
    let prior = loadLatestEval(deps.ledger, item.resumeId);
    if (!prior || prior.task.revision_of !== item.evalTaskId) {
      restoreStage(item.resumeId, 'evaluated');
      const worker = assessor(item.prepared);
      emit('selfloop.revise', { resumeId: item.resumeId, label: resume(item.resumeId).label, loop: item.loopIndex + 1, workerId: worker.workerId, fixes: feedback.review.requiredFixes.length, tier: item.evalTier });
      const result = await slot(item.prepared, 'assess', `revise:${item.resumeId}`, () => worker.revise({ resume: resume(item.resumeId), parsed: parsed(item.resumeId), batchId: item.batchId, loopIndex: item.loopIndex + 1, feedback: feedback.review, revisionOf: item.evalTaskId, tier: item.evalTier, phase: 'revise' }));
      if (!result.ok) throw new Error(`重评失败：${result.errors.join('；')}`);
      prior = loadLatestEval(deps.ledger, item.resumeId);
    }
    if (!prior) throw new Error('重评未提交');
    return { ...item, evalTaskId: prior.task.id, evalPhase: 'revise' as const, loopIndex: item.loopIndex + 1, verdict: null };
  } });
  const review = task({ id: 'review', input: evalSchema, output: evalSchema, recovery: 'retry', handler: async (item) => {
    let prior = loadLatestReview(deps.ledger, item.resumeId);
    if (!prior || prior.task.eval_task_id !== item.evalTaskId) {
      const evaluation = loadLatestEval(deps.ledger, item.resumeId);
      if (!evaluation || evaluation.task.id !== item.evalTaskId) throw new Error('待核查评估版本不一致');
      restoreStage(item.resumeId, 'evaluated');
      const worker = new AuditorWorker(deps, capacity(item.prepared).review.stats().acquired + 1);
      const result = await slot(item.prepared, 'review', `review:${item.resumeId}`, () => worker.review({ resume: resume(item.resumeId), parsed: parsed(item.resumeId), evaluation: evaluation.evaluation, evalTaskId: item.evalTaskId, batchId: item.batchId, loopCount: item.loopIndex, maxLoops: deps.config.selfLoop.maxLoops }));
      if (!result.ok) throw new Error(`核查失败：${result.errors.join('；')}`);
      prior = loadLatestReview(deps.ledger, item.resumeId);
    }
    if (!prior) throw new Error('核查未提交');
    return { ...item, verdict: prior.review.verdict, reviewTaskId: prior.task.id };
  } });
  const iteration = sequence('review-iteration', condition('needs-revision', { test: (v: Evaluated) => v.verdict === 're_eval', then: revise, otherwise: identity('no-revision', evalSchema) }), review);
  const verification = loop('verify-correct-loop', { body: iteration, until: (v) => v.verdict !== 're_eval', maxIterations: deps.config.selfLoop.maxLoops + 1 });
  const loopSchema = z.object({ status: z.enum(['completed', 'exhausted']), iterations: z.number(), value: evalSchema });
  const finish = task({ id: 'finish-candidate', input: loopSchema, output: resultSchema, recovery: 'retry', handler: (value) => {
    const item = value.value; const evaluation = loadLatestEval(deps.ledger, item.resumeId);
    const status = value.status === 'completed' && item.verdict === 'pass' ? 'verified' : 'escalated';
    if (value.status === 'exhausted' && resume(item.resumeId).status !== 'quarantine') deps.ledger.forceResumeStatus(item.resumeId, 'quarantine', '工作流核查循环次数耗尽，转人工');
    const result = { resumeId: item.resumeId, status, score: evaluation?.evaluation.totalScore ?? 0, tier: item.evalTier, phase: item.evalPhase };
    emit('candidate.processed', { ...result, label: resume(item.resumeId).label, batchId: item.batchId, deep: item.evalPhase !== 'screen' }); return result;
  } });
  registry.register(defineWorkflow({ id: 'candidate-verification', version: '1.0.0', input: evalSchema, output: resultSchema, implementation, body: sequence('verify-candidate', verification, finish) }));

  const parseParallel = parallel('parse-candidates', { items: (b: Batch) => b.resumeIds.map((resumeId) => ({ resumeId, batchId: b.batchId, prepared: b.prepared })), key: (v) => v.resumeId, concurrency: (b) => b.prepared.plan.pools.parse, failure: 'collect', body: parse });
  const afterParse = task({ id: 'collect-parsed', input: z.object({ input: batchSchema, result: z.array(outcomeSchema(candidateSchema)) }), output: batchSchema, recovery: 'retry', handler: ({ input, result }) => {
    const values = result.filter((r) => r.ok).map((r) => r.value);
    for (const failed of result.filter((r) => !r.ok)) emit('batch.parse_failure', { batchId: input.batchId, error: failed.error });
    emit('batch.parsed', { batchId: input.batchId, parsed: values.length, failed: result.length - values.length }); return { ...input, parsed: values };
  } });
  const screenParallel = parallel('screen-candidates', { items: (b: Batch) => b.parsed, key: (v) => v.resumeId, concurrency: (b) => b.prepared.plan.pools.assess, failure: 'collect', body: screen });
  const afterScreen = task({ id: 'select-shortlist', input: z.object({ input: batchSchema, result: z.array(outcomeSchema(evalSchema)) }), output: batchSchema, recovery: 'retry', handler: ({ input, result }) => {
    const screened = result.filter((r) => r.ok).map((r) => r.value);
    for (const failed of result.filter((r) => !r.ok)) emit('screen.failed', { batchId: input.batchId, error: failed.error });
    emit('batch.screened', { batchId: input.batchId, screened: screened.length, failed: result.length - screened.length });
    const config = input.prepared.plan.deepEval;
    const sorted = [...screened].sort((a, b) => (loadLatestEval(deps.ledger, b.resumeId)?.evaluation.totalScore ?? 0) - (loadLatestEval(deps.ledger, a.resumeId)?.evaluation.totalScore ?? 0));
    const picked = new Set(config.enabled ? sorted.slice(0, Math.max(1, Math.ceil(sorted.length * config.percent / 100))).map((c) => c.resumeId) : []);
    if (config.enabled) for (const c of screened) if (parsed(c.resumeId).anomalies.length || loadLatestEval(deps.ledger, c.resumeId)?.evaluation.uncertainties.length) picked.add(c.resumeId);
    if (picked.size) emit('deep_eval.shortlist', { batchId: input.batchId, count: picked.size, percent: config.percent, tier: deps.config.deepEval.tier, labels: [...picked].map((id) => resume(id).label) });
    return { ...input, screened, shortlist: [...picked] };
  } });
  const candidateInputSchema = z.object({ candidate: evalSchema, deep: z.boolean() });
  const selectedCandidate = condition('deep-if-selected', { test: (v: z.infer<typeof candidateInputSchema>) => v.deep,
    then: sequence('selected-deep', task({ id: 'deep-input', input: candidateInputSchema, output: evalSchema, recovery: 'retry', handler: (v) => v.candidate }), deep),
    otherwise: task({ id: 'screen-only', input: candidateInputSchema, output: evalSchema, recovery: 'retry', handler: (v) => v.candidate }) });
  const candidateBody = sequence('candidate', selectedCandidate, subworkflow('verification', 'candidate-verification@1.0.0', evalSchema, resultSchema));
  const verifyParallel = parallel('evaluate-and-verify', { items: (b: Batch) => b.screened.map((candidate) => ({ candidate, deep: b.shortlist.includes(candidate.resumeId) })), key: (v) => v.candidate.resumeId, concurrency: (b) => Math.max(1, b.prepared.plan.pools.review + b.prepared.plan.pools.assess), failure: 'collect', body: candidateBody });
  const finishBatch = task({ id: 'finish-batch', input: z.object({ input: batchSchema, result: z.array(outcomeSchema(resultSchema)) }), output: batchResultSchema, recovery: 'retry', handler: ({ input, result }) => {
    const evaluated = result.filter((r) => r.ok).length;
    const value = { batchId: input.batchId, parsed: input.parsed.length, evaluated };
    emit('batch.completed', { ...value, failed: result.length - evaluated, deep: input.shortlist.length }); return value;
  } });
  const beginBatch = task({ id: 'begin-batch', input: batchSchema, output: batchSchema, recovery: 'retry', handler: (b) => { deps.ledger.assignBatch(b.resumeIds, b.batchId); emit('batch.started', { batchId: b.batchId, size: b.resumeIds.length }); return b; } });
  const batchBody = sequence('batch', beginBatch,
    sequence('parse-stage', retain('parse-results', parseParallel), afterParse),
    sequence('screen-stage', retain('screen-results', screenParallel), afterScreen),
    sequence('verify-stage', retain('verification-results', verifyParallel), finishBatch));
  const batches = parallel('batches', { items: (prepared: Prepared): Batch[] => chunk(prepared.resumeIds, prepared.plan.batchSize).map((resumeIds, i) => ({ batchId: i + 1, resumeIds, prepared, parsed: [], screened: [], shortlist: [] })), key: (b) => `batch-${b.batchId}`, concurrency: (p) => p.plan.maxBatchesInFlight, failure: 'collect', body: batchBody });
  const preparePublication = task({ id: 'prepare-report', input: z.object({ input: preparedSchema, result: z.array(outcomeSchema(batchResultSchema)) }), output: publicationSchema, recovery: 'retry', handler: ({ input }) => prepareReport(deps, stats(input), input.startedMs, input.strict) });
  const publishApproval = condition('approve-publication-if-strict', { test: (v: z.infer<typeof publicationSchema>) => v.strict,
    then: approval('approve-publication', { title: '审阅并发布报告', kind: 'publish-report', input: publicationSchema, payload: (v) => ({ report: v.report }) }),
    otherwise: identity('publication-default-mode', publicationSchema) });
  const publish = task({ id: 'write-report', input: publicationSchema, output: summarySchema, recovery: 'retry', handler: (value) => publishReport(deps, opts, value) });
  registry.register(defineWorkflow({ id: 'report-publication', version: '1.0.0', input: publicationSchema, output: summarySchema, implementation, body: sequence('publication', publishApproval, publish) }));
  registry.register(defineWorkflow({ id: 'recruitment', version: '1.0.0', input: inputSchema, output: summarySchema, implementation,
    body: sequence('recruitment', profile, ingest, sequence('planning', plan, planApproval), sequence('processing', retain('batch-results', batches), preparePublication), subworkflow('publish', 'report-publication@1.0.0', publicationSchema, summarySchema)) }));
  return registry;
}
