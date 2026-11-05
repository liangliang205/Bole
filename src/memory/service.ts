import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from '../tools/scorecard.ts';
import type { Ledger } from '../core/ledger.ts';
import { ApprovalStore } from '../core/approvals.ts';
import { jdAnalysisSchema } from '../schemas.ts';
import { maskPII } from '../util/text.ts';
import { reviewRequirements } from '../tools/fairness.ts';
import type { JobFamily, PolicyBinding, PolicyProfile, PolicyProposal, PolicyVersion, ProposalInput } from './types.ts';

export function memoryHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function clean(value: string): string { return maskPII(value.trim()); }
function required(value: string, field: string): string {
  if (!value?.trim() || value.length > 4000) throw new Error(`${field}需为 1–4000 字符`);
  return clean(value);
}
function profileOf(value: unknown): PolicyProfile {
  const schema = jdAnalysisSchema.pick({ jd: true, scorecard: true }).extend({ thresholds: z.object({
    strong_yes: z.number().min(0).max(100), yes: z.number().min(0).max(100), maybe: z.number().min(0).max(100), no: z.number().min(0).max(100),
  }).default(DEFAULT_THRESHOLDS) });
  const result = schema.parse(value);
  const t = result.thresholds;
  if (!(t.strong_yes > t.yes && t.yes > t.maybe && t.maybe > t.no)) throw new Error('结论阈值必须严格递减');
  const dimensions = result.scorecard.dimensions;
  if (new Set(dimensions.map((d) => d.key)).size !== dimensions.length) throw new Error('评分维度 key 不能重复');
  if (Math.abs(dimensions.reduce((n, d) => n + d.weight, 0) - 100) > 0.01) throw new Error('评分权重合计必须为 100');
  if (reviewRequirements(JSON.stringify(result)).removed.length) throw new Error('长期评分标准不能含受保护属性条件，请人工检查');
  const sanitize = (entry: unknown): unknown => typeof entry === 'string' ? clean(entry) : Array.isArray(entry)
    ? entry.map(sanitize) : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, sanitize(v)])) : entry;
  return schema.parse(sanitize(result));
}

