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

/** 时间格式化：与服务端 ISO 时间保持一致的可读输出。 */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** JSON.parse 的容错包装：字段可能是字符串、对象或 null。 */
function parseMaybe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const WORKFLOW_STATUS: Record<string, string> = {
  pending: '待执行', running: '执行中', waiting_approval: '等待审批', waiting_confirmation: '结果待确认',
  paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消',
};
const WORKFLOW_KIND: Record<string, string> = {
  task: '任务', sequence: '顺序', parallel: '并行', condition: '条件', loop: '循环', subworkflow: '子流程', approval: '人工审批',
};
const INVOCATION_STATE: Record<string, string> = {
  running: '执行中', completed: '调用完成', failed: '调用失败',
};

const statusTagClass = (status: string | undefined): string =>
  status === 'succeeded' || status === 'completed' ? ' ok' : status === 'failed' ? ' danger' : '';

interface MemoryPayload {
  view?: {
    binding?: { version_id?: string | null; bound_at?: string } | null;
    decisions?: { id: string; node?: string; question: string; answer: string; actor?: string; ts?: string }[];
    summaries?: { from_seq?: number; through_seq?: number; created_at?: string }[];
  };
  profile?: {
    jd?: { title?: string };
    scorecard?: { dimensions?: { key: string; name: string; weight: number }[] };
  };
}

/** 任务记忆：评分标准、人工确认记录、对话摘要，完整 JSON 收在折叠里。 */
export function MemoryTab({ jobId }: { jobId: string }): ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['memory-job', jobId],
    queryFn: async () => api<MemoryPayload>(`/api/memory/jobs/${encodeURIComponent(jobId)}`),
    enabled: Boolean(jobId),
    staleTime: 5_000,
  });
  if (isLoading) return <div className="empty-note">读取中…</div>;
  if (error) return <div className="empty-note">读取失败：{error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return <div className="empty-note">暂无数据</div>;

  const view = data.view ?? {};
  const binding = view.binding ?? null;
  const dimensions = data.profile?.scorecard?.dimensions ?? [];
  const decisions = view.decisions ?? [];
  const summaries = view.summaries ?? [];

  return (
    <>
      <h3>当前任务记忆</h3>
      <p className="muted">当前会话的确认条件、评分标准与历史摘要。</p>
      <div className="eval-card">
        <b>{data.profile?.jd?.title || '岗位尚未完成画像'}</b>
        <p className="muted">
          {binding
            ? `评分标准已冻结 · ${binding.version_id ? '复用已批准版本' : '按本次需求生成'}${binding.bound_at ? `（${fmtDateTime(binding.bound_at)}）` : ''}`
            : '尚未绑定评分标准'}
        </p>
        {dimensions.map((dimension) => (
          <div className="muted" key={dimension.key}>{dimension.name} · {dimension.weight}%</div>
        ))}
      </div>

      <h3>人工确认记录</h3>
      {decisions.length === 0
        ? <div className="empty-note">暂无确认记录</div>
        : decisions.map((decision) => (
          <div className="eval-card" key={decision.id}>
            <div>{decision.question}</div>
            <p>{decision.answer}</p>
            <small className="muted">{decision.actor ?? ''}{decision.ts ? ` · ${fmtDateTime(decision.ts)}` : ''}</small>
          </div>
        ))}

      <h3>对话摘要</h3>
      {summaries.length === 0
        ? <p className="muted">尚无历史摘要；上下文超过预算时按需生成。</p>
        : summaries.map((summary, index) => (
          <div className="eval-card" key={`${summary.from_seq ?? 0}-${summary.through_seq ?? 0}-${index}`}>
            覆盖消息 {summary.from_seq ?? '?'}–{summary.through_seq ?? '?'}
            <p className="muted">生成于 {fmtDateTime(summary.created_at)}</p>
          </div>
        ))}

      <details>
        <summary>查看版本与来源详情</summary>
        <pre className="approval-preview">{JSON.stringify(data, null, 2)}</pre>
      </details>
    </>
  );
}

interface ManifestPayload {
  manifest?: {
    teamKey?: string;
    migration?: boolean;
    providerName?: string;
    models?: { flash?: string; pro?: string };
    bindings?: Record<string, { key: string; reason?: string; definition?: { name?: string; tier?: string } }>;
  } | null;
  invocations?: { id: string; slot?: string; version_key?: string; state?: string; started_at?: string; error?: string | null }[];
}

