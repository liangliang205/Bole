import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';

interface Compliance {
  fairness?: {
    removed?: { text?: string; category?: string; action?: string }[];
    findings?: string[];
  };
  reviewStats?: { total?: number; supported?: number; failed?: number; vetoRate?: number };
  duplicates?: unknown[];
  failed?: unknown[];
}

/** 合规页：公平性（反歧视）与核查统计。 */
export function ComplianceTab({ jobId, snapshotCompliance }: { jobId: string; snapshotCompliance?: Compliance }): ReactElement {
  const compliance = snapshotCompliance ?? {};
  const fairness = compliance.fairness ?? {};
  const removed = fairness.removed ?? [];
  const findings = fairness.findings ?? [];
  const stats = compliance.reviewStats ?? {};
  return (
    <div className="card-grid">
      <div className="info-card">
        <h3>公平性（反歧视）</h3>
        {removed.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>原始条件</th><th>类别</th><th>处理</th></tr></thead>
              <tbody>
                {removed.map((item, index) => (
                  <tr key={`${item.text ?? ''}-${index}`}>
                    <td>{item.text ?? ''}</td>
                    <td>{item.category ?? ''}</td>
                    <td>{item.action ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">需求中未发现受保护属性条件。</p>}
        {findings.length > 0 ? <ul>{findings.map((finding) => <li key={finding}>{finding}</li>)}</ul> : null}
      </div>
      <div className="info-card">
        <h3>核查统计</h3>
        <div className="stat-line"><b>{stats.total ?? 0}</b><span>核查总数</span></div>
        <div className="stat-line"><b>{stats.supported ?? 0}</b><span>通过</span></div>
        <div className="stat-line"><b>{stats.failed ?? 0}</b><span>未通过</span></div>
        <div className="stat-line"><b>{((stats.vetoRate ?? 0) * 100).toFixed(0)}%</b><span>否决率</span></div>
        <div className="stat-line"><b>{(compliance.duplicates ?? []).length}</b><span>重复投递</span></div>
        <div className="stat-line"><b>{(compliance.failed ?? []).length}</b><span>处理失败</span></div>
      </div>
      <div id="drawer-job-scope" className="hidden" data-job={jobId} />
    </div>
  );
}

interface CostRow {
  agent?: string;
  model?: string;
  tier?: string;
  calls?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

interface CostData {
  totals?: { calls?: number; costUsd?: number; promptTokens?: number; cachedTokens?: number };
  usage?: CostRow[];
  report?: { cost?: { byStage?: { stage?: string; calls?: number; promptTokens?: number; completionTokens?: number; costUsd?: number }[] } };
}

/** 成本页：四个总量卡 + 按 Agent 与按阶段的用量表。 */
export function CostTab({ jobId }: { jobId: string }): ReactElement {
  const { data, isLoading } = useQuery({
    queryKey: ['cost', jobId],
    queryFn: async () => api<CostData>(`/api/run/${encodeURIComponent(jobId)}/cost`),
    enabled: Boolean(jobId),
    staleTime: 5_000,
  });
  if (isLoading) return <div className="empty-note">读取中…</div>;
  if (!data) return <div className="empty-note">暂无成本数据</div>;
  const totals = data.totals ?? {};
  const usage = data.usage ?? [];
  const stages = data.report?.cost?.byStage ?? [];
  return (
    <>
      <div className="card-grid">
        <div className="info-card"><b>{totals.calls ?? 0}</b><div className="muted">模型调用</div></div>
        <div className="info-card"><b>${Number(totals.costUsd ?? 0).toFixed(4)}</b><div className="muted">成本 USD</div></div>
        <div className="info-card"><b>{totals.promptTokens ?? 0}</b><div className="muted">输入 tokens</div></div>
        <div className="info-card"><b>{totals.cachedTokens ?? 0}</b><div className="muted">缓存命中</div></div>
      </div>
      {usage.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Agent</th><th>模型</th><th>档位</th><th>调用</th><th>输入</th><th>输出</th><th>缓存</th><th>USD</th></tr></thead>
            <tbody>
              {usage.map((row, index) => (
                <tr key={`${row.agent ?? ''}-${index}`}>
                  <td>{row.agent ?? ''}</td>
                  <td>{row.model ?? ''}</td>
                  <td>{row.tier ?? ''}</td>
                  <td>{row.calls ?? 0}</td>
                  <td>{row.promptTokens ?? 0}</td>
                  <td>{row.completionTokens ?? 0}</td>
                  <td>{row.cachedTokens ?? 0}</td>
                  <td>{Number(row.costUsd ?? 0).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {stages.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>阶段</th><th>调用</th><th>输入</th><th>输出</th><th>USD</th></tr></thead>
            <tbody>
              {stages.map((row, index) => (
                <tr key={`${row.stage ?? ''}-${index}`}>
                  <td>{row.stage ?? ''}</td>
                  <td>{row.calls ?? 0}</td>
                  <td>{row.promptTokens ?? 0}</td>
                  <td>{row.completionTokens ?? 0}</td>
                  <td>{Number(row.costUsd ?? 0).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

/** 以 JSON 呈现的检查页（任务记忆 / Agent 绑定 / 工作流）。 */
export function JsonTab({ jobId, kind }: { jobId: string; kind: 'memory' | 'agents' | 'workflow' }): ReactElement {
  const path = kind === 'memory'
    ? `/api/memory/jobs/${encodeURIComponent(jobId)}`
    : `/api/run/${encodeURIComponent(jobId)}/${kind === 'workflow' ? 'workflow' : 'agent-manifest'}`;
  const { data, isLoading, error } = useQuery({
    queryKey: [kind, jobId],
    queryFn: async () => api<unknown>(path),
    enabled: Boolean(jobId),
    staleTime: 5_000,
  });
  if (isLoading) return <div className="empty-note">读取中…</div>;
  if (error) return <div className="empty-note">读取失败：{error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return <div className="empty-note">暂无数据</div>;
  return <pre className="approval-preview">{JSON.stringify(data, null, 2)}</pre>;
}
