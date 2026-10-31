import type { ResumeStatus, StopReason, TaskStatus } from '../types.ts';

export class IllegalTransitionError extends Error {
  from: string;
  to: string;
  constructor(entity: string, from: string, to: string) {
    super(`非法状态迁移 [${entity}] ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class AlreadyCommittedError extends Error {
  constructor(taskId: string) {
    super(`任务 ${taskId} 已 committed，提交后禁止写入（单调守卫）`);
    this.name = 'AlreadyCommittedError';
  }
}

/** 任务状态机。committed 为终态；失败/取消只能经显式重试回到 pending。 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'aborted', 'refused'],
  running: ['staged', 'failed', 'aborted', 'refused'],
  staged: ['committed', 'failed', 'aborted'],
  committed: [],
  failed: ['pending'],
  aborted: ['pending'],
  refused: ['pending'],
};

export const TASK_TERMINAL: TaskStatus[] = ['committed', 'failed', 'aborted', 'refused'];

/** 简历生命周期（可观察视图）。 */
export const RESUME_TRANSITIONS: Record<ResumeStatus, ResumeStatus[]> = {
  queued: ['parsing', 'failed', 'duplicate'],
  parsing: ['parsed', 'failed'],
  parsed: ['evaluating', 'failed', 'quarantine'],
  evaluating: ['evaluated', 'failed', 'parsing'],
  evaluated: ['verifying', 'evaluating', 'quarantine', 'failed'],
  verifying: ['verified', 'quarantine', 'evaluated', 'failed'],
  verified: ['reported', 'quarantine'],
  reported: [],
  quarantine: [],
  failed: ['queued'],
  duplicate: [],
};

export function assertTransition(
  entity: 'task' | 'resume',
  from: string,
  to: string,
): void {
  const table = entity === 'task' ? TASK_TRANSITIONS : RESUME_TRANSITIONS;
  const allowed = (table as Record<string, string[]>)[from];
  if (!allowed || !allowed.includes(to)) {
    throw new IllegalTransitionError(entity, from, to);
  }
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === 'committed' || status === 'failed' || status === 'aborted' || status === 'refused';
}

const FAILURE_REASONS: StopReason[] = ['error', 'max-tokens', 'refusal'];

export function isFailureReason(reason: StopReason | null | undefined): boolean {
  return !!reason && FAILURE_REASONS.includes(reason);
}

/**
 * 结算语义：失败优先于取消，取消优先于完成。
 * 一旦已经记录了失败，后续的"取消/清理"不得把它改写为成功或取消。
 */
export function combineStopReasons(
  recorded: StopReason | null | undefined,
  incoming: StopReason,
): StopReason {
  if (!recorded) return incoming;
  if (isFailureReason(recorded)) return recorded;
  if (isFailureReason(incoming)) return incoming;
  if (recorded === 'aborted') return recorded;
  return incoming === 'aborted' ? 'aborted' : recorded;
}

export function errorToStopReason(error: unknown): StopReason {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /aborted|timeout/i.test(error.message)) return 'aborted';
    if (/refus/i.test(error.message)) return 'refusal';
  }
  return 'error';
}