/** 不接收模型自报角色作为授权；写接口由服务端的人机入口调用。 */
export class MemoryService {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  private transaction<T>(operation: () => T): T {
    this.ledger.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.ledger.db.exec('COMMIT'); return value; }
    catch (error) { this.ledger.db.exec('ROLLBACK'); throw error; }
  }
  families(): JobFamily[] { return this.ledger.db.prepare('SELECT * FROM job_families ORDER BY created_at,id').all() as unknown as JobFamily[]; }
  createFamily(name: string, description = ''): JobFamily {
    const row = { id: randomUUID(), name: required(name, '岗位族名称'), description: clean(description).slice(0, 2000), created_at: new Date().toISOString() };
    this.ledger.db.prepare('INSERT INTO job_families VALUES (?,?,?,?)').run(row.id, row.name, row.description, row.created_at);
    return row;
  }
  versions(familyId?: string): PolicyVersion[] {
    return this.ledger.db.prepare(`SELECT * FROM scorecard_versions ${familyId ? 'WHERE family_id=?' : ''} ORDER BY version DESC`)
      .all(...(familyId ? [familyId] : [])) as unknown as PolicyVersion[];
  }
  version(id: string): PolicyVersion {
    const row = this.ledger.db.prepare('SELECT * FROM scorecard_versions WHERE id=?').get(id) as unknown as PolicyVersion | undefined;
    if (!row) throw new Error('评分标准版本不存在');
    return row;
  }
  recallPolicies(familyId: string, now = new Date().toISOString()): PolicyVersion[] {
    return this.versions(familyId).filter((v) => v.status === 'approved' && v.valid_from <= now && (!v.valid_to || v.valid_to > now)).slice(0, 5);
  }
  proposals(): PolicyProposal[] { return this.ledger.db.prepare('SELECT * FROM memory_proposals ORDER BY created_at DESC').all() as unknown as PolicyProposal[]; }
  proposal(id: string): PolicyProposal {
    const row = this.ledger.db.prepare('SELECT * FROM memory_proposals WHERE id=?').get(id) as unknown as PolicyProposal | undefined;
    if (!row) throw new Error('修订提案不存在');
    return row;
  }
  proposePolicy(input: ProposalInput): PolicyProposal {
    const profile = profileOf(input.profile);
    if (!this.families().some((f) => f.id === input.familyId)) throw new Error('岗位族不存在');
    if (input.sourceJobId && !this.ledger.getJob(input.sourceJobId)) throw new Error('来源任务不存在');
    const base = input.baseVersionId ? this.version(input.baseVersionId) : null;
    if (base && base.family_id !== input.familyId) throw new Error('基线版本不属于此岗位族');
    const rule = required(input.rule, '修订规则');
    const why = required(input.why, '修订原因');
    const how = required(input.howToApply, '应用方式');
    const validFrom = input.validFrom ? new Date(input.validFrom).toISOString() : new Date().toISOString();
    const validTo = input.validTo ? new Date(input.validTo).toISOString() : null;
    if (validTo && validTo <= validFrom) throw new Error('有效期结束必须晚于开始');
    return this.transaction(() => {
      const id = randomUUID();
      const payload = { proposalId: id, familyId: input.familyId, baseVersionId: base?.id ?? null,
        profile, rule, why, howToApply: how, validFrom, validTo, impact: '仅影响之后显式选择此版本的新任务' };
      const approval = new ApprovalStore(this.ledger).request(input.sourceJobId ?? `family:${input.familyId}`, 'memory-policy-change', payload, id);
      this.ledger.db.prepare(`INSERT INTO memory_proposals
        (id,family_id,source_job_id,base_version_id,rule,why,how_to_apply,profile_json,content_hash,valid_from,valid_to,status,approval_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, input.familyId, input.sourceJobId ?? null, base?.id ?? null,
          rule, why, how, JSON.stringify(profile), memoryHash(payload), validFrom, validTo, approval.id, new Date().toISOString());
      return this.proposal(id);
    });
  }
  approveProposal(id: string, hash: string, actor: string): PolicyVersion {
    if (!actor.trim() || /auto|agent|model/i.test(actor)) throw new Error('长期规则必须由真人确认');
    return this.transaction(() => {
      const proposal = this.proposal(id);
      if (proposal.content_hash !== hash) throw new Error('提案已变化，请重新审阅');
      if (proposal.status === 'approved') return this.version(proposal.published_version_id!);
      if (proposal.status !== 'pending') throw new Error('提案已拒绝或撤回');
      const latest = this.versions(proposal.family_id)[0];
      if ((latest?.id ?? null) !== proposal.base_version_id) throw new Error('基线版本已变化，请基于最新版本重新提案');
      const store = new ApprovalStore(this.ledger);
      const approval = store.get(proposal.approval_id, proposal.source_job_id ?? `family:${proposal.family_id}`);
      if (!approval || memoryHash(JSON.parse(approval.payload_json)) !== hash) throw new Error('审批内容与提案不一致');
      profileOf(JSON.parse(proposal.profile_json));
      store.decide(approval.id, approval.job_id, true, actor);
      const versionId = randomUUID();
      this.ledger.db.prepare(`INSERT INTO scorecard_versions
        (id,family_id,version,parent_id,profile_json,content_hash,status,valid_from,valid_to,created_at,approved_by,approval_id)
        VALUES (?,?,?,?,?,?,'approved',?,?,?,?,?)`).run(versionId, proposal.family_id, (latest?.version ?? 0) + 1,
          proposal.base_version_id, proposal.profile_json, memoryHash(JSON.parse(proposal.profile_json)),
          proposal.valid_from, proposal.valid_to, new Date().toISOString(), actor, approval.id);
      this.ledger.db.prepare("UPDATE memory_proposals SET status='approved',published_version_id=? WHERE id=?").run(versionId, id);
      this.ledger.appendEvent(proposal.source_job_id, actor, 'memory.policy.published', { proposalId: id, versionId });
      return this.version(versionId);
    });
  }
  rejectProposal(id: string, hash: string, actor: string, withdraw = false): void {
    this.transaction(() => {
      const proposal = this.proposal(id);
      if (proposal.content_hash !== hash || proposal.status !== 'pending') throw new Error('提案已变化或已处理');
      new ApprovalStore(this.ledger).decide(proposal.approval_id, proposal.source_job_id ?? `family:${proposal.family_id}`, false, actor);
      this.ledger.db.prepare('UPDATE memory_proposals SET status=? WHERE id=?').run(withdraw ? 'withdrawn' : 'rejected', id);
    });
  }
  retireVersion(id: string): void {
    this.version(id);
    this.ledger.db.prepare("UPDATE scorecard_versions SET status='retired' WHERE id=?").run(id);
    this.ledger.appendEvent(null, 'HR', 'memory.policy.retired', { versionId: id });
  }
  selectPolicy(jobId: string, versionId: string): void {
    const job = this.ledger.getJob(jobId);
    if (!job || job.jd_json || this.binding(jobId)) throw new Error('只能为尚未开始画像的任务选择版本');
    const version = this.version(versionId);
    if (!this.recallPolicies(version.family_id).some((v) => v.id === versionId)) throw new Error('版本已退役、过期或尚未生效');
    this.ledger.db.prepare('INSERT INTO job_policy_selections VALUES (?,?)').run(jobId, versionId);
  }
  selectedPolicy(jobId: string): PolicyVersion | undefined {
    const selection = this.ledger.db.prepare('SELECT version_id FROM job_policy_selections WHERE job_id=?').get(jobId) as { version_id: string } | undefined;
    return selection ? this.version(selection.version_id) : undefined;
  }
  binding(jobId: string): PolicyBinding | undefined {
    return this.ledger.db.prepare('SELECT * FROM job_policy_bindings WHERE job_id=?').get(jobId) as unknown as PolicyBinding | undefined;
  }
  bindJob(jobId: string, profile: PolicyProfile, versionId: string | null): PolicyBinding {
    profile = { ...profile, thresholds: profile.thresholds ?? DEFAULT_THRESHOLDS };
    const existing = this.binding(jobId);
    if (existing) {
      if (existing.snapshot_hash !== memoryHash(profile) || existing.version_id !== versionId) throw new Error('任务评分标准已经冻结');
      return existing;
    }
    if (versionId) {
      const standard = JSON.parse(this.version(versionId).profile_json) as PolicyProfile;
      if (memoryHash(standard.scorecard) !== memoryHash(profile.scorecard) || memoryHash(standard.thresholds ?? DEFAULT_THRESHOLDS) !== memoryHash(profile.thresholds)) throw new Error('任务标准与引用版本不一致');
    }
    const job = this.ledger.getJob(jobId);
    if (!job || job.jd_json !== JSON.stringify(profile.jd) || job.scorecard_json !== JSON.stringify(profile.scorecard)) throw new Error('绑定必须与任务已保存的画像一致');
    this.ledger.db.prepare('INSERT INTO job_policy_bindings VALUES (?,?,?,?,?)')
      .run(jobId, versionId, JSON.stringify(profile), memoryHash(profile), new Date().toISOString());
    return this.binding(jobId)!;
  }
  getJobView(jobId: string, role: string) {
    if (!['coordinator', 'profiler', 'parser', 'assessor', 'auditor', 'fetcher'].includes(role)) throw new Error('未知记忆角色');
    const job = this.ledger.getJob(jobId);
    if (!job) throw new Error('任务不存在');
    return { jobId, status: job.status, binding: role === 'fetcher' ? null : this.binding(jobId) ?? null,
      decisions: ['coordinator', 'profiler', 'auditor'].includes(role) ? this.ledger.listDecisions(jobId) : [],
      summaries: role === 'coordinator' ? this.ledger.db.prepare('SELECT id,from_seq,through_seq,source_hash,created_at FROM memory_summaries WHERE job_id=? ORDER BY rowid DESC LIMIT 1').all(jobId) : [],
      counts: this.ledger.resumeCounts(jobId),
      source: '任务台账与绑定快照；候选人原文须通过对应任务证据读取' };
  }
}
