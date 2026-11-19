import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { streamStore } from '../store/stream.ts';

/**
 * 订阅运行事件的 SSE。
 * 事件类型与旧实现的 connectStream 一致：status / snapshot / log / token / done。
 * 断线按 1s→2s→4s→10s 退避重连；收到 done 后清空流式文本并刷新数据。
 */
export function useRunStream(jobId: string, queryClient: QueryClient): void {
  useEffect(() => {
    if (!jobId) return;
    streamStore.reset();
    let source: EventSource | null = null;
    let retry = 0;
    let closed = false;
    let timer: number | undefined;

    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['run', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['events', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['chat', jobId] });
    };

    const connect = (): void => {
      source = new EventSource(`/api/run/${encodeURIComponent(jobId)}/stream?sinceSeq=0`);
      source.addEventListener('open', () => { retry = 0; streamStore.setConnected(true); });
      source.addEventListener('status', () => refresh());
      source.addEventListener('snapshot', () => refresh());
      source.addEventListener('log', () => refresh());
      source.addEventListener('token', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { text?: string; delta?: string };
        streamStore.pushToken(payload.text ?? payload.delta ?? '');
      });
      source.addEventListener('done', () => {
        streamStore.reset();
        refresh();
      });
      source.addEventListener('error', () => {
        streamStore.setConnected(false);
        source?.close();
        if (closed) return;
        retry += 1;
        const delay = Math.min(10_000, 1_000 * 2 ** (retry - 1));
        timer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      source?.close();
      streamStore.setConnected(false);
    };
  }, [jobId, queryClient]);
}
