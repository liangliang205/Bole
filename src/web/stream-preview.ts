import { parse } from 'partial-json';
import type { StreamPreview, StreamPreviewLine, StreamToken } from '../types.ts';

type Rec = Record<string, unknown>;

const FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  phone: '手机',
  email: '邮箱',
  years: '工作年限',
  education: '教育背景',
  school: '学校',
  major: '专业',
  skills: '技能',
  title: '求职意向',
  location: '城市',
  expectedSalary: '期望薪资',
  experience: '工作经历',
  projects: '项目经历',
  summary: '摘要',
  company: '公司',
  role: '职位',
};

const CONCLUSION_LABELS: Record<string, string> = {
  strong_yes: '强烈推荐',
  yes: '推荐',
  maybe: '待定',
  no: '不推荐',
  strong_no: '明确不推荐',
};

const VERDICT_LABELS: Record<string, string> = {
  pass: '核查通过',
  re_eval: '打回重评',
  escalate_human: '转人工',
  supported: '✓ 有据',
  unsupported: '✗ 无据',
  missing_evidence: '? 证据不足',
};

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clip(value: string, max = 90): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function fieldValue(value: unknown): { value: string; confidence: number | null } {
  if (typeof value === 'string') return { value, confidence: null };
  const field = rec(value);
  if (!field) return { value: '', confidence: null };
  return {
    value: text(field.value),
    confidence: typeof field.confidence === 'number' ? field.confidence : null,
  };
}

function line(label: string, value: string, tone?: StreamPreviewLine['tone']): StreamPreviewLine {
  return { label, value: clip(value), ...(tone ? { tone } : {}) };
}

function titleFor(chunk: StreamToken, parsed: Rec | null): string {
  const label = chunk.label || text(parsed?.resumeId) || '';
  const prefix = label ? `${label} · ` : '';
  if (chunk.agent === 'parser') return `${prefix}字段解析`;
  if (chunk.agent === 'assessor') {
    if (chunk.phase === 'deep') return `${prefix}深评`;
    if (chunk.phase === 'revise') return `${prefix}返工评估`;
    return `${prefix}初筛评估`;
  }
  if (chunk.agent === 'auditor') return `${prefix}证据核查`;
  if (chunk.agent === 'profiler') return '岗位画像';
  if (chunk.agent === 'advisor') return `${prefix}面试建议`;
  return `${prefix}生成中`;
}

function parsePreview(parsed: Rec): StreamPreviewLine[] {
  const lines: StreamPreviewLine[] = [];
  const fields = rec(parsed.fields);
  if (fields) {
    for (const [key, raw] of Object.entries(fields).slice(0, 6)) {
      const field = fieldValue(raw);
      if (!field.value.trim()) continue;
      const tone = field.confidence !== null && field.confidence < 0.6 ? 'warn' : undefined;
      lines.push(line(FIELD_LABELS[key] ?? key, field.value, tone));
    }
  }
  if (lines.length === 0) lines.push(line('状态', '正在读取简历字段…', 'muted'));
  const summary = text(parsed.summary);
  if (summary) lines.push(line('摘要', summary));
  const anomaly = text(arr(parsed.anomalies)[0]);
  if (anomaly) lines.push(line('异常', anomaly, 'warn'));
  return lines;
}

function evalPreview(parsed: Rec): StreamPreviewLine[] {
  const lines: StreamPreviewLine[] = [];
  const dimensions = arr(parsed.dimensions);
  for (const item of dimensions.slice(0, 5)) {
    const dim = rec(item);
    if (!dim) continue;
    const name = text(dim.name) || text(dim.key) || '维度';
    const score = typeof dim.score === 'number' ? `${dim.score}/5` : '…';
    const rationale = text(dim.rationale);
    lines.push(line(`${name} ${score}`, rationale || '正在评估…', rationale ? undefined : 'muted'));
  }
  if (dimensions.length > 5) lines.push(line('其余维度', `${dimensions.length - 5} 个正在生成…`, 'muted'));
  if (lines.length === 0) lines.push(line('状态', '正在评分…', 'muted'));
  if (typeof parsed.totalScore === 'number') lines.push(line('总分', `${parsed.totalScore} / 100`, 'ok'));
  const conclusion = text(parsed.conclusion);
  if (conclusion) lines.push(line('结论', CONCLUSION_LABELS[conclusion] ?? conclusion, 'ok'));
  const uncertainty = text(arr(parsed.uncertainties)[0]);
  if (uncertainty) lines.push(line('不确定', uncertainty, 'warn'));
  return lines;
}

