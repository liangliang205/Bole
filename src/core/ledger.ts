import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import { newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import {
  AlreadyCommittedError,
  assertTransition,
  combineStopReasons,
} from './state.ts';
import type {
  DecisionRow,
  EvalResult,
  EvidenceRow,
  EventRow,
  Jd,
  JobRow,
  ParseResult,
  ResumeRow,
  ResumeStatus,
  ReviewResult,
  Scorecard,
  StopReason,
  TaskKind,
  TaskRow,
  TaskStatus,
  UsageRow,
} from '../types.ts';

const TASK_TABLE: Record<TaskKind, string> = {
  parse: 'parse_tasks',
  eval: 'eval_tasks',
  review: 'review_tasks',
};

const COMMON_TASK_COLUMNS = [
  'status',
  'stop_reason',
  'attempt',
  'worker_id',
  'result_path',
  'error_json',
];

const TASK_COLUMNS: Record<TaskKind, string[]> = {
  parse: [...COMMON_TASK_COLUMNS, 'fields_json', 'spans_json', 'anomalies_json'],
  eval: [
    ...COMMON_TASK_COLUMNS,
    'scores_json',
    'total_score',
    'conclusion',
    'evidence_refs_json',
    'rationale_json',
    'revision_of',
    'feedback_json',
    'tier',
    'phase',
  ],
  review: [
    ...COMMON_TASK_COLUMNS,
    'verdict',
    'checks_json',
    'compliance_json',
    'required_fixes_json',
    'escalation_reason',
    'loop_count',
  ],
};

export class Ledger {
  readonly db: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as unknown as T[];
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as unknown as T | undefined;
  }

  private run(sql: string, ...params: unknown[]): void {
    this.stmt(sql).run(...(params as never[]));
  }

  // ---------------------------------------------------------------- jobs

  createJob(input: { title: string; requirements: string; seed?: string }): JobRow {
    const id = newId('job');
    const ts = nowIso();
    this.run(
      `INSERT INTO jobs (id,title,requirements,jd_json,scorecard_json,status,seed,created_ts,updated_ts)
       VALUES (?,?,?,NULL,NULL,?,?,?,?)`,
      id,
      input.title,
      input.requirements,
      'profiling',
      input.seed ?? null,
      ts,
      ts,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
  }

  latestJob(): JobRow | undefined {
    return this.get<JobRow>('SELECT * FROM jobs ORDER BY created_ts DESC, rowid DESC LIMIT 1');
  }

  listJobs(): JobRow[] {
    return this.all<JobRow>('SELECT * FROM jobs ORDER BY created_ts DESC');
  }

  saveJobAnalysis(jobId: string, jd: Jd, scorecard: Scorecard, title: string, fairness?: unknown): void {
    this.run(
      'UPDATE jobs SET jd_json=?, scorecard_json=?, fairness_json=?, title=?, updated_ts=? WHERE id=?',
      JSON.stringify(jd),
      JSON.stringify(scorecard),
      fairness ? JSON.stringify(fairness) : null,
      title,
      nowIso(),
      jobId,
    );
  }

  setJobStatus(jobId: string, status: string): void {
    this.run('UPDATE jobs SET status=?, updated_ts=? WHERE id=?', status, nowIso(), jobId);
  }

  // -------------------------------------------------------------- resumes

  insertResume(row: {
    id: string;
    jobId: string;
    label: string;
    sha256: string;
    dedupKey: string;
    sourceMsgId: string;
    sourcePath: string;
    rawPath: string;
    normPath: string;
    format: string;
    status: ResumeStatus;
    reasons?: string[];
  }): ResumeRow {
    const ts = nowIso();
    this.run(
      `INSERT INTO resumes (id,job_id,label,sha256,dedup_key,source_msg_id,source_path,raw_path,norm_path,format,status,reasons_json,created_ts,updated_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.jobId,
      row.label,
      row.sha256,
      row.dedupKey,
      row.sourceMsgId,
      row.sourcePath,
      row.rawPath,
      row.normPath,
      row.format,
      row.status,
      JSON.stringify(row.reasons ?? []),
      ts,
      ts,
    );
    return this.getResume(row.id)!;
  }

  getResume(id: string): ResumeRow | undefined {
    return this.get<ResumeRow>('SELECT * FROM resumes WHERE id = ?', id);
  }

  findResumeByDedup(jobId: string, dedupKey: string, sha256: string): ResumeRow | undefined {
    return this.get<ResumeRow>(
      'SELECT * FROM resumes WHERE job_id=? AND (dedup_key=? OR sha256=?) AND status != ? LIMIT 1',
      jobId,
      dedupKey,
      sha256,
      'duplicate',
    );
  }

  listResumes(jobId: string, status?: ResumeStatus): ResumeRow[] {
    if (status) {
      return this.all<ResumeRow>(
        'SELECT * FROM resumes WHERE job_id=? AND status=? ORDER BY label',
        jobId,
        status,
      );
    }
    return this.all<ResumeRow>('SELECT * FROM resumes WHERE job_id=? ORDER BY label', jobId);
  }

  setResumeStatus(id: string, status: ResumeStatus, reason?: string): void {
    const current = this.getResume(id);
    if (!current) throw new Error(`简历不存在: ${id}`);
    if (current.status !== status) assertTransition('resume', current.status, status);
    const reasons = reason
      ? [...(JSON.parse(current.reasons_json) as string[]), reason]
      : (JSON.parse(current.reasons_json) as string[]);
    this.run(
      'UPDATE resumes SET status=?, reasons_json=?, updated_ts=? WHERE id=?',
      status,
      JSON.stringify(reasons),
      nowIso(),
      id,
    );
  }

  assignBatch(resumeIds: string[], batchId: number): void {
    for (const id of resumeIds) {
      this.run('UPDATE resumes SET batch_id=?, updated_ts=? WHERE id=?', batchId, nowIso(), id);
    }
  }

  /** 仅用于批次级检查点恢复：把未完成简历重置到可重入状态，并保留原因供审计。 */
  forceResumeStatus(id: string, status: ResumeStatus, reason: string): void {
    const current = this.getResume(id);
    if (!current) throw new Error(`简历不存在: ${id}`);
    const reasons = [...(JSON.parse(current.reasons_json) as string[]), `恢复重置：${reason}`];
    this.run(
      'UPDATE resumes SET status=?, reasons_json=?, updated_ts=? WHERE id=?',
      status,
      JSON.stringify(reasons),
      nowIso(),
      id,
    );
  }

  // ---------------------------------------------------------------- tasks

  createTask(kind: TaskKind, input: {
    jobId: string;
    resumeId: string;
    batchId: number;
    workerId?: string;
    revisionOf?: string;
    feedback?: unknown;
    tier?: string;
    phase?: string;
    extra?: Record<string, unknown>;
  }): TaskRow {
    const id = newId(kind);
    const ts = nowIso();
    const table = TASK_TABLE[kind];
    if (kind === 'parse') {
      this.run(
        `INSERT INTO parse_tasks (id,job_id,resume_id,batch_id,status,attempt,worker_id,created_ts,updated_ts)
         VALUES (?,?,?,?,?,0,?,?,?)`,
        id, input.jobId, input.resumeId, input.batchId, 'pending', input.workerId ?? null, ts, ts,
      );
    } else if (kind === 'eval') {
      this.run(
        `INSERT INTO eval_tasks (id,job_id,resume_id,batch_id,status,attempt,worker_id,revision_of,feedback_json,tier,phase,created_ts,updated_ts)
         VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?)`,
        id,
        input.jobId,
        input.resumeId,
        input.batchId,
        'pending',
        input.workerId ?? null,
        input.revisionOf ?? null,
        input.feedback ? JSON.stringify(input.feedback) : null,
        input.tier ?? null,
        input.phase ?? null,
        ts,
        ts,
      );
    } else {
      this.run(
        `INSERT INTO review_tasks (id,job_id,resume_id,eval_task_id,batch_id,status,attempt,worker_id,loop_count,created_ts,updated_ts)
         VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
        id,
        input.jobId,
        input.resumeId,
        String(input.extra?.evalTaskId ?? ''),
        input.batchId,
        'pending',
        input.workerId ?? null,
        Number(input.extra?.loopCount ?? 0),
        ts,
        ts,
      );
    }
    return this.getTask(kind, id)!;
  }

  getTask(kind: TaskKind, id: string): TaskRow | undefined {
    return this.get<TaskRow>(`SELECT * FROM ${TASK_TABLE[kind]} WHERE id = ?`, id);
  }

  listTasks(kind: TaskKind, filter: { jobId?: string; batchId?: number; status?: TaskStatus } = {}): TaskRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.jobId) {
      clauses.push('job_id=?');
      params.push(filter.jobId);
    }
    if (filter.batchId !== undefined) {
      clauses.push('batch_id=?');
      params.push(filter.batchId);
    }
    if (filter.status) {
      clauses.push('status=?');
      params.push(filter.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.all<TaskRow>(
      `SELECT * FROM ${TASK_TABLE[kind]}${where} ORDER BY created_ts, rowid`,
      ...params,
    );
  }

  latestEvalTask(resumeId: string): TaskRow | undefined {
    return this.get<TaskRow>(
      'SELECT * FROM eval_tasks WHERE resume_id=? ORDER BY created_ts DESC, rowid DESC LIMIT 1',
      resumeId,
    );
  }

  listReviewsForEval(evalTaskId: string): TaskRow[] {
    return this.all<TaskRow>(
      'SELECT * FROM review_tasks WHERE eval_task_id=? ORDER BY created_ts, rowid',
      evalTaskId,
    );
  }

  updateTask(kind: TaskKind, id: string, patch: Record<string, unknown>): TaskRow {
    const current = this.getTask(kind, id);
    if (!current) throw new Error(`任务不存在: ${kind}/${id}`);
    if (current.status === 'committed') throw new AlreadyCommittedError(id);
    const allowed = new Set(TASK_COLUMNS[kind]);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      if (key === 'status') {
        const next = value as TaskStatus;
        if (next !== current.status) assertTransition('task', current.status, next);
      }
      sets.push(`${key}=?`);
      params.push(value as string | number | null);
    }
    if (sets.length === 0) return current;
    sets.push('updated_ts=?');
    params.push(nowIso());
    params.push(id);
    this.run(`UPDATE ${TASK_TABLE[kind]} SET ${sets.join(', ')} WHERE id=?`, ...params);
    return this.getTask(kind, id)!;
  }

  transitionTask(kind: TaskKind, id: string, status: TaskStatus, extra: Record<string, unknown> = {}): TaskRow {
    return this.updateTask(kind, id, { ...extra, status });
  }

  commitTask(kind: TaskKind, id: string, resultPath: string, dataFields: Record<string, unknown> = {}): TaskRow {
    const current = this.getTask(kind, id);
    if (!current) throw new Error(`任务不存在: ${kind}/${id}`);
    if (current.status === 'committed') throw new AlreadyCommittedError(id);
    if (current.status !== 'staged') {
      throw new Error(`任务 ${id} 尚未 staged（当前 ${current.status}），不能提交`);
    }
    return this.updateTask(kind, id, {
      ...dataFields,
      status: 'committed',
      result_path: resultPath,
      stop_reason: 'completed',
      committed_ts: nowIso(),
    });
  }

  failTask(kind: TaskKind, id: string, reason: StopReason, errors: string[]): void {
    const current = this.getTask(kind, id);
    if (!current) return;
    if (current.status === 'committed') return;
    const settled = combineStopReasons((current.stop_reason as StopReason | null) ?? null, reason);
    try {
      if (current.status === 'staged') {
        this.updateTask(kind, id, { status: 'failed' });
      }
      this.updateTask(kind, id, {
        status: 'failed',
        stop_reason: settled,
        error_json: JSON.stringify(errors),
      });
    } catch {
      // 状态机不允许时（例如已失败），只更新结算原因，保证失败语义不被覆盖
      this.run(
        `UPDATE ${TASK_TABLE[kind]} SET stop_reason=?, error_json=?, updated_ts=? WHERE id=? AND status != 'committed'`,
        settled,
        JSON.stringify(errors),
        nowIso(),
        id,
      );
    }
  }

  saveParseResult(taskId: string, result: ParseResult): void {
    const fields = Object.fromEntries(
      Object.entries(result.fields).map(([key, field]) => [
        key,
        { value: field.value, confidence: field.confidence },
      ]),
    );
    const spans = Object.entries(result.fields).flatMap(([key, field]) =>
      field.spans.map((span) => ({ ...span, field: key })),
    );
    this.run(
      'UPDATE parse_tasks SET fields_json=?, spans_json=?, anomalies_json=?, updated_ts=? WHERE id=?',
      JSON.stringify(fields),
      JSON.stringify(spans),
      JSON.stringify(result.anomalies),
      nowIso(),
      taskId,
    );
  }

  saveEvalResult(taskId: string, result: EvalResult): void {
    const refs = result.dimensions.flatMap((d) => d.spans);
    this.run(
      `UPDATE eval_tasks SET scores_json=?, total_score=?, conclusion=?, evidence_refs_json=?, rationale_json=?, updated_ts=? WHERE id=?`,
      JSON.stringify(result.dimensions),
      result.totalScore,
      result.conclusion,
      JSON.stringify(refs),
      JSON.stringify({ rationale: result.rationale, uncertainties: result.uncertainties, redFlags: result.redFlags, revisionNotes: result.revisionNotes }),
      nowIso(),
      taskId,
    );
  }

  saveReviewResult(taskId: string, result: ReviewResult): void {
    this.run(
      `UPDATE review_tasks SET verdict=?, checks_json=?, compliance_json=?, required_fixes_json=?, escalation_reason=?, updated_ts=? WHERE id=?`,
      result.verdict,
      JSON.stringify(result.checks),
      JSON.stringify(result.compliance),
      JSON.stringify(result.requiredFixes),
      result.escalationReason ?? null,
      nowIso(),
      taskId,
    );
  }

  // ------------------------------------------------------------- evidence

  addEvidence(row: {
    jobId: string;
    resumeId: string;
    parseTaskId: string;
    field: string;
    quote: string;
    charStart: number;
    charEnd: number;
  }): string {
    const id = newId('ev');
    this.run(
      `INSERT OR IGNORE INTO evidence (id,job_id,resume_id,parse_task_id,field,quote,char_start,char_end,verified,created_ts)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
      id,
      row.jobId,
      row.resumeId,
      row.parseTaskId,
      row.field,
      row.quote,
      row.charStart,
      row.charEnd,
      nowIso(),
    );
    const existing = this.get<{ id: string }>(
      'SELECT id FROM evidence WHERE resume_id=? AND field=? AND char_start=? AND char_end=?',
      row.resumeId,
      row.field,
      row.charStart,
      row.charEnd,
    );
    return existing?.id ?? id;
  }

  listEvidence(resumeId: string): EvidenceRow[] {
    return this.all<EvidenceRow>(
      'SELECT * FROM evidence WHERE resume_id=? ORDER BY field, char_start',
      resumeId,
    );
  }

  setEvidenceVerification(resumeId: string, verdict: 'supported' | 'unsupported' | 'missing_evidence', note: string): void {
    this.run(
      'UPDATE evidence SET verified=?, verdict=?, note=? WHERE resume_id=?',
      verdict === 'supported' ? 1 : 0,
      verdict,
      note,
      resumeId,
    );
  }

  // --------------------------------------------------------- events/decisions

  appendEvent(jobId: string | null, actor: string, type: string, payload: Record<string, unknown>): EventRow {
    const ts = nowIso();
    let json = JSON.stringify(payload ?? {});
    if (json.length > 8000) json = JSON.stringify({ truncated: true, preview: json.slice(0, 7900) });
    this.stmt('INSERT INTO events (ts,job_id,actor,type,payload_json) VALUES (?,?,?,?,?)').run(
      ts,
      jobId,
      actor,
      type,
      json,
    );
    return this.get<EventRow>('SELECT * FROM events ORDER BY seq DESC LIMIT 1')!;
  }

  listEvents(filter: { jobId?: string; limit?: number; sinceSeq?: number } = {}): EventRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.jobId) {
      clauses.push('job_id=?');
      params.push(filter.jobId);
    }
    if (filter.sinceSeq !== undefined) {
      clauses.push('seq>?');
      params.push(filter.sinceSeq);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 1000;
    const rows = this.all<EventRow>(
      `SELECT * FROM events${where} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.reverse();
  }

  countEvents(jobId: string): number {
    return (this.get<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE job_id=?', jobId)?.c ?? 0);
  }

  addDecision(input: {
    jobId: string;
    node: string;
    question: string;
    answer: string;
    actor: string;
  }): DecisionRow {
    const id = newId('dec');
    const ts = nowIso();
    this.run(
      'INSERT INTO decisions (id,job_id,node,question,answer,actor,ts) VALUES (?,?,?,?,?,?,?)',
      id, input.jobId, input.node, input.question, input.answer, input.actor, ts,
    );
    return this.get<DecisionRow>('SELECT * FROM decisions WHERE id=?', id)!;
  }

  listDecisions(jobId: string): DecisionRow[] {
    return this.all<DecisionRow>('SELECT * FROM decisions WHERE job_id=? ORDER BY ts, rowid', jobId);
  }

  // ------------------------------------------------------------------ usage

  addUsage(row: Omit<UsageRow, 'id' | 'ts'>): void {
    this.run(
      `INSERT INTO usage (id,job_id,agent,model,tier,prompt_tokens,completion_tokens,cached_tokens,cost_usd,latency_ms,ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      newId('use'),
      row.job_id,
      row.agent,
      row.model,
      row.tier,
      row.prompt_tokens,
      row.completion_tokens,
      row.cached_tokens,
      row.cost_usd,
      row.latency_ms,
      nowIso(),
    );
  }

  usageSummary(jobId: string): { agent: string; model: string; tier: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number }[] {
    return this.all(
      `SELECT agent, model, tier, COUNT(*) AS calls,
              SUM(prompt_tokens) AS promptTokens,
              SUM(completion_tokens) AS completionTokens,
              SUM(cached_tokens) AS cachedTokens,
              ROUND(SUM(cost_usd), 6) AS costUsd
       FROM usage WHERE job_id=? GROUP BY agent, model, tier ORDER BY agent`,
      jobId,
    );
  }

  // ------------------------------------------------------------ observability

  statusCounts(kind: TaskKind, jobId: string): Record<string, number> {
    const rows = this.all<{ status: string; c: number }>(
      `SELECT status, COUNT(*) AS c FROM ${TASK_TABLE[kind]} WHERE job_id=? GROUP BY status`,
      jobId,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  resumeCounts(jobId: string): Record<string, number> {
    const rows = this.all<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM resumes WHERE job_id=? GROUP BY status',
      jobId,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  reviewVerdictCounts(jobId: string): Record<string, number> {
    const rows = this.all<{ verdict: string; c: number }>(
      `SELECT verdict, COUNT(*) AS c FROM review_tasks WHERE job_id=? AND verdict IS NOT NULL GROUP BY verdict`,
      jobId,
    );
    return Object.fromEntries(rows.map((r) => [r.verdict, r.c]));
  }

  selfLoopStats(jobId: string): { escalations: number; revisions: number } {
    const escalations = this.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM review_tasks WHERE job_id=? AND verdict='escalate_human'",
      jobId,
    )?.c ?? 0;
    const revisions = this.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM eval_tasks WHERE job_id=? AND revision_of IS NOT NULL',
      jobId,
    )?.c ?? 0;
    return { escalations, revisions };
  }
}
