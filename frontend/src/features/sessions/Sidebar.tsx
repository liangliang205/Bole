import { useEffect } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useJobs, jobTitle, formatJobTime, type JobSummary } from '../../api/jobs.ts';
import { useUiStore } from '../../store/ui.ts';
import { useWidthResizer } from '../../hooks/useWidthResizer.ts';

const SIDEBAR_WIDTH_KEY = 'bole.sidebarWidth';
const SIDEBAR_DEFAULT = 286;

function sidebarBounds(): { min: number; max: number } {
  return { min: 220, max: Math.max(260, Math.min(480, window.innerWidth - 560)) };
}

function JobRow({ job, active, onSelect }: { job: JobSummary; active: boolean; onSelect: (id: string) => void }): ReactElement {
  const status = job.activeStatus || 'idle';
  return (
    <div
      className={`job-item ${active ? 'active' : ''} ${job.archived ? 'archived' : ''}`}
      data-job={job.id}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(job.id)}
    >
      <div className="job-line">
        <span className={`dot ${status}`} />
        <span className="job-name">{jobTitle(job)}</span>
        <span className="job-time">{formatJobTime(job.createdTs)}</span>
        <button className="job-more" type="button" data-job-menu={job.id} title="会话操作">⋯</button>
      </div>
      <div className="job-meta">
        <span>{job.verified ?? 0} 通过</span>
        <span>{job.quarantine ?? 0} 转人工</span>
        {job.failed ? <span>{job.failed} 失败</span> : null}
        {job.pinned ? <span className="job-flag">置顶</span> : null}
        {job.archived ? <span className="job-flag">归档</span> : null}
      </div>
    </div>
  );
}

export function Sidebar(): ReactElement {
  const { data: jobs, isLoading } = useJobs();
  const activeJobId = useUiStore((state) => state.activeJobId);
  const showArchived = useUiStore((state) => state.showArchived);
  const search = useUiStore((state) => state.search);
  const setSearch = useUiStore((state) => state.setSearch);
  const setActiveJob = useUiStore((state) => state.setActiveJob);
  const toggleArchived = useUiStore((state) => state.toggleArchived);
  const openSettings = useUiStore((state) => state.openSettings);
  const openMailbox = useUiStore((state) => state.openMailbox);
  const openKnowledge = useUiStore((state) => state.openKnowledge);

  const resizer = useWidthResizer({
    storageKey: SIDEBAR_WIDTH_KEY,
    defaultValue: SIDEBAR_DEFAULT,
    cssVar: '--sidebar-width',
    factor: 1,
    side: 'right',
    bounds: sidebarBounds,
    activityClass: 'is-resizing',
  });

  const source = (jobs ?? []).filter((job) => (showArchived ? job.archived : !job.archived));
  const keyword = search.trim().toLowerCase();
  const visible = keyword
    ? source.filter((job) => `${jobTitle(job)} ${job.requirements ?? ''}`.toLowerCase().includes(keyword))
    : source;
  const count = visible.length;

  // 与旧实现一致：进页面自动选中第一个（未归档）会话
  useEffect(() => {
    if (activeJobId || !jobs || jobs.length === 0) return;
    const first = jobs.find((job) => !job.archived);
    if (first) setActiveJob(first.id);
  }, [activeJobId, jobs, setActiveJob]);

  const emptyNote = showArchived
    ? '还没有归档会话'
    : (jobs ?? []).length > 0 ? '没有匹配的会话' : '还没有会话，点击上方新建';

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">伯乐<span>BoLe</span></div>
          <div className="brand-sub">可验证的多 Agent 招聘筛选</div>
        </div>
        <button className="btn primary block" id="new-run-btn">＋ 新建筛选会话</button>
        <div className="search">
          <span className="search-icon">⌕</span>
          <input
            id="job-search"
            placeholder="搜索会话（/）"
            autoComplete="off"
            value={search}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
          />
        </div>
        <div className="side-title">
          <span>会话 <span id="job-count" className="muted">{count > 0 ? `${count} 个` : ''}</span></span>
          <button
            className={`link-btn ${showArchived ? 'active' : ''}`}
            id="archived-toggle"
            type="button"
            title={showArchived ? '返回正常会话' : '显示归档会话'}
            onClick={toggleArchived}
          >
            {showArchived ? '返回' : '归档'}
          </button>
        </div>
        <div id="job-list" className="job-list">
          {isLoading ? null : visible.length > 0
            ? visible.map((job) => (
              <JobRow key={job.id} job={job} active={job.id === activeJobId} onSelect={setActiveJob} />
            ))
            : <div className="empty-note">{emptyNote}</div>}
        </div>
        <div className="side-footer">
          <button className="btn ghost block" id="open-mailbox" onClick={() => openMailbox()}>✉ 招聘邮箱</button>
          <button className="btn ghost block" id="open-knowledge" onClick={() => openKnowledge()}>▤ 知识库</button>
          <button className="btn ghost block" id="open-settings" onClick={() => openSettings()}>⚙ 设置</button>
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        id="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        title="拖拽调整侧栏宽度"
        {...resizer}
      />
    </>
  );
}
