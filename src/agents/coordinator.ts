import path from 'node:path';
import { chunk, flowBatches, mapSettled } from '../core/pipeline.ts';
import { CapacityPool, withAgentSlot, admissionOptions } from '../core/pool.ts';
import { combineStopReasons } from '../core/state.ts';
import { writeJson } from '../util/fsx.ts';
import type {
  PoolStats,
  Jd,
  Scorecard,
  InterviewPlan,
  EvalResult,
  StopReason,
  ModelTier,
  EvalPhase,
  ParseResult,
  UploadedFile,
} from '../types.ts';
import type { RatingThresholds } from '../tools/scorecard.ts';
import type { AgentDeps } from './deps.ts';
import { runProfiler, buildProfileSearchQuery } from './profiler.ts';
import { runFetcher } from './fetcher.ts';
import { ParserWorker } from './parser.ts';
import { AssessorWorker, type AssessorContext } from './assessor.ts';
import { AuditorWorker } from './auditor.ts';
import { loadJobAnalysis, loadParseResult } from './data.ts';
import { planScreening } from './planner.ts';
import type { HitlResponder } from './hitl.ts';
import { buildReport, selectTopCandidates } from '../report/builder.ts';
import { writeReports, type ReportPaths } from '../report/render.ts';

export interface PipelineRunOptions {
  requirements: string;
  hitl: HitlResponder;
  uploadFiles?: UploadedFile[];
  resumeOnly?: boolean;
  /** Web 控制台暂停信号：在批次/阶段边界安全退出，已提交结果保留。 */
  shouldPause?: () => boolean;
}

/** 暂停不是失败：携带这个类型让 Web 层把运行标记为 paused 而不是 failed。 */
export class PipelinePausedError extends Error {
  constructor() {
    super('流水线已暂停');
    this.name = 'PipelinePausedError';
  }
}

export interface RunSummary {
  jobId: string;
  runId: string;
  runDir: string;
  status: string;
  counts: Record<string, number>;
  selfLoop: { revisions: number; escalations: number };
  pools: PoolStats[];
  top: { label: string; totalScore: number; conclusion: string }[];
  reports: ReportPaths;
  usage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    costUsd: number;
    cacheHitRate: number;
  };
  durationMs: number;
}

interface WorkItem {
  resumeId: string;
  label: string;
  parsed: ReturnType<typeof loadParseResult>;
}

function summarizeUsage(deps: AgentDeps): RunSummary['usage'] {
  const calls = deps.llm.calls;
  const promptTokens = calls.reduce((sum, c) => sum + c.promptTokens, 0);
  const completionTokens = calls.reduce((sum, c) => sum + c.completionTokens, 0);
  const cachedTokens = calls.reduce((sum, c) => sum + c.cachedPromptTokens, 0);
  const costUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);
  return {
    calls: calls.length,
    promptTokens,
    completionTokens,
    cachedTokens,
    costUsd: Number(costUsd.toFixed(6)),
    cacheHitRate: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(3)) : 0,
  };
}

/** 批次级检查点恢复：中断后重入未完成简历，已提交任务不复用之外的半成品一律重跑。 */
async function recoverIncomplete(deps: AgentDeps): Promise<void> {
  const resumes = deps.ledger.listResumes(deps.jobId);
  for (const resume of resumes) {
    if (!['parsing', 'evaluating', 'verifying', 'parsed', 'evaluated'].includes(resume.status)) continue;
    const hasCommittedParse = deps.ledger
      .listTasks('parse', { jobId: deps.jobId })
      .some((task) => task.resume_id === resume.id && task.status === 'committed');
    const target = hasCommittedParse ? 'parsed' : 'queued';
    if (resume.status !== target) {
      deps.ledger.forceResumeStatus(resume.id, target, `checkpoint resume: ${resume.status} → ${target}`);
      deps.events.emit(deps.jobId, 'coordinator', 'recovery.resume_reset', {
        resumeId: resume.id,
        label: resume.label,
        from: resume.status,
        to: target,
      });
    }
  }
  for (const kind of ['parse', 'eval', 'review'] as const) {
    for (const task of deps.ledger.listTasks(kind, { jobId: deps.jobId })) {
      if (task.status === 'running' || task.status === 'staged') {
        deps.ledger.updateTask(kind, task.id, {
          status: 'aborted',
          stop_reason: combineStopReasons((task.stop_reason as StopReason | null) ?? null, 'aborted'),
        });
        deps.events.emit(deps.jobId, 'coordinator', 'recovery.task_aborted', {
          kind,
          taskId: task.id,
          resumeId: task.resume_id,
        });
      }
    }
  }
}

