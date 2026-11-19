import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { api } from './client.ts';

export interface ReportCandidate {
  resumeId: string;
  label: string;
  totalScore?: number;
  conclusion?: string;
  evalPhase?: string;
  evalTier?: string;
  reason?: string;
  summary?: string;
}

export interface ReportData {
  top?: ReportCandidate[];
  escalations?: unknown[];
  compliance?: { duplicates?: unknown[]; failed?: unknown[]; reviewStats?: { vetoRate?: number } };
  run?: { status?: string };
}

/** 终稿报告；未生成时服务端返回空，调用方负责兜底。 */
export function useReport(jobId: string): UseQueryResult<ReportData | null> {
  return useQuery({
    queryKey: ['report', jobId],
    queryFn: async () => {
      try {
        const data = await api<{ report?: ReportData } & ReportData>(`/api/run/${encodeURIComponent(jobId)}/report`);
        return data.report ?? (data.top ? data : null);
      } catch {
        return null;
      }
    },
    enabled: Boolean(jobId),
    staleTime: 10_000,
  });
}

export const CONCLUSION_LABELS: Record<string, string> = {
  strong_yes: '强烈推荐', yes: '推荐', maybe: '待定', no: '不推荐', strong_no: '强烈不推荐', pending: '待评估',
};

export const PHASE_LABELS: Record<string, string> = { screen: '初筛', deep: '深评', revise: '重评' };

export function formatScore(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
