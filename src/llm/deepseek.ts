import type { ChatImage, ChatRequest, StopReason } from '../types.ts';
import type { LlmProvider, ProviderResult } from './provider.ts';
import { estimateTokens } from '../util/text.ts';

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** 请求协议；默认 OpenAI Chat Completions。 */
  protocol?: ProviderProtocol;
  /** 内置 DeepSeek：开启 thinking/reasoning_effort 与 JSON mode 等 DeepSeek 参数。 */
  deepseekStyle?: boolean;
  name?: string;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
}

interface RawResponse {
  choices?: { message?: { content?: string }; delta?: { content?: string }; finish_reason?: string }[];
  output_text?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  content?: { type?: string; text?: string }[];
  usage?: RawUsage;
  status?: string;
  stop_reason?: string;
  error?: { message?: string };
}

interface RequestSpec {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const PROTOCOLS: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

function mapFinishReason(reason: string | undefined): StopReason {
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') return 'max-tokens';
  if (reason === 'content_filter' || reason === 'safety' || reason === 'refusal') return 'refusal';
  return 'completed';
}

function imageData(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function textFromResponses(data: RawResponse | undefined): string {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function textFromAnthropic(data: RawResponse | undefined): string {
  if (!data?.content) return '';
  return data.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

function usageOf(protocol: ProviderProtocol, raw: RawUsage | undefined, req: ChatRequest, text: string): ProviderResult['usage'] {
  if (protocol === 'openai-responses') {
    const promptTokens = raw?.input_tokens ?? estimateTokens(`${req.system}\n${req.user}`);
    const completionTokens = raw?.output_tokens ?? estimateTokens(text);
    const cachedPromptTokens = raw?.input_tokens_details?.cached_tokens ?? 0;
    return { promptTokens, completionTokens, cachedPromptTokens };
  }
  if (protocol === 'anthropic-messages') {
    const cacheRead = raw?.cache_read_input_tokens ?? 0;
    const cacheCreation = raw?.cache_creation_input_tokens ?? 0;
    const promptTokens = (raw?.input_tokens ?? estimateTokens(`${req.system}\n${req.user}`)) + cacheRead + cacheCreation;
    const completionTokens = raw?.output_tokens ?? estimateTokens(text);
    return { promptTokens, completionTokens, cachedPromptTokens: cacheRead };
  }
  const promptTokens = raw?.prompt_tokens ?? estimateTokens(`${req.system}\n${req.user}`);
  const completionTokens = raw?.completion_tokens ?? estimateTokens(text);
  const cachedPromptTokens = raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0;
  return { promptTokens, completionTokens, cachedPromptTokens };
}

/** 解析 SSE：同时保留 event 名称与 data；兼容 CRLF 与无 event 的 data 帧。 */
async function readSse(response: Response, handler: (event: string, data: string) => void): Promise<void> {
  if (!response.body) throw new Error('流式响应为空');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (block: string): void => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) handler(event, dataLines.join('\n'));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) consume(buffer);
}

/** DeepSeek/OpenAI/Anthropic 兼容 HTTP 提供方，支持三种协议与 token 级 SSE。 */
export class DeepSeekProvider implements LlmProvider {
  readonly name: string;
  readonly kind = 'deepseek' as const;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private protocol: ProviderProtocol;
  private deepseekStyle: boolean;

  constructor(opts: DeepSeekOptions = {}) {
    this.name = opts.name ?? 'deepseek';
    this.apiKey = opts.apiKey ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.BOLE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.protocol = opts.protocol && PROTOCOLS.includes(opts.protocol) ? opts.protocol : 'openai-chat';
    this.deepseekStyle = opts.deepseekStyle ?? true;
  }

  private endpoint(): string {
    const base = this.deepseekStyle
      ? this.baseUrl
      : (/\/v1$/i.test(this.baseUrl) ? this.baseUrl : `${this.baseUrl}/v1`);
    if (this.protocol === 'openai-responses') return `${base}/responses`;
    if (this.protocol === 'anthropic-messages') {
      return this.baseUrl.endsWith('/v1') ? `${this.baseUrl}/messages` : `${this.baseUrl}/v1/messages`;
    }
    return `${base}/chat/completions`;
  }

  private buildRequest(req: ChatRequest, model: string, streaming: boolean): RequestSpec {
    const thinking = this.deepseekStyle && req.tier === 'pro';
    const qwen = /^qwen|^antdigital\//i.test(model) || /maas\.aliyuncs\.com|dashscope/i.test(this.baseUrl);
    const history = req.messages?.length ? req.messages : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.protocol === 'anthropic-messages') {
      headers['x-api-key'] = this.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    if (this.protocol === 'openai-responses') {
      const input = history
        ? history.map((message) => ({ role: message.role, content: message.content }))
        : req.images?.length
          ? [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: req.user },
                  ...req.images.map((image) => ({
                    type: 'input_image',
                    image_url: imageData(image),
                    detail: image.detail ?? 'high',
                  })),
                ],
              },
            ]
          : req.user;
      return {
        url: this.endpoint(),
        headers,
        body: {
          model,
          instructions: req.system,
          input,
          max_output_tokens: req.maxTokens ?? 4096,
          ...(this.deepseekStyle ? { reasoning: { effort: thinking ? 'high' : 'none' } } : {}),
          ...(qwen ? { enable_thinking: false } : {}),
          ...(thinking ? {} : { temperature: req.temperature ?? 0 }),
          ...(req.schemaName ? { text: { format: { type: 'json_object' } } } : {}),
          stream: streaming,
        },
      };
    }

