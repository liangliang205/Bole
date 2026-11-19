import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './client.ts';

export interface RunEvent {
  seq?: number;
  ts?: number;
  type: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface ChatAttachment {
  name: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  created_ts?: number;
  files?: string[];
  attachments?: ChatAttachment[];
}

export interface JobSnapshot {
  requirements?: string;
  seed?: string;
  created_ts?: number;
}

export interface RunSnapshot {
  job?: JobSnapshot;
  [key: string]: unknown;
}

export interface RunState {
  status?: string;
  pendingHitl?: { id: string; question?: string; node?: string } | null;
  [key: string]: unknown;
}

interface RunResponse {
  ok: boolean;
  run?: RunState;
  snapshot?: RunSnapshot;
}

interface ChatResponse {
  ok: boolean;
  messages?: ChatMessage[];
}

interface EventsResponse {
  ok: boolean;
  events?: RunEvent[];
}

export function useRun(jobId: string): UseQueryResult<RunResponse> {
  return useQuery({
    queryKey: ['run', jobId],
    queryFn: async () => api<RunResponse>(`/api/run/${encodeURIComponent(jobId)}`),
    enabled: Boolean(jobId),
    staleTime: 2_000,
  });
}

export function useChatMessages(jobId: string): UseQueryResult<ChatMessage[]> {
  return useQuery({
    queryKey: ['chat', jobId],
    queryFn: async () => (await api<ChatResponse>(`/api/run/${encodeURIComponent(jobId)}/chat`)).messages ?? [],
    enabled: Boolean(jobId),
    staleTime: 2_000,
  });
}

export function useRunEvents(jobId: string): UseQueryResult<RunEvent[]> {
  return useQuery({
    queryKey: ['events', jobId],
    queryFn: async () => (await api<EventsResponse>(`/api/run/${encodeURIComponent(jobId)}/events?sinceSeq=0&limit=200`)).events ?? [],
    enabled: Boolean(jobId),
    staleTime: 2_000,
  });
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 消息时间戳：旧实现为 HH:mm:ss。 */
export function formatClock(timestamp: number | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
