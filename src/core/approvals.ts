import { createHash, randomUUID } from 'node:crypto';
import type { Ledger } from './ledger.ts';
import type { HitlResponder } from '../agents/hitl.ts';

export type ExecutionMode = 'default' | 'strict';
export type ApprovalKind = 'screening-plan' | 'publish-report' | 'tool' | 'memory-policy-change' | 'workflow';
export interface Approval {
  id: string;
  job_id: string;
  kind: ApprovalKind;
  payload_json: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed';
  actor: string | null;
  result_json: string | null;
}

export class ApprovalPendingError extends Error {
  readonly approval: Approval;
  constructor(approval: Approval) { super('操作等待用户审批'); this.approval = approval; }
}
export class ApprovalRejectedError extends Error {
  constructor() { super('用户已拒绝该操作；未继续执行'); }
}

export function parseExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined || value === 'default') return 'default';
  if (value === 'strict') return 'strict';
  throw new Error('executionMode 必须为 default 或 strict');
}

/** 所有审批均绑定不可变的操作快照；工具每次调用使用独立 scope，不复用历史授权。 */
export class ApprovalStore {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }

  mode(jobId: string): ExecutionMode {
    const row = this.ledger.db.prepare('SELECT mode FROM execution_policies WHERE job_id=?').get(jobId) as { mode: ExecutionMode } | undefined;
    return row?.mode ?? 'default';
  }

  setMode(jobId: string, mode: ExecutionMode): void {
    this.ledger.db.prepare('INSERT INTO execution_policies(job_id,mode) VALUES (?,?)').run(jobId, mode);
  }

  get(id: string, jobId: string): Approval | undefined {
    return this.ledger.db.prepare('SELECT * FROM approvals WHERE id=? AND job_id=?').get(id, jobId) as unknown as Approval | undefined;
  }

  list(jobId: string): Approval[] {
    return this.ledger.db.prepare('SELECT * FROM approvals WHERE job_id=? ORDER BY rowid').all(jobId) as unknown as Approval[];
  }

  request(jobId: string, kind: ApprovalKind, payload: unknown, scope: string): Approval {
    const json = JSON.stringify(payload);
    const key = createHash('sha256').update(JSON.stringify([jobId, kind, scope, json])).digest('hex');
    const inserted = this.ledger.db.prepare(`INSERT OR IGNORE INTO approvals
      (id,job_id,kind,payload_json,status,request_key,created_ts) VALUES (?,?,?,?,'pending',?,?)`)
      .run(randomUUID(), jobId, kind, json, key, new Date().toISOString());
    if (inserted.changes) this.ledger.appendEvent(jobId, 'approval', 'approval.requested', { kind, requestKey: key });
    return this.ledger.db.prepare('SELECT * FROM approvals WHERE request_key=?').get(key) as unknown as Approval;
  }

  decide(id: string, jobId: string, approved: boolean, actor: string): Approval {
    const result = this.ledger.db.prepare(`UPDATE approvals SET status=?,actor=?,decided_ts=?
      WHERE id=? AND job_id=? AND status='pending'`).run(approved ? 'approved' : 'rejected', actor, new Date().toISOString(), id, jobId);
    if (result.changes !== 1) throw new Error('审批不存在或已处理，请刷新');
    this.ledger.appendEvent(jobId, actor, 'approval.decided', { id, approved });
    return this.get(id, jobId)!;
  }

  claim(id: string, jobId: string): boolean {
    return this.ledger.db.prepare("UPDATE approvals SET status='executing' WHERE id=? AND job_id=? AND status='approved'")
      .run(id, jobId).changes === 1;
  }

  finish(id: string, jobId: string, ok: boolean, result: unknown): void {
    this.ledger.db.prepare("UPDATE approvals SET status=?,result_json=? WHERE id=? AND job_id=? AND status='executing'")
      .run(ok ? 'completed' : 'failed', JSON.stringify(result), id, jobId);
  }
}

export async function requireApproval(store: ApprovalStore, jobId: string, kind: ApprovalKind,
  payload: unknown, scope: string, responder?: HitlResponder): Promise<Approval | undefined> {
  if (store.mode(jobId) !== 'strict') return undefined;
  let approval = store.request(jobId, kind, payload, scope);
  if (approval.status === 'pending' && responder) {
    const answer = await responder.ask({ id: approval.id, node: kind,
      question: `${kind}\n${approval.payload_json}`, options: ['批准', '拒绝'], recommendedOption: '拒绝', blocking: true });
    if (/auto/i.test(answer.actor)) throw new ApprovalPendingError(approval);
    approval = store.decide(approval.id, jobId, answer.answer === '批准', answer.actor);
  }
  if (approval.status === 'pending') throw new ApprovalPendingError(approval);
  if (approval.status === 'rejected') throw new ApprovalRejectedError();
  return approval;
}
