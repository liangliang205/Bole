import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../config.ts';
import { Ledger } from '../core/ledger.ts';
import { maskPII } from '../util/text.ts';
import type { EventRow, JobRow, TaskRow } from '../types.ts';

export interface JobListItem {
  id: string;
  title: string;
  status: string;
  createdTs: string;
  updatedTs: string;
  requirements: string;
  total: number;
  verified: number;
  quarantine: number;
  failed: number;
  duplicate: number;
}

export interface JobSnapshot {
  job: JobRow | undefined;
  resumeCounts: Record<string, number>;
  reviewCounts: Record<string, number>;
  parseCounts: Record<string, number>;
  evalCounts: Record<string, number>;
  evalPhaseCounts: Record<string, number>;
  reviewTotal: number;
  decisions: number;
  decisionList: { id: string; node: string; question: string; answer: string; actor: string; ts: string }[];
  eventsCount: number;
  selfLoop: { revisions: number; escalations: number };
  hasReport: boolean;
}

export interface CandidateSummary {
  resumeId: string;
  label: string;
  format: string;
  status: string;
  batchId: number | null;
  score: number | null;
  conclusion: string | null;
  evalTier: string | null;
  evalPhase: string | null;
  reviewVerdict: string | null;
  loopCount: number;
  reasons: string[];
}

