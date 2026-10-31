import type { Ledger } from '../core/ledger.ts';
import type {
  EvalResult,
  Jd,
  JobRow,
  ParseResult,
  ReviewResult,
  Scorecard,
  Span,
  TaskRow,
} from '../types.ts';

export function loadParseResult(ledger: Ledger, resumeId: string): ParseResult | null {
  const tasks = ledger
    .listTasks('parse', {})
    .filter((task) => task.resume_id === resumeId && task.status === 'committed')
    .sort((a, b) => String(a.committed_ts ?? '').localeCompare(String(b.committed_ts ?? '')));
  const task = tasks[tasks.length - 1];
  if (!task || !task.fields_json) return null;
  const rawFields = JSON.parse(String(task.fields_json)) as Record<string, { value: string; confidence: number }>;
  const spans = JSON.parse(String(task.spans_json ?? '[]')) as Span[];
  const anomalies = JSON.parse(String(task.anomalies_json ?? '[]')) as string[];
  const fields: ParseResult['fields'] = {};
  for (const [key, field] of Object.entries(rawFields)) {
    fields[key] = {
      value: field.value,
      confidence: field.confidence,
      spans: spans.filter((span) => span.field === key),
    };
  }
  return { resumeId, fields, anomalies, summary: '' };
}

export function loadLatestEval(ledger: Ledger, resumeId: string): { task: TaskRow; evaluation: EvalResult } | null {
  const task = ledger.latestEvalTask(resumeId);
  if (!task || task.status !== 'committed' || !task.scores_json) return null;
  const dimensions = JSON.parse(String(task.scores_json)) as EvalResult['dimensions'];
  const rationale = JSON.parse(String(task.rationale_json ?? '{}')) as {
    rationale?: string[];
    uncertainties?: string[];
    redFlags?: string[];
    revisionNotes?: string[];
  };
  return {
    task,
    evaluation: {
      resumeId,
      dimensions,
      totalScore: Number(task.total_score ?? 0),
      conclusion: (task.conclusion ?? 'maybe') as EvalResult['conclusion'],
      rationale: rationale.rationale ?? [],
      uncertainties: rationale.uncertainties ?? [],
      redFlags: rationale.redFlags ?? [],
      revisionNotes: rationale.revisionNotes ?? [],
    },
  };
}

export function loadLatestReview(ledger: Ledger, resumeId: string): { task: TaskRow; review: ReviewResult } | null {
  const tasks = ledger
    .listTasks('review', {})
    .filter((task) => task.resume_id === resumeId && task.status === 'committed')
    .sort((a, b) => String(a.created_ts).localeCompare(String(b.created_ts)) || Number(a.rowid ?? 0) - Number(b.rowid ?? 0));
  const task = tasks[tasks.length - 1];
  if (!task || !task.verdict) return null;
  return {
    task,
    review: {
      resumeId,
      verdict: task.verdict as ReviewResult['verdict'],
      checks: JSON.parse(String(task.checks_json ?? '[]')) as ReviewResult['checks'],
      compliance: JSON.parse(String(task.compliance_json ?? '{"risk":"none","findings":[]}')) as ReviewResult['compliance'],
      requiredFixes: JSON.parse(String(task.required_fixes_json ?? '[]')) as string[],
      escalationReason: (task.escalation_reason as string | null) ?? undefined,
    },
  };
}

export function loadJobAnalysis(job: JobRow): { jd: Jd; scorecard: Scorecard; fairness: { removed: { text: string; category: string; action: string }[]; findings: string[] } } | null {
  if (!job.jd_json || !job.scorecard_json) return null;
  return {
    jd: JSON.parse(job.jd_json) as Jd,
    scorecard: JSON.parse(job.scorecard_json) as Scorecard,
    fairness: job.fairness_json
      ? (JSON.parse(job.fairness_json) as { removed: { text: string; category: string; action: string }[]; findings: string[] })
      : { removed: [], findings: [] },
  };
}

export function allReviews(ledger: Ledger, jobId: string): TaskRow[] {
  return ledger.listTasks('review', { jobId });
}
