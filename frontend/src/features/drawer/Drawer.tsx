import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

export type DrawerTab = 'candidates' | 'compliance' | 'cost' | 'memory' | 'agents' | 'workflow';

const TABS: { key: DrawerTab; label: string }[] = [
  { key: 'candidates', label: '候选人' },
  { key: 'compliance', label: '合规' },
  { key: 'cost', label: '成本' },
  { key: 'memory', label: '任务记忆' },
  { key: 'agents', label: 'Agent' },
  { key: 'workflow', label: '工作流' },
];

interface Candidate {
  resumeId: string;
  label: string;
  format?: string;
  status?: string;
  score?: number;
  tier?: string;
  verdict?: string;
}

const STATUS_LABEL: Record<string, string> = {
  queued: '待解析', parsing: '解析中', parsed: '已解析', evaluating: '评估中', evaluated: '已评估',
  verifying: '核查中', verified: '已核查', reported: '已上报', quarantine: '转人工', failed: '失败', duplicate: '重复',
};

function statusTone(status: string | undefined): string {
  if (status === 'reported' || status === 'verified') return 'ok';
  if (status === 'quarantine' || status === 'failed') return 'danger';
  if (status === 'duplicate') return 'warn';
  return '';
}

function score(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 候选人页：表格列与旧实现一致（候选人/状态/分数/档位/核查）。 */
function CandidatesTab({ jobId }: { jobId: string }): ReactElement {
  const { data, isLoading } = useQuery({
    queryKey: ['candidates', jobId],
    queryFn: async () => (await api<{ candidates?: Candidate[] }>(`/api/run/${encodeURIComponent(jobId)}/candidates`)).candidates ?? [],
    enabled: Boolean(jobId),
    staleTime: 3_000,
  });
  if (isLoading) return <div className="empty-note">正在读取候选人…</div>;
  const candidates = data ?? [];
  if (candidates.length === 0) return <div className="empty-note">暂无候选人数据</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>候选人</th><th>状态</th><th>分数</th><th>档位</th><th>核查</th></tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr className="clickable" data-candidate={candidate.resumeId} key={candidate.resumeId}>
              <td><b>{candidate.label}</b><div className="muted">{candidate.format ?? ''}</div></td>
              <td><span className={`tag ${statusTone(candidate.status)}`}>{STATUS_LABEL[candidate.status ?? ''] ?? candidate.status ?? ''}</span></td>
              <td>{score(candidate.score)}</td>
              <td>{candidate.tier ?? ''}</td>
              <td>{candidate.verdict ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 任务面板：结构、id、tab 顺序与 index.html 的 #drawer 一致。
 * 目前只有候选人页接了数据；其余页是占位，属 F3 后续步骤。
 */
export function Drawer({ jobId }: { jobId: string }): ReactElement {
  const open = useUiStore((state) => state.drawerOpen);
  const tab = useUiStore((state) => state.drawerTab);
  const setTab = useUiStore((state) => state.setDrawerTab);
  const close = useUiStore((state) => state.closeDrawer);

  return (
    <aside id="drawer" className={`drawer${open ? '' : ' hidden'}`}>
      <div id="drawer-resizer" className="drawer-resizer" role="separator" aria-orientation="vertical" title="拖拽调整任务面板宽度" />
      <div className="drawer-head">
        <div className="drawer-tabs" id="drawer-tabs">
          {TABS.map((item) => (
            <button
              key={item.key}
              className={`tab${item.key === tab ? ' active' : ''}`}
              data-drawer-tab={item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="btn ghost" id="drawer-close" onClick={close}>✕</button>
      </div>
      <div id="drawer-body" className="drawer-body">
        {jobId === '' ? <div className="empty-note">选择会话后查看任务详情</div>
          : tab === 'candidates' ? <CandidatesTab jobId={jobId} />
            : <div className="empty-note">读取中…</div>}
      </div>
    </aside>
  );
}
