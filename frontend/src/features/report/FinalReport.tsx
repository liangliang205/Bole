import type { ReactElement } from 'react';
import { CONCLUSION_LABELS, PHASE_LABELS, formatScore, type ReportData } from '../../api/report.ts';

/**
 * 终稿报告卡：与旧实现 finalReportHtml 的结构一致。
 * 未完成/有未处理材料时给提示，不展示候选人结论。
 */
export function FinalReport({ report, runStatus, unfinished, onOpenCandidate }: {
  report: ReportData;
  runStatus?: string;
  unfinished: number;
  onOpenCandidate: (resumeId: string) => void;
}): ReactElement {
  if (unfinished > 0 || (runStatus !== 'completed' && report.run?.status !== 'draft')) {
    return (
      <div className="msg assistant">
        <div className="msg-avatar">伯</div>
        <div className="msg-body">
          <div className="msg-head"><span className="msg-name">伯乐</span><span className="msg-time" /></div>
          <div className="msg-text">
            筛选尚未完成{unfinished > 0 ? `，还有 ${unfinished} 份材料未完成处理` : ''}。当前不展示最终候选人结论，请在任务面板查看执行状态。
          </div>
        </div>
      </div>
    );
  }

  const top = Array.isArray(report.top) ? report.top : [];
  const recommended = top.filter((candidate) => candidate.conclusion === 'yes' || candidate.conclusion === 'strong_yes').length;
  const intro = top.length > 0
    ? `筛选完成。共 ${top.length} 位候选人通过证据核查${recommended > 0 ? `，其中 ${recommended} 位达到推荐标准` : '，但暂无达到推荐标准的人选'}。以下是结论与理由，全部结论都能回到简历原文。`
    : '筛选完成。本次没有候选人通过证据核查，以下是合规摘要。';
  const compliance = report.compliance ?? {};
  const stats = compliance.reviewStats ?? {};

  return (
    <div className="msg assistant">
      <div className="msg-avatar">伯</div>
      <div className="msg-body">
        <div className="msg-head"><span className="msg-name">伯乐</span><span className="msg-time" /></div>
        <div className="msg-text">{intro}</div>
        <div className="msg-card">
          <h3>候选人结论</h3>
          {top.length > 0 ? (
            <div className="recommendation-list">
              {top.map((candidate, index) => {
                const phase = PHASE_LABELS[candidate.evalPhase ?? ''] ?? '';
                const evalLabel = phase === '重评'
                  ? '深度评估 · 重评'
                  : (phase === '深评' || candidate.evalTier === 'pro' ? '深度评估' : '初筛评估');
                const tone = candidate.conclusion === 'strong_yes' || candidate.conclusion === 'yes'
                  ? 'ok'
                  : candidate.conclusion === 'strong_no' || candidate.conclusion === 'no' ? 'bad' : 'neutral';
                return (
                  <article
                    className="recommendation-item clickable"
                    data-candidate={candidate.resumeId}
                    key={candidate.resumeId}
                    onClick={() => onOpenCandidate(candidate.resumeId)}
                  >
                    <div className="recommendation-head">
                      <span className="recommendation-rank">{index + 1}</span>
                      <b className="recommendation-name">{candidate.label}</b>
                      <span className="recommendation-score">{formatScore(candidate.totalScore)} 分</span>
                      <span className={`recommendation-conclusion ${tone}`}>
                        {CONCLUSION_LABELS[candidate.conclusion ?? ''] ?? candidate.conclusion ?? '待评估'}
                      </span>
                    </div>
                    <div className="recommendation-meta">{evalLabel}</div>
                    <div className="recommendation-reason-label">理由说明</div>
                    <p className="recommendation-reason">{candidate.reason ?? candidate.summary ?? '—'}</p>
                  </article>
                );
              })}
            </div>
          ) : <div className="empty-note">没有候选人通过证据核查</div>}
          <div className="summary-grid" style={{ marginTop: 10 }}>
            <div><b>{top.length}</b><span>候选人</span></div>
            {recommended > 0 ? <div><b>{recommended}</b><span>推荐</span></div> : null}
            <div><b>{(report.escalations ?? []).length}</b><span>转人工</span></div>
            <div><b>{(compliance.duplicates ?? []).length}</b><span>重复</span></div>
            <div><b>{(compliance.failed ?? []).length}</b><span>失败</span></div>
            <div><b>{((stats.vetoRate ?? 0) * 100).toFixed(0)}%</b><span>核查否决率</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
