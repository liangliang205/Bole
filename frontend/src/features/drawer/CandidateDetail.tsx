import type { ReactElement } from 'react';

const FIELD_LABELS: Record<string, string> = {
  name: '姓名', contact: '联系方式', education: '教育背景', major: '所学专业', skills: '专业技能',
  projects: '项目经历', work_history: '工作经历', years_experience: '工作年限', expected_salary: '期望薪资',
};
const FIELD_ORDER = Object.keys(FIELD_LABELS);

const STATUS_LABEL: Record<string, string> = {
  queued: '待解析', parsing: '解析中', parsed: '已解析', evaluating: '评估中', evaluated: '已评估',
  verifying: '核查中', verified: '已核查', reported: '已上报', quarantine: '转人工', failed: '失败', duplicate: '重复',
};

export interface CandidateDetailData {
  resume: { label: string; status?: string; format?: string; batchId?: string | number; reasons?: string[] };
  parse?: {
    fields?: { key: string; value?: string; confidence?: number; spans?: { quote?: string; charStart?: number; charEnd?: number }[] }[];
    anomalies?: string[];
  } | null;
  evaluations?: {
    totalScore?: number; tier?: string; phase?: string; conclusion?: string; revisionOf?: string;
    dimensions?: { name?: string; key?: string; score?: number; rationale?: string }[];
    uncertainties?: string[];
  }[];
  reviews?: {
    verdict?: string; loopCount?: number; escalationReason?: string;
    checks?: { verdict?: string; claim?: string; note?: string }[];
  }[];
  evidence?: { field?: string; quote?: string; charStart?: number; charEnd?: number; verified?: boolean; verdict?: string }[];
}

