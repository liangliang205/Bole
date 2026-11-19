import type { ReactElement } from 'react';

export interface PendingHitl {
  id?: string;
  node?: string;
  question?: string;
  options?: string[];
  recommendedOption?: string;
}

export interface RunApproval {
  id: string;
  kind: string;
  status: string;
  payload_json: string;
}

const APPROVAL_TITLES: Record<string, string> = {
  'screening-plan': '批准筛选计划',
  'publish-report': '审阅并发布报告',
  tool: '批准工具操作',
  workflow: '工作流人工审批',
  'memory-policy-change': '长期规则修订',
  'recruitment-mail': '确认候选人与招聘邮件',
};

interface ApprovalPayload {
  name?: string;
  arguments?: string;
  jd?: { title?: string };
  materials?: unknown[];
  plan?: { batchSize?: number; maxBatchesInFlight?: number; maxActiveAgents?: number; deepEval?: { enabled?: boolean; percent?: number }; reason?: string };
  revisionBudget?: { maxLoops?: number };
  candidate?: string;
  mailbox?: string;
  to?: string;
  subject?: string;
  body?: string;
  report?: { top?: { label?: string; totalScore?: number; reason?: string }[] };
}

function parsePayload(item: RunApproval): ApprovalPayload {
  try {
    return JSON.parse(item.payload_json) as ApprovalPayload;
  } catch {
    return {};
  }
}

function ApprovalSummary({ item }: { item: RunApproval }): ReactElement {
  const payload = parsePayload(item);
  if (item.kind === 'screening-plan') {
    const plan = payload.plan ?? {};
    return (
      <>
        <p>岗位：{payload.jd?.title ?? ''}。材料 {payload.materials?.length ?? 0} 份。</p>
        <p>
          每批 {plan.batchSize ?? ''} 份，同时处理 {plan.maxBatchesInFlight ?? ''} 批；总并发上限 {plan.maxActiveAgents ?? ''}。
          {plan.deepEval?.enabled ? `初筛后深评前 ${plan.deepEval.percent ?? 0}% 及异常项。` : '本轮不启用深评。'}
          核查打回最多修正 {payload.revisionBudget?.maxLoops ?? 0} 次。
        </p>
        <p>{plan.reason ?? ''}</p>
      </>
    );
  }
  if (item.kind === 'recruitment-mail') {
    return (
      <>
        <p>选定候选人：<strong>{payload.candidate ?? ''}</strong></p>
        <p>发件邮箱：{payload.mailbox ?? ''}<br />收件地址（投递邮件发件人）：{payload.to ?? ''}</p>
        <p>主题：{payload.subject ?? ''}</p>
        <pre className="approval-preview">{payload.body ?? ''}</pre>
        <p>批准后发送此邮件；请核对收件地址是否为候选人本人。</p>
      </>
    );
  }
  if (item.kind === 'publish-report') {
    const top = payload.report?.top ?? [];
    return top.length === 0
      ? <p>暂无推荐候选人，请查看完整报告中的失败及转人工明细。</p>
      : (
        <>
          {top.map((candidate) => (
            <p key={candidate.label}><strong>{candidate.label}</strong> · {candidate.totalScore} 分<br />{candidate.reason ?? ''}</p>
          ))}
        </>
      );
  }
  return (
    <>
      <p>工具：{payload.name ?? ''}</p>
      <pre className="approval-preview">{payload.arguments ?? ''}</pre>
    </>
  );
}

/** 审批卡：严格模式下的计划/工具/发布/邮件审批。 */
export function ApprovalHost({ approvals, executionMode, busy, onDecide }: {
  approvals: RunApproval[];
  executionMode?: string;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
}): ReactElement {
  const pending = approvals.filter((item) => item.status === 'pending' && item.kind !== 'memory-policy-change');
  const finished = approvals.filter((item) => ['executing', 'rejected', 'failed'].includes(item.status));
  const finishedText: Record<string, string> = {
    executing: '执行中（若服务已重启，请人工核对结果，不会自动重放）',
    rejected: '已拒绝，未执行',
    failed: '执行失败，可重新发起',
  };
  return (
    <div id="approval-host" className="hitl-host">
      {executionMode === 'strict' ? <div className="muted">严格模式 · 计划、工具与发布需审批</div> : null}
      {pending.map((item) => (
        <div className="hitl-card" key={item.id}>
          <h3>{APPROVAL_TITLES[item.kind] ?? item.kind}</h3>
          <p>批准仅适用于下列具体内容。拒绝后不会继续执行；需要修改时请重新发起。</p>
          <ApprovalSummary item={item} />
          <details>
            <summary>查看完整审批内容与证据</summary>
            <pre className="approval-preview">{item.payload_json}</pre>
          </details>
          <div className="hitl-options">
            <button className="hitl-option" data-approval={item.id} data-decision="approve" disabled={busy} onClick={() => onDecide(item.id, 'approve')}>
              批准{item.kind === 'tool' ? '并执行' : '并继续'}
            </button>
            <button className="hitl-option" data-approval={item.id} data-decision="reject" disabled={busy} onClick={() => onDecide(item.id, 'reject')}>
              拒绝
            </button>
          </div>
        </div>
      ))}
      {finished.map((item) => (
        <div className="muted" key={`${item.id}-done`}>
          {APPROVAL_TITLES[item.kind] ?? item.kind}：{finishedText[item.status] ?? item.status}
        </div>
      ))}
    </div>
  );
}

/** HITL 提问卡：选项直接回答，或由下方输入框自由作答。 */
export function HitlHost({ pending, busy, onAnswer }: {
  pending: PendingHitl | null | undefined;
  busy: boolean;
  onAnswer: (answer: string) => void;
}): ReactElement {
  if (!pending) return <div id="hitl-host" className="hitl-host" />;
  return (
    <div id="hitl-host" className="hitl-host">
      <div className="hitl-card">
        <h3>需要你确认 · {pending.node ?? 'HITL'}</h3>
        <div className="hitl-question">{pending.question ?? ''}</div>
        <div className="hitl-options">
          {(pending.options ?? []).map((option, index) => (
            <button
              className="hitl-option"
              data-hitl-index={index}
              key={option}
              disabled={busy}
              onClick={() => onAnswer(option)}
            >
              {option}{option === pending.recommendedOption ? '（推荐）' : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
