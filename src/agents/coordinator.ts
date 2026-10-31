import { chunk, flowBatches, mapSettled } from '../core/pipeline.ts';
import { CapacityPool, withSlot, admissionOptions } from '../core/pool.ts';
import { combineStopReasons } from '../core/state.ts';
import type { PoolStats, Jd, Scorecard, InterviewPlan, EvalResult, StopReason } from '../types.ts';
import type { RatingThresholds } from '../tools/scorecard.ts';
import type { AgentDeps } from './deps.ts';
import { runProfiler } from './profiler.ts';
import { runFetcher } from './fetcher.ts';
import { ParserWorker } from './parser.ts';
import { AssessorWorker } from './assessor.ts';
import { AuditorWorker } from './auditor.ts';
import { runAdvisor } from './advisor.ts';
import { loadJobAnalysis, loadLatestEval, loadParseResult } from './data.ts';
import type { HitlResponder } from './hitl.ts';
import { buildReport, selectTopCandidates } from '../report/builder.ts';
import { writeReports, type ReportPaths } from '../report/render.ts';

export interface PipelineRunOptions {
  requirements: string;
  hitl: HitlResponder;
  inboxDir: string;
  mcpMode?: 'in-process' | 'stdio';
  resumeOnly?: boolean;
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
  const jd: Jd = analysis.jd;
  const scorecard: Scorecard = analysis.scorecard;

  if (!opts.resumeOnly) {
    const fetched = await runFetcher(deps, { inboxDir: opts.inboxDir, mcpMode: opts.mcpMode });
    if (fetched.resumes.length === 0) {
      throw new Error('未从邮箱获取到任何简历：请检查 inbox 目录或 mock MCP 服务');
    }
    const usable = fetched.resumes.filter((resume) => resume.status === 'queued').length;
    if (usable === 0) {
      const failures = fetched.manifest.failed.map((item) => `${item.messageId}: ${item.reason}`).join('；');
      throw new Error(`所有简历均未能接入（无可用简历）。失败明细：${failures || '未知原因'}`);
    }
  } else {
    await recoverIncomplete(deps);
  }

  const parsePool = new CapacityPool('parse', deps.config.pools.parse);
  const assessPool = new CapacityPool('assess', deps.config.pools.assess);
  const reviewPool = new CapacityPool('review', deps.config.pools.review);
  const admission = admissionOptions(deps.config.admission);

  const pending = deps.ledger
    .listResumes(deps.jobId)
    .filter((resume) => resume.status === 'queued' || resume.status === 'parsed');
  const workItems: WorkItem[] = pending.map((resume) => ({
    resumeId: resume.id,
    label: resume.label,
    parsed: resume.status === 'parsed' ? loadParseResult(deps.ledger, resume.id) : null,
  }));

  deps.events.emit(deps.jobId, 'coordinator', 'pipeline.started', {
    resumes: deps.ledger.listResumes(deps.jobId).length,
    workItems: workItems.length,
    batchSize: deps.config.batchSize,
    maxBatchesInFlight: deps.config.maxBatchesInFlight,
    pools: { parse: parsePool.capacity, assess: assessPool.capacity, review: reviewPool.capacity },
    resumeOnly: !!opts.resumeOnly,
  });

