import type { ChatRequest, StopReason } from '../types.ts';

export interface ProviderResult {
  text: string;
  json?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
  };
  stopReason: StopReason;
  model: string;
  latencyMs: number;
  cacheHit: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly kind: 'mock' | 'deepseek';
  chat(req: ChatRequest): Promise<ProviderResult>;
}