/** Agent：团队绑定与调用记录，完整 JSON 收在折叠里。 */
export function AgentsTab({ jobId }: { jobId: string }): ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-manifest', jobId],
    queryFn: async () => api<ManifestPayload>(`/api/run/${encodeURIComponent(jobId)}/agent-manifest`),
    enabled: Boolean(jobId),
    staleTime: 5_000,
  });
  if (isLoading) return <div className="empty-note">读取中…</div>;
  if (error) return <div className="empty-note">读取失败：{error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return <div className="empty-note">暂无数据</div>;

  const manifest = data.manifest ?? null;
  if (!manifest) {
    return <div className="empty-note">该历史会话暂无 Agent 版本绑定。首次续跑时会建立迁移清单。</div>;
  }
  const bindings = Object.entries(manifest.bindings ?? {});
  const invocations = data.invocations ?? [];

  return (
    <>
      <h3>Agent 版本与执行记录</h3>
      <p className="muted">
        团队 {manifest.teamKey ?? '—'}{manifest.migration ? ' · 迁移时绑定' : ''}
        {manifest.models ? ` · 快速 ${manifest.models.flash ?? '—'} / 深入 ${manifest.models.pro ?? '—'}` : ''}
      </p>
      {bindings.length === 0
        ? <div className="empty-note">暂无绑定</div>
        : bindings.map(([slot, binding]) => (
          <div className="eval-card" key={slot}>
            <b>{binding.definition?.name ?? slot}</b>
            <p>{binding.key}</p>
            <small className="muted">{slot}{binding.definition?.tier ? ` · ${binding.definition.tier}` : ''}{binding.reason ? ` · ${binding.reason}` : ''}</small>
          </div>
        ))}

      <h3>调用记录</h3>
      {invocations.length === 0
        ? <div className="empty-note">暂无调用记录</div>
        : invocations.map((invocation) => (
          <div className="eval-card" key={invocation.id}>
            <b>{invocation.version_key ?? invocation.slot ?? '—'}</b>
            <p>
              {INVOCATION_STATE[invocation.state ?? ''] ?? invocation.state ?? ''}
              {invocation.started_at ? ` · ${fmtDateTime(invocation.started_at)}` : ''}
            </p>
            {invocation.error ? <p className="muted">{invocation.error}</p> : null}
          </div>
        ))}

      <details>
        <summary>查看完整绑定与调用详情</summary>
        <pre className="approval-preview">{JSON.stringify(data, null, 2)}</pre>
      </details>
    </>
  );
}

interface WorkflowPayload {
  runs?: {
    id: string; workflow_key?: string; parent_run_id?: string | null; parent_node_path?: string | null;
    status?: string; error?: string | null;
  }[];
  nodes?: {
    run_id: string; path: string; node_id: string; kind?: string; status?: string;
    input_json?: string | null; output_json?: string | null; control_json?: string | null;
    attempt?: number; error?: string | null;
  }[];
}

/** 工作流：按运行分组展示节点，节点输入输出收在折叠里。 */
export function WorkflowTab({ jobId }: { jobId: string }): ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['workflow', jobId],
    queryFn: async () => api<WorkflowPayload>(`/api/run/${encodeURIComponent(jobId)}/workflow`),
    enabled: Boolean(jobId),
    staleTime: 5_000,
  });
  if (isLoading) return <div className="empty-note">读取中…</div>;
  if (error) return <div className="empty-note">读取失败：{error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return <div className="empty-note">暂无数据</div>;

  const runs = data.runs ?? [];
  const nodes = data.nodes ?? [];
  if (runs.length === 0) return <div className="empty-note">还没有工作流运行记录。</div>;

  return (
    <>
      <h3>工作流执行</h3>
      <p className="muted">查看流程版本、父子运行、分支及每轮核查修正。</p>
      {runs.map((run) => {
        const runNodes = nodes.filter((node) => node.run_id === run.id);
        return (
          <section className="eval-card" key={run.id}>
            <div className="eval-head">
              <b>{run.workflow_key ?? run.id}</b>
              <span className={`tag${statusTagClass(run.status)}`}>{WORKFLOW_STATUS[run.status ?? ''] ?? run.status ?? ''}</span>
            </div>
            <small className="muted">
              运行 {run.id}
              {run.parent_run_id
                ? <><br />父运行 {run.parent_run_id} · {run.parent_node_path ?? ''}</>
                : ' · 根流程'}
            </small>
            {run.error ? <p className="muted">{run.error}</p> : null}
            {runNodes.map((node) => (
              <details className="workflow-node" key={`${node.run_id}-${node.path}`}>
                <summary>
                  <span className={`tag${statusTagClass(node.status)}`}>{WORKFLOW_STATUS[node.status ?? ''] ?? node.status ?? ''}</span>
                  {' '}{node.node_id}{' '}
                  <small className="muted">{WORKFLOW_KIND[node.kind ?? ''] ?? node.kind ?? ''}</small>
                </summary>
                <p className="muted">{node.path} · 执行 {node.attempt ?? 1} 次</p>
                {node.error ? <p>{node.error}</p> : null}
                <pre className="approval-preview">
                  {JSON.stringify({
                    input: parseMaybe(node.input_json),
                    output: parseMaybe(node.output_json),
                    control: parseMaybe(node.control_json),
                  }, null, 2)}
                </pre>
                {node.status === 'waiting_confirmation' && node.kind === 'task'
                  ? <p className="muted">该节点等待结果确认后才能继续。</p>
                  : null}
              </details>
            ))}
            {runNodes.length === 0 ? <div className="empty-note">该运行暂无节点记录</div> : null}
          </section>
        );
      })}
    </>
  );
}
