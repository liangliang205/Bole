import type { ChatRequest, StopReason } from '../types.ts';
import type { LlmProvider, ProviderResult } from './provider.ts';
import { estimateTokens } from '../util/text.ts';

export interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface DeepSeekResponse {
  choices?: {
    message?: { content?: string };
    delta?: { content?: string };
    finish_reason?: string;
  }[];
  usage?: DeepSeekUsage;
  error?: { message?: string };
}

function mapFinishReason(reason: string | undefined): StopReason {
  if (reason === 'length') return 'max-tokens';
  if (reason === 'content_filter' || reason === 'safety') return 'refusal';
  return 'completed';
}

function usageOf(usage: DeepSeekUsage | undefined, req: ChatRequest, text: string): ProviderResult['usage'] {
  const promptTokens = usage?.prompt_tokens ?? estimateTokens(`${req.system}\n${req.user}`);
  const completionTokens = usage?.completion_tokens ?? estimateTokens(text);
  const cachedPromptTokens =
    usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return { promptTokens, completionTokens, cachedPromptTokens };
}

/** DeepSeek（OpenAI 兼容）提供方：flash=deepseek-chat，pro=deepseek-reasoner；支持 token 级 SSE 流。 */
export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  readonly kind = 'deepseek' as const;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(opts: DeepSeekOptions = {}) {
    this.apiKey = opts.apiKey ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.BOLE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    if (!this.apiKey) {
      throw new Error('未绑定 DeepSeek API Key：请先在 Web 页面完成绑定。');
    }
    const model = req.model ?? (req.tier === 'pro' ? 'deepseek-reasoner' : 'deepseek-chat');
    const started = performance.now();
    let lastError: Error | null = null;
    let emitted = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const streaming = typeof req.onToken === 'function';
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
            max_tokens: req.maxTokens ?? 4096,
            // deepseek-reasoner 不一定支持 response_format，交给提示词 + 路由层 JSON 提取
            response_format:
              req.schemaName && !/reasoner/i.test(model) ? { type: 'json_object' } : undefined,
            stream: streaming,
            stream_options: streaming ? { include_usage: true } : undefined,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text();
          lastError = new Error(`DeepSeek ${response.status}: ${body.slice(0, 300)}`);
          if (response.status === 429 || response.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            continue;
          }
          throw lastError;
        }

        if (!streaming) {
          const data = (await response.json()) as DeepSeekResponse;
          const text = data.choices?.[0]?.message?.content ?? '';
          const usage = usageOf(data.usage, req, text);
          return {
            text,
            usage,
            stopReason: mapFinishReason(data.choices?.[0]?.finish_reason),
            model,
            latencyMs: Math.round(performance.now() - started),
            cacheHit: usage.cachedPromptTokens > 0,
          };
        }

        if (!response.body) throw new Error('DeepSeek 流式响应为空');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let finishReason: string | undefined;
        let usage: DeepSeekUsage | undefined;

        const consume = (payload: string): boolean => {
          if (payload === '[DONE]') return true;
          let chunk: DeepSeekResponse;
          try {
            chunk = JSON.parse(payload) as DeepSeekResponse;
          } catch {
            return false;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content ?? '';
          if (delta) {
            text += delta;
            emitted = true;
            req.onToken?.(delta);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
          return false;
        };

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLines = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());
            for (const payload of dataLines) {
              if (consume(payload)) {
                boundary = -1;
                break;
              }
            }
            if (boundary < 0) break;
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (buffer.trim()) {
          const dataLines = buffer
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          for (const payload of dataLines) consume(payload);
        }

        const finalUsage = usageOf(usage, req, text);
        return {
          text,
          usage: finalUsage,
          stopReason: mapFinishReason(finishReason),
          model,
          latencyMs: Math.round(performance.now() - started),
          cacheHit: finalUsage.cachedPromptTokens > 0,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // 已经向前端推送过 token 时不再重试，避免重复内容
        if (emitted) break;
        if (attempt >= this.maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error('DeepSeek 调用失败');
  }
}