  const reporter = async (item: WorkItem, batchId: number): Promise<{ status: string; score?: number }> => {
    const resume = deps.ledger.getResume(item.resumeId);
    if (!resume) return { status: 'missing' };
    if (resume.status === 'failed' || resume.status === 'duplicate' || resume.status === 'quarantine') {
      return { status: resume.status };
    }

    const parsed = item.parsed ?? loadParseResult(deps.ledger, resume.id);
    if (!parsed) return { status: 'no_parse' };

    const worker = new AssessorWorker(deps, assessPool.stats().acquired + 1, {
      jd,
      scorecard,
      thresholds: deps.config.conclusionScale as unknown as RatingThresholds,
    });
    let loop = 0;
    let evalResult: EvalResult | undefined;
    let evalTaskId: string | null = null;
    let lastReview = null as Awaited<ReturnType<AuditorWorker['review']>> | null;

    const first = await withSlot(assessPool, `eval:${resume.id}`, admission, () =>
      worker.evaluate({ resume, parsed, batchId, loopIndex: 0 }),
    );
    if (!first.ok || !first.evaluation) return { status: 'eval_failed' };
    evalResult = first.evaluation;
    evalTaskId = first.taskId;

    for (;;) {
      const auditor = new AuditorWorker(deps, reviewPool.stats().acquired + 1);
      const review = await withSlot(reviewPool, `review:${resume.id}`, admission, () =>
        auditor.review({
          resume,
          parsed,
          evaluation: evalResult!,
          evalTaskId: evalTaskId!,
          batchId,
          loopCount: loop,
          maxLoops: deps.config.selfLoop.maxLoops,
        }),
      );
      lastReview = review;
      if (!review.ok || !review.review) return { status: 'review_failed' };
      if (review.review.verdict === 'pass') break;
      if (review.review.verdict === 'escalate_human') break;
      if (loop >= deps.config.selfLoop.maxLoops) break;
      loop += 1;
      deps.events.emit(deps.jobId, 'coordinator', 'selfloop.revise', {
        resumeId: resume.id,
        label: resume.label,
        loop,
        workerId: worker.workerId,
        fixes: review.review.requiredFixes.length,
      });
      const revised = await withSlot(assessPool, `regexp:${resume.id}`, admission, () =>
        worker.revise({
          resume,
          parsed,
          batchId,
          loopIndex: loop,
          feedback: review.review,
          revisionOf: evalTaskId,
        }),
      );
      if (!revised.ok || !revised.evaluation) return { status: 'revise_failed' };
      evalResult = revised.evaluation;
      evalTaskId = revised.taskId;
    }

    const status = lastReview?.review?.verdict === 'pass' ? 'verified' : 'escalated';
    return { status, score: evalResult?.totalScore };
  };

  const batches = chunk(workItems, deps.config.batchSize);
  let parseFailures = 0;
  let evalFailures = 0;

  await flowBatches<WorkItem, { batchId: number; parsed: number; evaluated: number }>({
    batches,
    maxInFlight: deps.config.maxBatchesInFlight,
    onBatchStart: (index, size) => {
      deps.events.emit(deps.jobId, 'coordinator', 'batch.started', {
        batchId: index + 1,
        size,
      });
    },
    onBatchError: (index, error) => {
      deps.events.emit(deps.jobId, 'coordinator', 'batch.failed', {
        batchId: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    run: async (batch, index) => {
      const batchId = index + 1;
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
        const result = await withSlot(parsePool, `parse:${resume.id}`, admission, () =>
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

      const results = await mapSettled(parsedItems, assessPool.capacity, async (item) => {
        const resume = deps.ledger.getResume(item.resumeId);
        if (!resume) throw new Error(`简历不存在: ${item.resumeId}`);
        const result = await reporter(item, batchId);
        if (result.status.includes('failed') || result.status === 'no_parse') {
          evalFailures += 1;
        }
        deps.events.emit(deps.jobId, 'coordinator', 'candidate.processed', {
          resumeId: item.resumeId,
          label: item.label,
          batchId,
          status: result.status,
          score: result.score ?? null,
        });
        return result;
      });

      const evaluated = results.filter((r) => r.ok).length;
      deps.events.emit(deps.jobId, 'coordinator', 'batch.completed', {
        batchId,
        evaluated,
        failed: results.length - evaluated,
      });
      return { batchId, parsed: parsedItems.length, evaluated };
    },
  });

  // 汇总：只消费已提交的评估与核查结果
  const verifiedResumes = deps.ledger.listResumes(deps.jobId).filter((r) => r.status === 'verified');
  const top = selectTopCandidates(deps.ledger, deps.jobId, deps.config.topN);
  const interviewPlans = new Map<string, InterviewPlan>();
  for (const candidate of top) {
    const parsed = loadParseResult(deps.ledger, candidate.resumeId);
    const evaluation = loadLatestEval(deps.ledger, candidate.resumeId);
    const resume = deps.ledger.getResume(candidate.resumeId);
    if (!parsed || !evaluation || !resume) continue;
    const plan = await runAdvisor(deps, {
      resume,
      parsed,
      evaluation: evaluation.evaluation,
      jd,
    });
    interviewPlans.set(candidate.resumeId, plan);
  }

  const confirmation = await opts.hitl.ask({
    id: 'final_report',
    node: 'final_confirmation',
    question: `已生成 Top${deps.config.topN} 推荐、证据链与合规报告（${verifiedResumes.length} 人核查通过，${deps.ledger.selfLoopStats(deps.jobId).escalations} 人转人工）。是否确认输出终稿？`,
    options: ['确认输出终稿（推荐）', '保存为草稿，需 HR 修改'],
    recommendedOption: '确认输出终稿（推荐）',
    blocking: true,
  });
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
    pools: [parsePool.stats(), assessPool.stats(), reviewPool.stats()],
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
    pools: [parsePool.stats(), assessPool.stats(), reviewPool.stats()],
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