export async function runPipeline(deps: AgentDeps, opts: PipelineRunOptions): Promise<RunSummary> {
  const startedMs = Date.now();
  const job = deps.ledger.getJob(deps.jobId);
  if (!job) throw new Error(`任务不存在: ${deps.jobId}`);

  let analysis = loadJobAnalysis(job);
  if (!analysis) {
    analysis = await runProfiler(deps, {
      jobId: deps.jobId,
      requirements: opts.requirements,
      hitl: opts.hitl,
    });
  }
  const checkpoint = (): void => {
    if (opts.shouldPause?.()) throw new PipelinePausedError();
  };
  checkpoint();
  const jd: Jd = analysis.jd;
  const scorecard: Scorecard = analysis.scorecard;
  const knowledgeQuery = buildProfileSearchQuery(analysis);

  if (!opts.resumeOnly) {
    const files = opts.uploadFiles ?? [];
    if (files.length === 0) throw new Error('请至少上传一份简历（支持 PDF / DOCX / 图片 / 文本）');
    const fetched = await runFetcher(deps, { files });
    if (fetched.resumes.length === 0) {
      throw new Error('上传文件未能接入：请检查文件格式与内容');
    }
    const usable = fetched.resumes.filter((resume) => resume.status === 'queued').length;
    if (usable === 0) {
      const failures = fetched.manifest.failed.map((item) => `${item.messageId}: ${item.reason}`).join('；');
      throw new Error(`所有简历均未能接入（无可用简历）。失败明细：${failures || '未知原因'}`);
    }
  } else {
    await recoverIncomplete(deps);
  }
  checkpoint();

  const pending = deps.ledger
    .listResumes(deps.jobId)
    .filter((resume) => resume.status === 'queued' || resume.status === 'parsed');
  const workItems: WorkItem[] = pending.map((resume) => ({
    resumeId: resume.id,
    label: resume.label,
    parsed: resume.status === 'parsed' ? loadParseResult(deps.ledger, resume.id) : null,
  }));

  // 扇出与并发不由代码按数量硬编码：上传/接入完成后交给主 Agent 读 skill 决策。
  const counts = deps.ledger.resumeCounts(deps.jobId);
  const formats: Record<string, number> = {};
  for (const resume of deps.ledger.listResumes(deps.jobId)) {
    const format = resume.format || 'unknown';
    formats[format] = (formats[format] ?? 0) + 1;
  }
  const plan = await planScreening(deps, {
    usable: workItems.length,
    duplicates: counts.duplicate ?? 0,
    failed: counts.failed ?? 0,
    formats,
    resumeOnly: !!opts.resumeOnly,
    defaults: {
      batchSize: deps.config.batchSize,
      maxBatchesInFlight: deps.config.maxBatchesInFlight,
      maxActiveAgents: deps.config.maxActiveAgents,
      pools: deps.config.pools,
      deepEval: { enabled: deps.config.deepEval.enabled, percent: deps.config.deepEval.percent },
    },
  });
  const planArtifact = path.join(deps.runDir, 'artifacts', 'plan', 'screening_plan.json');
  await writeJson(planArtifact, { ...plan, inventory: { usable: workItems.length, duplicates: counts.duplicate ?? 0, failed: counts.failed ?? 0, formats, resumeOnly: !!opts.resumeOnly } });
  deps.events.emit(deps.jobId, 'coordinator', 'screening.plan', {
    mode: plan.mode,
    batchSize: plan.batchSize,
    maxBatchesInFlight: plan.maxBatchesInFlight,
    maxActiveAgents: plan.maxActiveAgents,
    pools: plan.pools,
    deepEval: plan.deepEval,
    source: plan.source,
    reason: plan.reason,
    usable: workItems.length,
    artifact: planArtifact,
  });

  const parsePool = new CapacityPool('parse', plan.pools.parse);
  const assessPool = new CapacityPool('assess', plan.pools.assess);
  const reviewPool = new CapacityPool('review', plan.pools.review);
  const agentPool = new CapacityPool('agents', plan.maxActiveAgents);
  const admission = admissionOptions(deps.config.admission);

  deps.events.emit(deps.jobId, 'coordinator', 'pipeline.started', {
    resumes: deps.ledger.listResumes(deps.jobId).length,
    workItems: workItems.length,
    batchSize: plan.batchSize,
    maxBatchesInFlight: plan.maxBatchesInFlight,
    pools: { ...plan.pools, agents: plan.maxActiveAgents },
    deepEval: plan.deepEval,
    planSource: plan.source,
    resumeOnly: !!opts.resumeOnly,
  });

  const assessorCtx: AssessorContext = {
    jd,
    scorecard,
    thresholds: deps.config.conclusionScale as unknown as RatingThresholds,
    knowledgeQuery,
  };

  interface ScreenedCandidate {
    resumeId: string;
    label: string;
    parsed: ParseResult;
    evaluation: EvalResult;
    evalTaskId: string;
    evalTier: ModelTier;
    evalPhase: EvalPhase;
    worker: AssessorWorker;
  }

  /** 扇出初筛：全量走 flash（高并发、低成本），证据门禁与 schema 校验仍在。 */
  const screenCandidate = async (item: WorkItem, batchId: number): Promise<ScreenedCandidate> => {
    const resume = deps.ledger.getResume(item.resumeId);
    if (!resume) throw new Error(`简历不存在: ${item.resumeId}`);
    const parsed = item.parsed ?? loadParseResult(deps.ledger, resume.id);
    if (!parsed) throw new Error('解析结果缺失');
    const worker = new AssessorWorker(deps, assessPool.stats().acquired + 1, assessorCtx);
    const tier = deps.registry.get('assessor').tier;
    const result = await withAgentSlot(agentPool, assessPool, `screen:${resume.id}`, admission, () =>
      worker.evaluate({ resume, parsed, batchId, loopIndex: 0, tier, phase: 'screen' }),
    );
    if (!result.ok || !result.evaluation) {
      throw new Error(`初筛评估失败: ${result.errors.join('；')}`);
    }
    return {
      resumeId: resume.id,
      label: resume.label,
      parsed,
      evaluation: result.evaluation,
      evalTaskId: result.taskId,
      evalTier: tier,
      evalPhase: 'screen',
      worker,
    };
  };

  /**
   * 短名单选择：批内按初筛分取 Top percent；解析异常/不确定项一并升级，
   * 对应方案 §7.3「按复杂度分配 effort」。
   */
  const selectDeepShortlist = (screened: ScreenedCandidate[]): ScreenedCandidate[] => {
    const config = plan.deepEval;
    if (!config.enabled || screened.length === 0) return [];
    const sorted = [...screened].sort((a, b) => b.evaluation.totalScore - a.evaluation.totalScore);
    const count = Math.max(1, Math.ceil((sorted.length * config.percent) / 100));
    const picked = new Map<string, ScreenedCandidate>(
      sorted.slice(0, count).map((candidate) => [candidate.resumeId, candidate]),
    );
    for (const candidate of screened) {
      const complexity =
        candidate.parsed.anomalies.length > 0 || candidate.evaluation.uncertainties.length > 0;
      if (complexity) picked.set(candidate.resumeId, candidate);
    }
    return [...picked.values()];
  };

  /** 判断：短名单用 pro 深评；失败则保留 flash 结果，不阻塞候选人。 */
  const deepEvaluate = async (candidate: ScreenedCandidate, batchId: number): Promise<void> => {
    const resume = deps.ledger.getResume(candidate.resumeId);
    if (!resume) return;
    const worker = new AssessorWorker(deps, assessPool.stats().acquired + 1, assessorCtx, 'assessor-deep');
    const tier = deps.config.deepEval.tier;
    const result = await withAgentSlot(agentPool, assessPool, `deep:${candidate.resumeId}`, admission, () =>
      worker.evaluate({
        resume,
        parsed: candidate.parsed,
        batchId,
        loopIndex: 0,
        tier,
        phase: 'deep',
      }),
    );
    if (!result.ok || !result.evaluation) {
      deps.events.emit(deps.jobId, 'assessor', 'deep_eval.failed', {
        resumeId: candidate.resumeId,
        label: candidate.label,
        batchId,
        errors: result.errors,
        fallback: 'flash',
      });
      return;
    }
    candidate.evaluation = result.evaluation;
    candidate.evalTaskId = result.taskId;
    candidate.evalTier = tier;
    candidate.evalPhase = 'deep';
    candidate.worker = worker;
    deps.events.emit(deps.jobId, 'assessor', 'deep_eval.completed', {
      resumeId: candidate.resumeId,
      label: candidate.label,
      batchId,
      totalScore: result.evaluation.totalScore,
      tier,
      evalTaskId: result.taskId,
    });
  };

  /** 否决：所有候选人（含仅初筛者）都由 pro 监军核查；返工沿用被核查那次的档位。 */
  const reviewCandidate = async (candidate: ScreenedCandidate, batchId: number): Promise<{ status: string; score?: number }> => {
    let loop = 0;
    let lastReview: Awaited<ReturnType<AuditorWorker['review']>> | null = null;

    for (;;) {
      const resume = deps.ledger.getResume(candidate.resumeId);
      if (!resume) return { status: 'missing' };
      const auditor = new AuditorWorker(deps, reviewPool.stats().acquired + 1);
      const review = await withAgentSlot(agentPool, reviewPool, `review:${candidate.resumeId}`, admission, () =>
        auditor.review({
          resume,
          parsed: candidate.parsed,
          evaluation: candidate.evaluation,
          evalTaskId: candidate.evalTaskId,
          batchId,
          loopCount: loop,
          maxLoops: deps.config.selfLoop.maxLoops,
        }),
      );
      lastReview = review;
      if (!review.ok || !review.review) return { status: 'review_failed' };
      if (review.review.verdict !== 're_eval') break;
      if (loop >= deps.config.selfLoop.maxLoops) break;
      loop += 1;
      deps.events.emit(deps.jobId, 'coordinator', 'selfloop.revise', {
        resumeId: candidate.resumeId,
        label: candidate.label,
        loop,
        workerId: candidate.worker.workerId,
        fixes: review.review.requiredFixes.length,
        tier: candidate.evalTier,
      });
      const revised = await withAgentSlot(agentPool, assessPool, `revise:${candidate.resumeId}`, admission, () =>
        candidate.worker.revise({
          resume,
          parsed: candidate.parsed,
          batchId,
          loopIndex: loop,
          feedback: review.review,
          revisionOf: candidate.evalTaskId,
          tier: candidate.evalTier,
          phase: 'revise',
        }),
      );
      if (!revised.ok || !revised.evaluation) return { status: 'revise_failed' };
      candidate.evaluation = revised.evaluation;
      candidate.evalTaskId = revised.taskId;
      candidate.evalPhase = 'revise';
    }

    const status = lastReview?.review?.verdict === 'pass' ? 'verified' : 'escalated';
    return { status, score: candidate.evaluation.totalScore };
  };

  const batches = chunk(workItems, plan.batchSize);
  let parseFailures = 0;
  let evalFailures = 0;

  checkpoint();
  await flowBatches<WorkItem, { batchId: number; parsed: number; evaluated: number }>({
    batches,
    maxInFlight: plan.maxBatchesInFlight,
    shouldStop: () => opts.shouldPause?.() ?? false,
    stopOnError: (error) => error instanceof PipelinePausedError,
    onBatchStart: (index, size) => {
      deps.events.emit(deps.jobId, 'coordinator', 'batch.started', {
        batchId: index + 1,
        size,
      });
    },
    onBatchError: (index, error) => {
      if (error instanceof PipelinePausedError) return;
      deps.events.emit(deps.jobId, 'coordinator', 'batch.failed', {
        batchId: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    run: async (batch, index) => {
      const batchId = index + 1;
      checkpoint();
      deps.ledger.assignBatch(batch.map((item) => item.resumeId), batchId);

      const parseOutcomes = await mapSettled(batch, parsePool.capacity, async (item) => {
        if (item.parsed) {
          deps.events.emit(deps.jobId, 'coordinator', 'parse.reused', {
            resumeId: item.resumeId,
            label: item.label,
            batchId,
          });
          return item;
        }
        const resume = deps.ledger.getResume(item.resumeId);
        if (!resume) throw new Error(`简历不存在: ${item.resumeId}`);
        const worker = new ParserWorker(deps, parsePool.stats().acquired + 1);
        const result = await withAgentSlot(agentPool, parsePool, `parse:${resume.id}`, admission, () =>
          worker.parse({ resume, batchId }),
        );
        if (!result.ok) throw new Error(`解析失败: ${result.errors.join('；')}`);
        const parsed = loadParseResult(deps.ledger, resume.id);
        if (!parsed) throw new Error('解析已提交但无法从台账重建结果');
        return { ...item, parsed };
      });

      const parsedItems: WorkItem[] = [];
      for (const outcome of parseOutcomes) {
        if (outcome.ok) parsedItems.push(outcome.value);
        else {
          parseFailures += 1;
          deps.events.emit(deps.jobId, 'coordinator', 'batch.parse_failure', {
            batchId,
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          });
        }
      }
      deps.events.emit(deps.jobId, 'coordinator', 'batch.parsed', {
        batchId,
        parsed: parsedItems.length,
        failed: batch.length - parsedItems.length,
      });
      checkpoint();

      const screenOutcomes = await mapSettled(parsedItems, assessPool.capacity, (item) =>
        screenCandidate(item, batchId),
      );
      const screened: ScreenedCandidate[] = [];
      for (const outcome of screenOutcomes) {
        if (outcome.ok) {
          screened.push(outcome.value);
        } else {
          evalFailures += 1;
          deps.events.emit(deps.jobId, 'assessor', 'screen.failed', {
            batchId,
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          });
        }
      }
      deps.events.emit(deps.jobId, 'coordinator', 'batch.screened', {
        batchId,
        screened: screened.length,
        failed: parsedItems.length - screened.length,
      });
      checkpoint();

      const shortlist = selectDeepShortlist(screened);
      if (shortlist.length > 0) {
        deps.events.emit(deps.jobId, 'coordinator', 'deep_eval.shortlist', {
          batchId,
          count: shortlist.length,
          percent: plan.deepEval.percent,
          tier: deps.config.deepEval.tier,
          labels: shortlist.map((candidate) => candidate.label),
        });
        await mapSettled(shortlist, assessPool.capacity, (candidate) => deepEvaluate(candidate, batchId));
      }
      checkpoint();

      const results = await mapSettled(
        screened,
        Math.max(1, reviewPool.capacity + assessPool.capacity),
        async (candidate) => {
          const result = await reviewCandidate(candidate, batchId);
          if (result.status.includes('failed')) evalFailures += 1;
          deps.events.emit(deps.jobId, 'coordinator', 'candidate.processed', {
            resumeId: candidate.resumeId,
            label: candidate.label,
            batchId,
            status: result.status,
            score: result.score ?? null,
            tier: candidate.evalTier,
            phase: candidate.evalPhase,
            deep: candidate.evalPhase !== 'screen',
          });
          return result;
        },
      );

      const evaluated = results.filter(
        (result) =>
          result.ok && (result.value.status === 'verified' || result.value.status === 'escalated'),
      ).length;
      deps.events.emit(deps.jobId, 'coordinator', 'batch.completed', {
        batchId,
        evaluated,
        failed: screened.length - evaluated,
        deep: shortlist.length,
      });
      return { batchId, parsed: parsedItems.length, evaluated };
    },
  });
  checkpoint();

  // 汇总：只消费已提交的评估与核查结果
  const verifiedResumes = deps.ledger.listResumes(deps.jobId).filter((r) => r.status === 'verified');
  const top = selectTopCandidates(deps.ledger, deps.jobId, deps.config.topN);
  // 面试建议不再作为流水线 Agent 自动生成；改为完成后对话中的按需 skill。
  const interviewPlans = new Map<string, InterviewPlan>();

  checkpoint();
  const confirmation = await opts.hitl.ask({
    id: 'final_report',
    node: 'final_confirmation',
    question: `已生成 Top${deps.config.topN} 推荐、证据链与合规报告（${verifiedResumes.length} 人核查通过，${deps.ledger.selfLoopStats(deps.jobId).escalations} 人转人工）。是否确认输出终稿？`,
    options: ['确认输出终稿（推荐）', '保存为草稿，需 HR 修改'],
    recommendedOption: '确认输出终稿（推荐）',
    blocking: true,
  });
  checkpoint();
  deps.ledger.addDecision({
    jobId: deps.jobId,
    node: 'final_confirmation',
    question: '是否确认输出终稿',
    answer: confirmation.answer,
    actor: confirmation.actor,
  });
  deps.events.emit(deps.jobId, 'coordinator', 'hitl.final_confirmation', {
    answer: confirmation.answer,
    actor: confirmation.actor,
  });
  const finalStatus = /确认输出/.test(confirmation.answer) ? 'final' : 'draft';
  const jobStatus = finalStatus === 'final' ? 'completed' : 'draft';

  const reportData = await buildReport(deps, analysis, {
    pools: [parsePool.stats(), assessPool.stats(), reviewPool.stats(), agentPool.stats()],
    startedMs,
    topN: deps.config.topN,
    interviewPlans,
    status: finalStatus,
  });
  const reports = await writeReports(reportData, deps.runDir);
  // 报告成功落盘后才把 job/简历推进到终态，避免"状态完成但报告缺失"
  deps.ledger.setJobStatus(deps.jobId, jobStatus);
  if (finalStatus === 'final') {
    for (const resume of verifiedResumes) deps.ledger.setResumeStatus(resume.id, 'reported');
  }
  deps.events.emit(deps.jobId, 'coordinator', 'report.generated', {
    status: finalStatus,
    top: reportData.top.map((c) => `${c.label}:${c.totalScore}`),
    reports,
  });

  // 汇总阶段的排序把已核查候选人与转人工/失败分开；这里按分数重排一次用于返回摘要
  const summary: RunSummary = {
    jobId: deps.jobId,
    runId: deps.runId,
    runDir: deps.runDir,
    status: finalStatus,
    counts: deps.ledger.resumeCounts(deps.jobId),
    selfLoop: deps.ledger.selfLoopStats(deps.jobId),
    pools: [parsePool.stats(), assessPool.stats(), reviewPool.stats(), agentPool.stats()],
    top: top.map((candidate) => ({
      label: candidate.label,
      totalScore: candidate.totalScore,
      conclusion: candidate.conclusion,
    })),
    reports,
    usage: summarizeUsage(deps),
    durationMs: Date.now() - startedMs,
  };

  deps.events.emit(deps.jobId, 'coordinator', 'run.completed', {
    status: finalStatus,
    resumeCounts: summary.counts,
    parseFailures,
    evalFailures,
    durationMs: summary.durationMs,
    usage: summary.usage,
    pools: summary.pools,
  });
  return summary;
}