function reviewPreview(parsed: Rec): StreamPreviewLine[] {
  const lines: StreamPreviewLine[] = [];
  const verdict = text(parsed.verdict);
  if (verdict) {
    const tone = verdict === 'pass' ? 'ok' : verdict === 're_eval' ? 'warn' : 'warn';
    lines.push(line('裁决', VERDICT_LABELS[verdict] ?? verdict, tone));
  } else {
    lines.push(line('状态', '正在逐条核查证据…', 'muted'));
  }
  const checks = arr(parsed.checks);
  for (const item of checks.slice(0, 5)) {
    const check = rec(item);
    if (!check) continue;
    const checkVerdict = text(check.verdict);
    const icon = checkVerdict === 'supported' ? '✓ 有据' : checkVerdict === 'unsupported' ? '✗ 无据' : '? 待核';
    const claim = text(check.claim);
    const note = text(check.note);
    if (claim) lines.push(line(icon, `${claim}${note ? ` — ${note}` : ''}`, checkVerdict === 'supported' ? 'ok' : 'warn'));
  }
  if (checks.length > 5) lines.push(line('其余核查', `${checks.length - 5} 条…`, 'muted'));
  const fix = text(arr(parsed.requiredFixes)[0]);
  if (fix) lines.push(line('需修正', fix, 'warn'));
  const risk = text(rec(parsed.compliance)?.risk);
  if (risk && risk !== 'none') lines.push(line('合规风险', risk, 'warn'));
  return lines;
}

function jdPreview(parsed: Rec): StreamPreviewLine[] {
  const lines: StreamPreviewLine[] = [];
  const jd = rec(parsed.jd);
  const title = text(jd?.title);
  if (title) lines.push(line('岗位', title, 'ok'));
  const dimensions = arr(rec(parsed.scorecard)?.dimensions);
  for (const item of dimensions.slice(0, 5)) {
    const dim = rec(item);
    if (!dim) continue;
    const name = text(dim.name) || text(dim.key) || '维度';
    const weight = typeof dim.weight === 'number' ? `${dim.weight}%` : '';
    lines.push(line(name, weight || '正在生成…', weight ? undefined : 'muted'));
  }
  if (dimensions.length === 0) lines.push(line('状态', '正在拆解岗位要求…', 'muted'));
  const ambiguity = text(rec(arr(parsed.ambiguities)[0])?.question) || text(arr(parsed.ambiguities)[0]);
  if (ambiguity) lines.push(line('待确认', ambiguity, 'warn'));
  return lines;
}

function advisorPreview(parsed: Rec): StreamPreviewLine[] {
  const lines: StreamPreviewLine[] = [];
  const questions = arr(parsed.questions);
  questions.slice(0, 4).forEach((item, index) => {
    const question = rec(item);
    if (!question) return;
    const content = text(question.question);
    if (content) lines.push(line(`问题 ${index + 1}`, content));
  });
  if (questions.length === 0) lines.push(line('状态', '正在生成面试建议…', 'muted'));
  const risk = text(arr(parsed.risks)[0]);
  if (risk) lines.push(line('风险', risk, 'warn'));
  return lines;
}

export function formatStreamPreview(parsed: unknown, chunk: StreamToken): StreamPreview {
  const object = rec(parsed);
  const title = titleFor(chunk, object);
  if (!object) return { title, lines: [line('状态', '正在生成…', 'muted')] };
  let lines: StreamPreviewLine[];
  if (chunk.agent === 'parser') lines = parsePreview(object);
  else if (chunk.agent === 'assessor') lines = evalPreview(object);
  else if (chunk.agent === 'auditor') lines = reviewPreview(object);
  else if (chunk.agent === 'profiler') lines = jdPreview(object);
  else if (chunk.agent === 'advisor') lines = advisorPreview(object);
  else {
    lines = [];
    const resumeId = text(object.resumeId);
    if (resumeId) lines.push(line('候选人', resumeId));
    if (lines.length === 0) lines.push(line('状态', '正在生成…', 'muted'));
  }
  return { title, lines: lines.slice(0, 9) };
}

/**
 * 服务端 token 展示器：用 partial-json 解析未完成的 JSON，转成人类可读字段，
 * 前端只渲染 preview，不再显示原始 JSON token。
 */
export class StreamPreviewer {
  private readonly streams = new Map<string, { raw: string; attempt: number; last: StreamPreview }>();

  push(chunk: StreamToken): StreamPreview {
    const key = `${chunk.taskId ?? chunk.agent}:${chunk.phase ?? ''}:${chunk.resumeId ?? ''}`;
    const previous = this.streams.get(key);
    const attempt = chunk.attempt ?? 0;
    const raw = (previous && previous.attempt === attempt ? previous.raw : '') + chunk.delta;
    const bounded = raw.length > 80_000 ? raw.slice(-80_000) : raw;
    let parsed: unknown = null;
    try {
      const withoutFence = bounded.replace(/^\s*```(?:json)?\s*/i, '');
      const jsonStart = withoutFence.indexOf('{');
      parsed = parse(jsonStart > 0 ? withoutFence.slice(jsonStart) : withoutFence);
    } catch {
      parsed = null;
    }
    const preview = formatStreamPreview(parsed, chunk);
    this.streams.set(key, { raw: bounded, attempt, last: preview });
    return preview;
  }
}