function score(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 候选人详情：解析字段与证据 / 评估历史 / 核查记录 / 完整证据。
 * 结构与旧实现 renderCandidateDetail 一一对应。
 */
export function CandidateDetail({ detail, requirements, onBack }: {
  detail: CandidateDetailData;
  requirements: string;
  onBack: () => void;
}): ReactElement {
  const resume = detail.resume;
  const parse = detail.parse;
  const fields = parse?.fields ?? [];
  const sorted = [...fields].sort((a, b) => {
    const left = FIELD_ORDER.includes(a.key) ? FIELD_ORDER.indexOf(a.key) : 99;
    const right = FIELD_ORDER.includes(b.key) ? FIELD_ORDER.indexOf(b.key) : 99;
    return left - right;
  });
  const experienceOptional = /经验\s*(不限|不做要求|无要求)|应届/.test(requirements);
  const hints = (parse?.anomalies ?? [])
    .flatMap((anomaly) => anomaly.split(/[；;]/))
    .filter((hint) => !(/缺少|缺失|未填写/.test(hint)
      && (/expected_salary|期望薪资/.test(hint) || (experienceOptional && /work_history|years_experience|工作经历|工作年限/.test(hint)))));
  const missing = sorted.filter((field) => !String(field.value ?? '').trim());
  const evaluations = detail.evaluations ?? [];
  const reviews = detail.reviews ?? [];
  const evidence = detail.evidence ?? [];

  return (
    <div id="candidate-detail">
      <button className="btn ghost" id="candidate-back" onClick={onBack}>← 返回列表</button>
      <h2 style={{ margin: '10px 0 4px' }}>{resume.label}</h2>
      <div className="kv">
        <dt>状态</dt><dd>{STATUS_LABEL[resume.status ?? ''] ?? resume.status ?? ''}</dd>
        <dt>格式 / 批次</dt><dd>{resume.format ?? ''} · 第 {resume.batchId ?? '—'} 批</dd>
        {(resume.reasons ?? []).length > 0 ? <><dt>说明</dt><dd>{(resume.reasons ?? []).join('；')}</dd></> : null}
      </div>

      <h3>解析字段与证据</h3>
      {!parse ? <div className="empty-note">没有已提交的解析结果</div> : (
        <>
          {hints.length > 0 ? (
            <details className="resume-parse-notes">
              <summary>解析提示（{hints.length}）</summary>
              <p className="muted">以下为提取结果提示，不代表候选人能力结论；排版问题请以原文件为准。</p>
              <ul>{hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>
            </details>
          ) : null}
          {sorted.filter((field) => String(field.value ?? '').trim()).map((field) => (
            <section className="eval-card resume-field" key={field.key}>
              <div className="eval-head">
                <b>{FIELD_LABELS[field.key] ?? field.key}</b>
                <small className="muted">提取置信度 {Math.round(Number(field.confidence ?? 0) * 100)}%</small>
              </div>
              <div className="resume-field-value">{String(field.value ?? '').replace(/；/g, '；\n')}</div>
              {(field.spans ?? []).length > 0 ? (
                <details className="resume-evidence">
                  <summary>原文引用（{(field.spans ?? []).length}）</summary>
                  {(field.spans ?? []).map((span, index) => (
                    <blockquote className="evidence-quote" key={`${span.charStart ?? index}`}>
                      {span.quote ?? ''}
                      <small className="span-meta">文本位置 {span.charStart ?? ''}–{span.charEnd ?? ''}</small>
                    </blockquote>
                  ))}
                </details>
              ) : null}
            </section>
          ))}
          {missing.length > 0 ? (
            <details className="resume-parse-notes">
              <summary>未填写的信息（{missing.length}）</summary>
              <p className="muted">未填写不等于不满足岗位要求，不自动扣分。</p>
              {missing.map((field) => <span className="tag" key={field.key}>{FIELD_LABELS[field.key] ?? field.key}</span>)}
            </details>
          ) : null}
        </>
      )}

      <h3>评估历史</h3>
      {evaluations.length === 0 ? <div className="empty-note">没有评估结果</div> : evaluations.map((evaluation, index) => (
        <div className="eval-card" key={`eval-${index}`}>
          <div className="eval-head">
            <span className="eval-score">{score(evaluation.totalScore)}</span>
            <span className={`tag ${evaluation.tier === 'pro' ? 'deep' : ''}`}>{evaluation.tier ?? '—'}/{evaluation.phase ?? '—'}</span>
            <span className="tag">{evaluation.conclusion ?? ''}</span>
            {evaluation.revisionOf ? <span className="tag warn">返工</span> : null}
          </div>
          {(evaluation.dimensions ?? []).map((dim, dimIndex) => (
            <div className="muted" style={{ marginTop: 6 }} key={`${dim.key ?? dimIndex}`}>
              <b>{dim.name ?? dim.key ?? ''}</b> {dim.score ?? ''} 分 · {dim.rationale ?? ''}
            </div>
          ))}
          {(evaluation.uncertainties ?? []).length > 0
            ? <div className="muted">不确定：{(evaluation.uncertainties ?? []).join('；')}</div>
            : null}
        </div>
      ))}

      <h3>核查记录</h3>
      {reviews.length === 0 ? <div className="empty-note">没有核查记录</div> : reviews.map((review, index) => (
        <div className="eval-card" key={`review-${index}`}>
          <div className="eval-head">
            <span className={`tag ${review.verdict === 'pass' ? 'ok' : review.verdict === 're_eval' ? 'warn' : 'danger'}`}>{review.verdict ?? ''}</span>
            <span className="muted">第 {review.loopCount ?? 0} 轮</span>
          </div>
          {(review.checks ?? []).map((check, checkIndex) => (
            <div className="muted" key={`${check.claim ?? checkIndex}`}>
              {check.verdict === 'supported' ? '✓' : '✗'} {check.claim ?? ''} — {check.note ?? ''}
            </div>
          ))}
          {review.escalationReason ? <div className="muted">转人工：{review.escalationReason}</div> : null}
        </div>
      ))}

      <details className="resume-evidence">
        <summary>完整证据记录</summary>
        {evidence.length === 0 ? <div className="empty-note">暂无证据</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>字段</th><th>引用</th><th>区间</th><th>状态</th></tr></thead>
              <tbody>
                {evidence.map((row, index) => (
                  <tr key={`${row.field ?? ''}-${index}`}>
                    <td>{row.field ?? ''}</td>
                    <td>{row.quote ?? ''}</td>
                    <td className="span-meta">{row.charStart ?? ''}-{row.charEnd ?? ''}</td>
                    <td><span className={`tag ${row.verified ? 'ok' : 'warn'}`}>{row.verdict ?? ''}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}
