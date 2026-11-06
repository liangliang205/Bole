import type { Ledger } from '../core/ledger.ts';
import { WorkflowStore } from './store.ts';
import { z } from 'zod';
import { ExecutionScheduler } from '../scheduler/execution.ts';

/** Local human-facing inspection/confirmation only; never exposed as an Agent tool. */
export function workflowRoute(ledger: Ledger, method: string, pathname: string, body: unknown = {}): unknown {
  const match = /^\/api\/run\/([^/]+)\/workflow(?:\/(confirm))?$/.exec(pathname);
  if (!match) throw new Error('未知工作流接口');
  const jobId = decodeURIComponent(match[1]);
  if (!ledger.getJob(jobId)) throw new Error('任务不存在');
  const store = new WorkflowStore(ledger);
  if (method === 'GET' && !match[2]) return { ...store.inspect(jobId), queue: new ExecutionScheduler(ledger).list(jobId) };
  if (method === 'POST' && match[2] === 'confirm') {
    const request = z.discriminatedUnion('action', [
      z.object({ runId: z.string(), path: z.string(), action: z.literal('retry') }).strict(),
      z.object({ runId: z.string(), path: z.string(), action: z.literal('complete'), output: z.json() }).strict(),
    ]).parse(body);
    if (store.get(request.runId).job_id !== jobId) throw new Error('节点不属于当前任务');
    store.confirm(request.runId, request.path, request, 'HR');
    return { confirmed: true, resumeRequired: true };
  }
  throw new Error('不支持的工作流操作');
}