    if (this.protocol === 'anthropic-messages') {
      const content = req.images?.length
        ? [
            { type: 'text', text: req.user },
            ...req.images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mimeType, data: image.base64 },
            })),
          ]
        : req.user;
      return {
        url: this.endpoint(),
        headers,
        body: {
          model,
          max_tokens: req.maxTokens ?? 4096,
          system: req.system,
          messages: history
            ? history.map((message) => ({ role: message.role, content: message.content }))
            : [{ role: 'user', content }],
          ...(this.deepseekStyle ? { thinking: thinking ? { type: 'enabled' } : { type: 'disabled' } } : {}),
          ...(this.deepseekStyle && thinking ? { output_config: { effort: 'high' } } : {}),
          ...(thinking ? {} : { temperature: req.temperature ?? 0 }),
          stream: streaming,
        },
      };
    }

    const content = req.images?.length
      ? [
          { type: 'text', text: req.user },
          ...req.images.map((image) => ({
            type: 'image_url',
            image_url: { url: imageData(image), detail: image.detail ?? 'high' },
          })),
        ]
      : req.user;
    return {
      url: this.endpoint(),
      headers,
      body: {
        model,
        messages: [
          { role: 'system', content: req.system },
          ...(history
            ? history.map((message) => ({ role: message.role, content: message.content }))
            : [{ role: 'user', content }]),
        ],
        ...(this.deepseekStyle
          ? {
              thinking: thinking ? { type: 'enabled' } : { type: 'disabled' },
              ...(thinking ? { reasoning_effort: 'high' } : { temperature: req.temperature ?? 0 }),
            }
          : { temperature: req.temperature ?? 0 }),
        max_tokens: req.maxTokens ?? 4096,
        ...(req.schemaName && this.deepseekStyle ? { response_format: { type: 'json_object' } } : {}),
        ...(qwen ? { enable_thinking: false } : {}),
        stream: streaming,
        ...(streaming && this.deepseekStyle ? { stream_options: { include_usage: true } } : {}),
      },
    };
  }

  private async consumeJson(req: ChatRequest, model: string, response: Response, started: number): Promise<ProviderResult> {
    const data = (await response.json()) as RawResponse;
    if (data.error?.message) throw new Error(data.error.message);
    let text = '';
    let finish: string | undefined;
    if (this.protocol === 'openai-responses') {
      text = textFromResponses(data);
      if (data.status === 'incomplete') finish = 'max_output_tokens';
      if (data.status === 'failed') throw new Error(data.error?.message ?? 'Responses API 返回 failed');
    } else if (this.protocol === 'anthropic-messages') {
      text = textFromAnthropic(data);
      finish = data.stop_reason;
    } else {
      text = data.choices?.[0]?.message?.content ?? '';
      finish = data.choices?.[0]?.finish_reason;
    }
    const usage = usageOf(this.protocol, data.usage, req, text);
    return {
      text,
      usage,
      stopReason: mapFinishReason(finish),
      model,
      latencyMs: Math.round(performance.now() - started),
      cacheHit: usage.cachedPromptTokens > 0,
    };
  }

  private async consumeStream(req: ChatRequest, model: string, response: Response, started: number): Promise<ProviderResult> {
    let text = '';
    let usageRaw: RawUsage | undefined;
    let finish: string | undefined;
    let failure: string | undefined;
    let fullText = '';
    let emitted = false;
    const emit = (delta: string): void => {
      if (!delta) return;
      text += delta;
      emitted = true;
      req.onToken?.(delta);
    };

    await readSse(response, (event, rawData) => {
      if (rawData === '[DONE]') return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        return;
      }
      if (this.protocol === 'openai-responses') {
        const type = String(data.type ?? event);
        if (type === 'response.output_text.delta') emit(String(data.delta ?? ''));
        if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
          const responseData = data.response as RawResponse | undefined;
          usageRaw = responseData?.usage ?? usageRaw;
          fullText = textFromResponses(responseData);
          if (type === 'response.incomplete') finish = 'max_output_tokens';
          if (type === 'response.failed') failure = responseData?.error?.message ?? 'Responses API 失败';
        }
        return;
      }
      if (this.protocol === 'anthropic-messages') {
        const type = String(data.type ?? event);
        if (type === 'content_block_delta') {
          const delta = data.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta') emit(String(delta.text ?? ''));
        } else if (type === 'message_start') {
          const message = data.message as RawResponse | undefined;
          usageRaw = { ...(message?.usage ?? {}), ...(usageRaw ?? {}) };
        } else if (type === 'message_delta') {
          usageRaw = { ...(usageRaw ?? {}), ...((data.usage as RawUsage | undefined) ?? {}) };
          const delta = data.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) finish = delta.stop_reason;
        } else if (type === 'error') {
          const error = data.error as { message?: string } | undefined;
          failure = error?.message ?? 'Anthropic Messages 流失败';
        }
        return;
      }
      const choice = (data.choices as RawResponse['choices'])?.[0];
      const delta = choice?.delta?.content ?? '';
      if (delta) emit(delta);
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (data.usage) usageRaw = data.usage as RawUsage;
    });

    if (failure) throw new Error(failure);
    if (!emitted && fullText) text = fullText;
    const usage = usageOf(this.protocol, usageRaw, req, text);
    return {
      text,
      usage,
      stopReason: mapFinishReason(finish),
      model,
      latencyMs: Math.round(performance.now() - started),
      cacheHit: usage.cachedPromptTokens > 0,
    };
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    if (!this.apiKey) throw new Error('未绑定模型提供商 API Key：请先在 Web 设置中填写。');
    const model = req.model ?? (req.tier === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash');
    const started = performance.now();
    let lastError: Error | null = null;
    let streaming = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        streaming = typeof req.onToken === 'function';
        const spec = this.buildRequest(req, model, streaming);
        const response = await fetch(spec.url, {
          method: 'POST',
          headers: spec.headers,
          body: JSON.stringify(spec.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text();
          lastError = new Error(`${this.protocol} ${response.status}: ${body.slice(0, 300)}`);
          if (response.status === 429 || response.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            continue;
          }
          throw lastError;
        }
        const result = streaming
          ? await this.consumeStream(req, model, response, started)
          : await this.consumeJson(req, model, response, started);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // 流式已经可能推送部分内容，重试会重复；交给上层标记失败。
        if (streaming) break;
        if (attempt >= this.maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error('模型调用失败');
  }
}
