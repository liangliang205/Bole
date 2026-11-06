import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Ledger } from '../core/ledger.ts';
import { json } from '../workflow/store.ts';
import { WorkflowBusyError } from '../workflow/types.ts';

export interface Resource { key: string; capacity: number }
const current = new AsyncLocalStorage<string>();
export function currentExecutionId(): string | undefined { return current.getStore(); }
export interface ExecutionRow {
  id: string; run_id: string; root_run_id: string; node_path: string; label: string;
  resources_json: string; priority: number; state: string; reason: string | null;
  owner: string | null; attempts: number; created_at: number; updated_at: number;
}
export interface ExecutionScope { runId: string; rootRunId: string; nodePath: string; checkpoint: () => void }

/** Small persistent admission layer. Dependencies and results belong to the workflow engine. */
export class ExecutionScheduler {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  list(jobId: string): ExecutionRow[] {
    const rows = this.ledger.db.prepare(`SELECT q.*, root.lease_owner AS live_owner, root.lease_until AS live_until, root.status AS live_status
      FROM execution_queue q JOIN workflow_runs r ON r.id=q.run_id JOIN workflow_runs root ON root.id=q.root_run_id
      WHERE r.job_id=? ORDER BY q.created_at,q.rowid`).all(jobId) as unknown as (ExecutionRow & { live_owner: string | null; live_until: number | null; live_status: string })[];
    return rows.map(({ live_owner, live_until, live_status, ...row }) => ['queued', 'running'].includes(row.state)
      && (live_owner !== row.owner || (live_until ?? 0) <= Date.now() || live_status !== 'running')
      ? { ...row, state: 'interrupted', reason: '执行者已停止或租约失效，等待检查点恢复' } : row);
  }
  enqueue(scope: ExecutionScope, label: string, resources: Resource[], priority = 1): ExecutionRow {
    if (!label || !resources.length || new Set(resources.map((r) => r.key)).size !== resources.length
      || resources.some((r) => !r.key || !Number.isInteger(r.capacity) || r.capacity < 1 || r.capacity > 128)
      || !Number.isInteger(priority) || priority < 0 || priority > 2) throw new Error('执行资源或优先级不合法');
    const db = this.ledger.db; const now = Date.now();
    const root = db.prepare('SELECT lease_owner,lease_until,status FROM workflow_runs WHERE id=?').get(scope.rootRunId);
    if (!root?.lease_owner || Number(root.lease_until) <= now || root.status !== 'running') throw new Error('执行队列需要有效的根运行租约');
    const old = db.prepare('SELECT * FROM execution_queue WHERE run_id=? AND node_path=? AND label=?').get(scope.runId, scope.nodePath, label) as unknown as ExecutionRow | undefined;
    if (old) {
      if (old.resources_json !== json(resources)) throw new Error('恢复时不能改变执行资源约束');
      if (['queued', 'running'].includes(old.state) && old.owner === root.lease_owner) throw new WorkflowBusyError();
      db.prepare("UPDATE execution_queue SET state='queued',reason='等待容量',owner=?,updated_at=? WHERE id=?").run(String(root.lease_owner), now, old.id);
      return { ...old, state: 'queued', owner: String(root.lease_owner) };
    }
    const id = randomUUID();
    db.prepare("INSERT INTO execution_queue (id,run_id,root_run_id,node_path,label,resources_json,priority,state,reason,owner,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued','等待容量',?,?,?)")
      .run(id, scope.runId, scope.rootRunId, scope.nodePath, label, json(resources), priority, String(root.lease_owner), now, now);
    return db.prepare('SELECT * FROM execution_queue WHERE id=?').get(id) as unknown as ExecutionRow;
  }
  private claim(row: ExecutionRow): boolean {
    const db = this.ledger.db; db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      // Orphaned reservations must never consume live capacity.
      db.prepare(`UPDATE execution_queue SET state='interrupted',reason='执行者租约已失效',updated_at=? WHERE state IN ('queued','running')
        AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=execution_queue.root_run_id AND r.lease_owner=execution_queue.owner AND r.lease_until>? AND r.status='running')`).run(now, now);
      const live = db.prepare("SELECT * FROM execution_queue WHERE state IN ('queued','running') ORDER BY created_at,rowid").all() as unknown as ExecutionRow[];
      const current = live.find((r) => r.id === row.id);
      if (!current || current.state !== 'queued' || current.owner !== row.owner) { db.exec('COMMIT'); return false; }
      const running = live.filter((r) => r.state === 'running');
      const demands = (r: ExecutionRow) => JSON.parse(r.resources_json) as Resource[];
      const available = (r: ExecutionRow) => demands(r).every((resource) => {
        const reservations = running.flatMap(demands).filter((v) => v.key === resource.key);
        const external = resource.key.startsWith('agent:') ? Number(db.prepare(`SELECT COUNT(*) AS n FROM agent_invocations i
          WHERE i.version_key=? AND i.state='running' AND i.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM execution_queue q WHERE q.id=json_extract(i.meta_json,'$.executionId') AND q.state='running')`)
          .get(resource.key.slice(6), new Date(now).toISOString())?.n ?? 0) : 0;
        return reservations.length + external < Math.min(resource.capacity, ...reservations.map((v) => v.capacity));
      });
      const effective = (r: ExecutionRow) => Math.min(2, r.priority + Math.floor((now - r.created_at) / 60000));
      const ready = live.filter((r) => r.state === 'queued' && available(r)).sort((a, b) => effective(b) - effective(a) || a.created_at - b.created_at);
      // Unrelated resources can progress independently. Only an earlier feasible competitor blocks us.
      const keys = new Set(demands(current).map((r) => r.key));
      const earlier = ready.slice(0, ready.findIndex((r) => r.id === row.id));
      const reason = !available(current) ? '等待执行容量' : earlier.some((r) => demands(r).some((v) => keys.has(v.key))) ? '等待更早或更高优先级任务' : null;
      if (reason) { db.prepare('UPDATE execution_queue SET reason=?,updated_at=? WHERE id=? AND reason IS NOT ?').run(reason, now, row.id, reason); db.exec('COMMIT'); return false; }
      db.prepare("UPDATE execution_queue SET state='running',attempts=attempts+1,reason=NULL,updated_at=? WHERE id=? AND owner=? AND state='queued'").run(now, row.id, row.owner);
      db.exec('COMMIT'); return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async run<T>(scope: ExecutionScope, label: string, resources: Resource[], execute: () => Promise<T>, priority = 1): Promise<T> {
    scope.checkpoint(); const row = this.enqueue(scope, label, resources, priority);
    try {
      while (!this.claim(row)) { scope.checkpoint(); await delay(40); }
      scope.checkpoint();
      const result = await current.run(row.id, execute);
      this.finish(row, 'succeeded', null); return result;
    } catch (error) { this.finish(row, 'stopped', error instanceof Error ? error.message : String(error)); throw error; }
  }
  private finish(row: ExecutionRow, state: string, reason: string | null): void {
    // A stale executor cannot release or overwrite a reservation claimed by its successor.
    this.ledger.db.prepare(`UPDATE execution_queue SET state=?,reason=?,updated_at=? WHERE id=? AND owner=?
      AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=execution_queue.root_run_id AND r.lease_owner=execution_queue.owner AND r.lease_until>?)`).run(state, reason, Date.now(), row.id, row.owner, Date.now());
  }
}
