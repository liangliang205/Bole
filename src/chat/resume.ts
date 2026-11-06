import { ApprovalStore, requireApproval } from '../core/approvals.ts';
import type { Ledger } from '../core/ledger.ts';
import { WorkflowStore } from '../workflow/store.ts';

export function resumeSnapshot(ledger: Ledger, jobId: string) {
  const job = ledger.getJob(jobId); if (!job) throw new Error('任务不存在');
  const root = new WorkflowStore(ledger).root(jobId);
  if (root && ['succeeded', 'cancelled'].includes(root.status)) throw new Error('该工作流已结束，不能通过续跑修改历史结果；如仍有遗漏材料，请新建筛选会话');
  if (root?.lease_owner && (root.lease_until ?? 0) > Date.now()) throw new Error('任务正在执行，不能重复续跑');
  if (root?.status === 'waiting_confirmation') throw new Error('存在外部操作结果待确认，请先在任务面板完成人工确认');
  const blocked = new ApprovalStore(ledger).list(jobId).some((a) => a.kind !== 'tool' && ['pending', 'rejected'].includes(a.status));
  if (blocked) throw new Error('请先处理现有审批；拒绝的快照不能直接续跑');
  return { action: 'resume_workflow', jobId, rootRunId: root?.id ?? null, definitionHash: root?.definition_hash ?? null };
}
export async function requestChatResume(ledger: Ledger, jobId: string, start: () => Promise<unknown>): Promise<void> {
  const snapshot = resumeSnapshot(ledger, jobId);
  await requireApproval(new ApprovalStore(ledger), jobId, 'workflow', { ...snapshot, title: '续跑当前筛选任务', scope: '从已有检查点继续；不修改已提交结果，不自动批准后续节点' }, `chat-resume:${snapshot.rootRunId ?? jobId}`);
  await start();
}
