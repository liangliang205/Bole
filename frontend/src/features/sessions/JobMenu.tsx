import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { jobTitle, type JobSummary } from '../../api/jobs.ts';

export type JobAction = 'pin' | 'rename' | 'archive' | 'copy' | 'delete';

/**
 * 会话操作菜单（⋯ 或右键唤出）。
 * 动作与旧实现的 handleJobAction 一一对应：置顶 / 重命名 / 归档 / 复制 ID / 删除。
 */
export function JobMenu({ job, x, y, onClose, onChanged }: {
  job: JobSummary;
  x: number;
  y: number;
  onClose: () => void;
  onChanged: (action: JobAction, job: JobSummary) => Promise<void> | void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  /** 菜单贴近视口边缘时向内收，避免溢出。 */
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 240);

  const run = async (action: JobAction): Promise<void> => {
    onClose();
    await onChanged(action, job);
  };

  return (
    <div id="session-menu" className="session-menu" ref={ref} style={{ position: 'fixed', left, top, zIndex: 60 }}>
      <div className="menu-hint">{jobTitle(job)}</div>
      <button className="session-menu-item" type="button" data-session-action="pin" onClick={() => { void run('pin'); }}>
        {job.pinned ? '取消置顶' : '置顶会话'}
      </button>
      <button className="session-menu-item" type="button" data-session-action="rename" onClick={() => { void run('rename'); }}>重命名</button>
      <button className="session-menu-item" type="button" data-session-action="archive" onClick={() => { void run('archive'); }}>
        {job.archived ? '取消归档' : '归档会话'}
      </button>
      <button className="session-menu-item" type="button" data-session-action="copy" onClick={() => { void run('copy'); }}>复制会话 ID</button>
      <div className="session-menu-sep" />
      <button className="session-menu-item danger" type="button" data-session-action="delete" onClick={() => { void run('delete'); }}>删除会话</button>
    </div>
  );
}

/** 执行一个菜单动作；返回是否应把当前会话切回新建页。 */
export async function applyJobAction(action: JobAction, job: JobSummary, toast: (message: string, tone?: string) => void): Promise<{ cleared: boolean }> {
  try {
    if (action === 'pin') {
      await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: JSON.stringify({ pinned: !job.pinned }) });
      toast(job.pinned ? '已取消置顶' : '已置顶会话', 'ok');
      return { cleared: false };
    }
    if (action === 'rename') {
      const input = window.prompt('重命名会话', jobTitle(job));
      if (input === null) return { cleared: false };
      const title = input.trim();
      if (!title) {
        toast('会话标题不能为空', 'error');
        return { cleared: false };
      }
      await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      toast('会话已重命名', 'ok');
      return { cleared: false };
    }
    if (action === 'archive') {
      const archived = !job.archived;
      await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: JSON.stringify({ archived }) });
      toast(archived ? '会话已归档' : '会话已取消归档', 'ok');
      return { cleared: archived };
    }
    if (action === 'copy') {
      await navigator.clipboard.writeText(job.id);
      toast('会话 ID 已复制', 'ok');
      return { cleared: false };
    }
    if (!window.confirm(`确定删除会话「${jobTitle(job)}」？该操作不可恢复。`)) return { cleared: false };
    await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    toast('会话已删除', 'ok');
    return { cleared: true };
  } catch (error) {
    toast(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    return { cleared: false };
  }
}
