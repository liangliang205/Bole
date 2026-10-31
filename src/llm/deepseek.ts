import type { ChatRequest, StopReason } from '../types.ts';
import type { LlmProvider, ProviderResult } from './provider.ts';

export interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface DeepSeekResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

function mapFinishReason(reason: string | undefined): StopReason {
  if (reason === 'length') return 'max-tokens';
  if (reason === 'content_filter' || reason === 'safety') return 'refusal';
  return 'completed';
}

/** DeepSeek（OpenAI 兼容）提供方：flash=deepseek-chat，pro=deepseek-reasoner。 */
export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  readonly kind = 'deepseek' as const;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(opts: DeepSeekOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.BOLE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    if (!this.apiKey) {
      throw new Error('未配置 DEEPSEEK_API_KEY：请设置环境变量，或使用 --llm mock 运行离线 Demo');
    }
    const model = req.model ?? (req.tier === 'pro' ? 'deepseek-reasoner' : 'deepseek-chat');
    const started = performance.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            temperature: req.temperature ?? 0,
            max_tokens: req.maxTokens ?? 2048,
            response_format: req.schemaName ? { type: 'json_object' } : undefined,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text();
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`DeepSeek ${response.status}: ${body.slice(0, 200)}`);
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            continue;
          }
          throw new Error(`DeepSeek ${response.status}: ${body.slice(0, 300)}`);
        }
        const data = (await response.json()) as DeepSeekResponse;
        const text = data.choices?.[0]?.message?.content ?? '';
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        const cachedPromptTokens =
          data.usage?.prompt_cache_hit_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        return {
          text,
          usage: { promptTokens, completionTokens, cachedPromptTokens },
          stopReason: mapFinishReason(data.choices?.[0]?.finish_reason),
          model,
          latencyMs: Math.round(performance.now() - started),
          cacheHit: cachedPromptTokens > 0,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= this.maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error('DeepSeek 调用失败');
  }
}
