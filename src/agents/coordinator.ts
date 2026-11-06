import type { PipelineConfig } from '../config.ts';
import { AgentStore } from '../agent-platform/store.ts';
import type { PoolStats, UploadedFile, StopReason } from '../types.ts';
import type { AgentDeps } from './deps.ts';
import type { HitlResponder } from './hitl.ts';
import type { ReportPaths } from '../report/render.ts';
import { combineStopReasons } from '../core/state.ts';
import { WorkflowPausedError, WorkflowEngine, WorkflowStore } from '../workflow/index.ts';
import { recruitmentRegistry, RECRUITMENT_KEY } from '../workflows/recruitment/workflow.ts';
import type { MailboxQuery } from '../mail/service.ts';
import { freezeMailboxQuery } from '../mail/service.ts';

export interface PipelineRunOptions {
  requirements: string;
  hitl: HitlResponder;
  uploadFiles?: UploadedFile[];
  mailbox?: MailboxQuery;
  resumeOnly?: boolean;
  /** Web 控制台暂停信号：在节点边界停止派发，在途结果安全收束。 */
  shouldPause?: () => boolean;
  /** CLI 使用交互审批；Web 将等待状态持久化后释放执行资源。 */
  approvalResponder?: HitlResponder;
}

/** 暂停不是失败：携带这个类型让 Web 层把运行标记为 paused 而不是 failed。 */
export class PipelinePausedError extends WorkflowPausedError {
  constructor(reason?: string) {
    super(reason);
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

/** 批次级检查点恢复：中断后重入未完成简历，已提交任务不复用之外的半成品一律重跑。 */
export async function recoverIncomplete(deps: AgentDeps): Promise<void> {
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
  const store = new WorkflowStore(deps.ledger);
  const existing = store.root(deps.jobId);
  // Legacy jobs have business checkpoints but no workflow record. Import them conservatively.
  if (!existing && opts.resumeOnly) {
    await recoverIncomplete(deps);
    deps.events.emit(deps.jobId, 'workflow', 'workflow.legacy_import', { policy: 'reuse committed business results; re-enter unfinished stages' });
  }
  const effective = existing ? { ...deps, config: JSON.parse(existing.input_json).config as PipelineConfig } : deps;
  const engine = new WorkflowEngine(deps.ledger, recruitmentRegistry(effective, opts), {
    executionCapacity: effective.config.maxActiveAgents,
    shouldPause: opts.shouldPause, approvalResponder: opts.approvalResponder,
    checkpoint: () => { const agents = new AgentStore(deps.ledger); const manifest = agents.manifest(deps.jobId); if (manifest) for (const binding of Object.values(manifest.bindings)) agents.assertUsable(binding); },
  });
  try {
    return existing ? await engine.resume<RunSummary>(existing.id)
      : await engine.start(deps.jobId, RECRUITMENT_KEY, { requirements: opts.requirements, files: opts.uploadFiles ?? [], ...(opts.mailbox ? { mailbox: freezeMailboxQuery(opts.mailbox, deps.ledger) } : {}), resumeOnly: !!opts.resumeOnly, config: deps.config });
  } catch (error) {
    if (error instanceof WorkflowPausedError) throw new PipelinePausedError(error.message);
    throw error;
  }
}
