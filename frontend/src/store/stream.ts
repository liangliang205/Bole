import { useSyncExternalStore } from 'react';

/** 与服务端 `src/types.ts` 的 StreamPreview 对齐。 */
export interface StreamPreviewLine {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'muted';
}

export interface StreamPreview {
  title: string;
  lines: StreamPreviewLine[];
}

interface StreamState {
  /** 服务端给的结结构化预览：对话里显示这个，不显示原始 JSON token */
  preview: StreamPreview | null;
  /** 原始 token 累积，仅在需要排查时用；不再直接渲染 */
  text: string;
  connected: boolean;
}

let state: StreamState = { preview: null, text: '', connected: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 流式 token 的外部 store。
 * 刻意不放进 React state：每个 token 触发一次全树渲染会卡死对话页。
 */
export const streamStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): StreamState {
    return state;
  },
  pushToken(token: string): void {
    state = { ...state, text: state.text + token };
    emit();
  },
  /** 服务端每帧都会带 preview（标题 + 若干行），界面只渲染它。 */
  setPreview(preview: StreamPreview | null | undefined): void {
    if (!preview || !Array.isArray(preview.lines)) return;
    state = { ...state, preview };
    emit();
  },
  reset(): void {
    if (state.text === '' && state.preview === null) return;
    state = { ...state, text: '', preview: null };
    emit();
  },
  setConnected(connected: boolean): void {
    if (state.connected === connected) return;
    state = { ...state, connected };
    emit();
  },
};

/** 只在流式文本变化时重渲染订阅者。 */
export function useStreamingText(): string {
  return useSyncExternalStore(streamStore.subscribe, () => streamStore.getSnapshot().text);
}

/** 结构化预览（标题 + 行），对话页用它代替裸 JSON。 */
export function useStreamingPreview(): StreamPreview | null {
  return useSyncExternalStore(streamStore.subscribe, () => streamStore.getSnapshot().preview);
}
