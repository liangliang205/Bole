import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './client.ts';

export interface JobSummary {
  id: string;
  title?: string;
  requirements?: string;
  archived?: boolean;
  activeStatus?: string;
  verified?: number;
  quarantine?: number;
  failed?: number;
  pinned?: boolean;
  createdTs?: number;
}

interface JobsResponse {
  ok: boolean;
  jobs: JobSummary[];
}

/** 会话列表。旧实现是事件驱动刷新，这里用短 staleTime + 手动失效。 */
export function useJobs(): UseQueryResult<JobSummary[]> {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: async () => (await api<JobsResponse>('/api/jobs')).jobs ?? [],
    staleTime: 5_000,
  });
}

/** 会话标题：与旧实现 jobTitle 逐条对齐——占位标题"待画像岗位"要被需求前 32 字替代。 */
export function jobTitle(job: JobSummary): string {
  const title = (job.title ?? '').trim();
  if (title && title !== '待画像岗位') return title;
  const requirements = (job.requirements ?? '').trim();
  return requirements ? requirements.slice(0, 32) : '未命名会话';
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 旧实现的时间格式：MM/DD HH:mm。 */
export function formatJobTime(timestamp: number | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