export interface CandidateDetail {
  resume: {
    id: string;
    label: string;
    format: string;
    status: string;
    batchId: number | null;
    reasons: string[];
    sourceFormat: string;
  };
  parse: {
    fields: {
      key: string;
      value: string;
      confidence: number;
      spans: { field: string; quote: string; charStart: number; charEnd: number }[];
    }[];
    anomalies: string[];
  } | null;
  evaluations: {
    id: string;
    tier: string | null;
    phase: string | null;
    status: string;
    attempt: number;
    totalScore: number | null;
    conclusion: string | null;
    createdAt: string;
    revisionOf: string | null;
    dimensions: {
      key: string;
      name: string;
      weight: number;
      score: number;
      rationale: string;
      spans: { field: string; quote: string; charStart: number; charEnd: number }[];
    }[];
    uncertainties: string[];
    redFlags: string[];
    revisionNotes: string[];
  }[];
  reviews: {
    id: string;
    loopCount: number;
    verdict: string | null;
    status: string;
    checks: { claim: string; verdict: string; note: string; quote?: string }[];
    compliance: { risk: string; findings: string[] };
    requiredFixes: string[];
    escalationReason: string | null;
    createdAt: string;
  }[];
  evidence: {
    field: string;
    quote: string;
    charStart: number;
    charEnd: number;
    verified: boolean;
    verdict: string;
    note: string;
  }[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function maskField(key: string, value: string): string {
  if (key === 'name') {
    const chars = Array.from(value);
    return chars.length > 1 ? `${chars[0]}**` : '**';
  }
  return maskPII(value);
}

function withLedger<T>(fn: (ledger: Ledger) => T): T {
  const paths = resolvePaths();
  const ledger = new Ledger(paths.dbPath);
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

export function listJobs(limit = 50): JobListItem[] {
  return withLedger((ledger) => {
    const jobs = ledger.listJobs().slice(0, limit);
    return jobs.map((job) => {
      const counts = ledger.resumeCounts(job.id);
      const total = ledger.listResumes(job.id).length;
      return {
        id: job.id,
        title: job.title,
        status: job.status,
        createdTs: job.created_ts,
        updatedTs: job.updated_ts,
        requirements: job.requirements,
        total,
        verified: (counts.verified ?? 0) + (counts.reported ?? 0),
        quarantine: counts.quarantine ?? 0,
        failed: counts.failed ?? 0,
        duplicate: counts.duplicate ?? 0,
      };
    });
  });
}

export function getSnapshot(jobId: string): JobSnapshot {
  return withLedger((ledger) => {
    const job = ledger.getJob(jobId);
    if (!job) {
      return {
        job: undefined,
        resumeCounts: {},
        reviewCounts: {},
        parseCounts: {},
        evalCounts: {},
        evalPhaseCounts: {},
        reviewTotal: 0,
        decisions: 0,
        decisionList: [],
        eventsCount: 0,
        selfLoop: { revisions: 0, escalations: 0 },
        hasReport: false,
      };
    }
    const evalTasks = ledger.listTasks('eval', { jobId });
    const evalPhaseCounts: Record<string, number> = {};
    for (const task of evalTasks) {
      if (task.status !== 'committed') continue;
      const phase = String(task.phase ?? 'unknown');
      evalPhaseCounts[phase] = (evalPhaseCounts[phase] ?? 0) + 1;
    }
    const decisions = ledger.listDecisions(jobId);
    return {
      job,
      resumeCounts: ledger.resumeCounts(jobId),
      reviewCounts: ledger.reviewVerdictCounts(jobId),
      parseCounts: ledger.statusCounts('parse', jobId),
      evalCounts: ledger.statusCounts('eval', jobId),
      evalPhaseCounts,
      reviewTotal: ledger.listTasks('review', { jobId }).filter((task) => task.status === 'committed').length,
      decisions: decisions.length,
      decisionList: decisions.map((decision) => ({
        id: decision.id,
        node: decision.node,
        question: decision.question,
        answer: decision.answer,
        actor: decision.actor,
        ts: decision.ts,
      })),
      eventsCount: ledger.countEvents(jobId),
      selfLoop: ledger.selfLoopStats(jobId),
      hasReport: Boolean(findReportDir(jobId)),
    };
  });
}

export function listCandidates(jobId: string): CandidateSummary[] {
  return withLedger((ledger) => {
    const resumes = ledger.listResumes(jobId);
    const evalTasks = ledger.listTasks('eval', { jobId }).filter((task) => task.status === 'committed');
    const reviewTasks = ledger.listTasks('review', { jobId }).filter((task) => task.status === 'committed');
    const latestEval = new Map<string, TaskRow>();
    for (const task of evalTasks) {
      latestEval.set(task.resume_id, task);
    }
    const latestReview = new Map<string, TaskRow>();
    for (const task of reviewTasks) {
      latestReview.set(task.resume_id, task);
    }
    return resumes.map((resume) => {
      const evaluation = latestEval.get(resume.id);
      const review = latestReview.get(resume.id);
      return {
        resumeId: resume.id,
        label: resume.label,
        format: resume.format ?? 'unknown',
        status: resume.status,
        batchId: resume.batch_id,
        score: evaluation ? Number(evaluation.total_score ?? 0) : null,
        conclusion: (evaluation?.conclusion as string | null) ?? null,
        evalTier: (evaluation?.tier as string | null) ?? null,
        evalPhase: (evaluation?.phase as string | null) ?? null,
        reviewVerdict: (review?.verdict as string | null) ?? null,
        loopCount: Number(review?.loop_count ?? 0),
        reasons: parseJson<string[]>(resume.reasons_json, []).map(maskPII),
      };
    });
  });
}

export function getCandidateDetail(jobId: string, needle: string): CandidateDetail | null {
  return withLedger((ledger) => {
    const resumes = ledger.listResumes(jobId);
    const resume =
      resumes.find((item) => item.id === needle) ??
      resumes.find((item) => item.label.toLowerCase() === needle.toLowerCase());
    if (!resume) return null;

    const parseTasks = ledger
      .listTasks('parse', { jobId })
      .filter((task) => task.resume_id === resume.id && task.status === 'committed');
    const parseTask = parseTasks[parseTasks.length - 1];
    const rawFields = parseJson<Record<string, { value: string; confidence: number }>>(
      parseTask?.fields_json,
      {},
    );
    const rawSpans = parseJson<{ field: string; quote: string; charStart: number; charEnd: number }[]>(
      parseTask?.spans_json,
      [],
    );
    const anomalies = parseJson<string[]>(parseTask?.anomalies_json, []);

    const evalTasks = ledger
      .listTasks('eval', { jobId })
      .filter((task) => task.resume_id === resume.id && task.status === 'committed');
    const reviewTasks = ledger
      .listTasks('review', { jobId })
      .filter((task) => task.resume_id === resume.id && task.status === 'committed');

    return {
      resume: {
        id: resume.id,
        label: resume.label,
        format: resume.format ?? 'unknown',
        status: resume.status,
        batchId: resume.batch_id,
        reasons: parseJson<string[]>(resume.reasons_json, []).map(maskPII),
        sourceFormat: resume.source_msg_id ?? '',
      },
      parse: parseTask
        ? {
            fields: Object.entries(rawFields).map(([key, field]) => ({
              key,
              value: maskField(key, field.value),
              confidence: field.confidence,
              spans: rawSpans
                .filter((span) => span.field === key)
                .map((span) => ({ ...span, quote: maskPII(span.quote) })),
            })),
            anomalies: anomalies.map(maskPII),
          }
        : null,
      evaluations: evalTasks.map((task) => {
        const rationale = parseJson<{
          rationale?: string[];
          uncertainties?: string[];
          redFlags?: string[];
          revisionNotes?: string[];
        }>(task.rationale_json, {});
        return {
          id: task.id,
          tier: (task.tier as string | null) ?? null,
          phase: (task.phase as string | null) ?? null,
          status: task.status,
          attempt: Number(task.attempt ?? 0),
          totalScore: task.total_score === null || task.total_score === undefined ? null : Number(task.total_score),
          conclusion: (task.conclusion as string | null) ?? null,
          createdAt: String(task.created_ts ?? ''),
          revisionOf: (task.revision_of as string | null) ?? null,
          dimensions: parseJson<
            {
              key: string;
              name: string;
              weight: number;
              score: number;
              rationale: string;
              spans: { field: string; quote: string; charStart: number; charEnd: number }[];
            }[]
          >(task.scores_json, []).map((dim) => ({
            ...dim,
            rationale: maskPII(dim.rationale),
            spans: (dim.spans ?? []).map((span) => ({ ...span, quote: maskPII(span.quote) })),
          })),
          uncertainties: (rationale.uncertainties ?? []).map(maskPII),
          redFlags: (rationale.redFlags ?? []).map(maskPII),
          revisionNotes: (rationale.revisionNotes ?? []).map(maskPII),
        };
      }),
      reviews: reviewTasks.map((task) => ({
        id: task.id,
        loopCount: Number(task.loop_count ?? 0),
        verdict: (task.verdict as string | null) ?? null,
        status: task.status,
        checks: parseJson<{ claim: string; verdict: string; note: string; quote?: string }[]>(
          task.checks_json,
          [],
        ).map((check) => ({
          ...check,
          claim: maskPII(check.claim),
          note: maskPII(check.note),
          quote: check.quote ? maskPII(check.quote) : undefined,
        })),
        compliance: parseJson<{ risk?: string; findings?: string[] }>(task.compliance_json, {}).risk
          ? {
              risk: parseJson<{ risk: string }>(task.compliance_json, { risk: 'none' }).risk,
              findings: parseJson<{ findings?: string[] }>(task.compliance_json, {}).findings ?? [],
            }
          : { risk: 'none', findings: [] },
        requiredFixes: parseJson<string[]>(task.required_fixes_json, []).map(maskPII),
        escalationReason: (task.escalation_reason as string | null) ?? null,
        createdAt: String(task.created_ts ?? ''),
      })),
      evidence: ledger.listEvidence(resume.id).map((row) => ({
        field: row.field,
        quote: maskPII(row.quote),
        charStart: row.char_start,
        charEnd: row.char_end,
        verified: row.verified === 1,
        verdict: row.verdict ?? (row.verified === 1 ? 'supported' : 'pending'),
        note: row.note ? maskPII(row.note) : '',
      })),
    };
  });
}

export function listEvents(jobId: string, sinceSeq: number, limit: number): (EventRow & { payload: Record<string, unknown> })[] {
  return withLedger((ledger) =>
    ledger.listEvents({ jobId, sinceSeq, limit }).map((row) => ({
      ...row,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    })),
  );
}

export function findReportDir(jobId: string): string | null {
  const paths = resolvePaths();
  if (!existsSync(paths.runsDir)) return null;
  const dirs = readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(paths.runsDir, entry.name))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const file = path.join(dir, 'report.json');
    if (!existsSync(file)) continue;
    try {
      const report = JSON.parse(readFileSync(file, 'utf8')) as { job?: { id?: string } };
      if (report.job?.id === jobId) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

export function getCost(jobId: string): {
  usage: {
    agent: string;
    model: string;
    tier: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    costUsd: number;
  }[];
  totals: { calls: number; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number };
  report: unknown | null;
} {
  return withLedger((ledger) => {
    const usage = ledger.usageSummary(jobId);
    const totals = usage.reduce(
      (acc, row) => ({
        calls: acc.calls + Number(row.calls ?? 0),
        promptTokens: acc.promptTokens + Number(row.promptTokens ?? 0),
        completionTokens: acc.completionTokens + Number(row.completionTokens ?? 0),
        cachedTokens: acc.cachedTokens + Number(row.cachedTokens ?? 0),
        costUsd: acc.costUsd + Number(row.costUsd ?? 0),
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 },
    );
    const dir = findReportDir(jobId);
    let report: unknown | null = null;
    if (dir) {
      try {
        const raw = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as {
          run?: unknown;
          cost?: unknown;
          pools?: unknown;
          convergence?: unknown;
        };
        report = {
          run: raw.run ?? null,
          cost: raw.cost ?? null,
          pools: raw.pools ?? [],
          convergence: raw.convergence ?? [],
        };
      } catch {
        report = null;
      }
    }
    return { usage, totals: { ...totals, costUsd: Number(totals.costUsd.toFixed(6)) }, report };
  });
}

export function getJob(jobId: string): JobRow | null {
  return withLedger((ledger) => ledger.getJob(jobId) ?? null);
}
