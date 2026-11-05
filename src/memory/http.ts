import type { Ledger } from '../core/ledger.ts';
import { MemoryService } from './service.ts';

/** 返回 undefined 表示非记忆路由。身份由本地人机接口固定，模型工具池不暴露管理写接口。 */
export function memoryRoute(ledger: Ledger, method: string, pathname: string, body: Record<string, unknown>): unknown {
  const memory = new MemoryService(ledger);
  if (pathname === '/api/memory' && method === 'GET') return { families: memory.families(), versions: memory.versions(), proposals: memory.proposals() };
  if (pathname === '/api/memory/families' && method === 'POST') return { family: memory.createFamily(String(body.name ?? ''), String(body.description ?? '')) };
  const jobMatch = /^\/api\/memory\/jobs\/([^/]+)$/.exec(pathname);
  if (jobMatch && method === 'GET') {
    const id = decodeURIComponent(jobMatch[1]);
    const job = ledger.getJob(id);
    if (!job) throw new Error('来源任务不存在');
    const binding = memory.binding(id);
    return { view: memory.getJobView(id, 'coordinator'), profile: binding ? JSON.parse(binding.snapshot_json) : job.jd_json && job.scorecard_json ? { jd: JSON.parse(job.jd_json), scorecard: JSON.parse(job.scorecard_json) } : null };
  }
  if (pathname === '/api/memory/proposals' && method === 'POST') {
    return { proposal: memory.proposePolicy({ familyId: String(body.familyId ?? ''),
      sourceJobId: typeof body.sourceJobId === 'string' && body.sourceJobId ? body.sourceJobId : undefined,
      baseVersionId: typeof body.baseVersionId === 'string' ? body.baseVersionId : undefined,
      rule: String(body.rule ?? ''), why: String(body.why ?? ''), howToApply: String(body.howToApply ?? ''),
      profile: body.profile, validFrom: typeof body.validFrom === 'string' && body.validFrom ? body.validFrom : undefined,
      validTo: typeof body.validTo === 'string' && body.validTo ? body.validTo : undefined }) };
  }
  const decision = /^\/api\/memory\/proposals\/([^/]+)\/decision$/.exec(pathname);
  if (decision && method === 'POST') {
    const id = decodeURIComponent(decision[1]);
    const hash = String(body.contentHash ?? '');
    if (body.decision === 'approve') return { version: memory.approveProposal(id, hash, 'HR(web)') };
    if (body.decision !== 'reject' && body.decision !== 'withdraw') throw new Error('无效提案决定');
    memory.rejectProposal(id, hash, 'HR(web)', body.decision === 'withdraw');
    return { proposal: memory.proposal(id) };
  }
  const retire = /^\/api\/memory\/versions\/([^/]+)\/retire$/.exec(pathname);
  if (retire && method === 'POST') { memory.retireVersion(decodeURIComponent(retire[1])); return { retired: true }; }
  throw new Error('未知记忆接口');
}
