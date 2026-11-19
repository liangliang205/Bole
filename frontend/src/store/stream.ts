import { useSyncExternalStore } from 'react';

interface StreamState {
  text: string;
  connected: boolean;
}

let state: StreamState = { text: '', connected: false };
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
  reset(): void {
    if (state.text === '') return;
    state = { ...state, text: '' };
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
