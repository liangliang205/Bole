/**
 * 单个 MCP 服务连接：负责启动传输、发现工具、把工具调用结果转成可回灌模型的文本。
 *
 * 失败策略：绝不让异常冒泡到筛选流程——连接失败/超时/工具报错都转成结构化结果，
 * 状态记录在连接对象上，由 /api/mcp 与 `bole mcp` 呈现。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { allowsTool, dedupeToolName, toOpenAiToolSchema, truncate, type McpToolDescriptor } from './schema.ts';
import type { McpCallResult, McpServerConfig, McpServerState, McpToolEntry } from './types.ts';

const CLOSE_TIMEOUT_MS = 5_000;
const CLIENT_INFO = { name: 'bole', version: '0.1.0' };

interface ConnectionOptions {
  maxToolsPerServer: number;
  maxResultChars: number;
  /** 需要从错误信息里抹掉的凭据值。 */
  secrets: string[];
}

interface McpContentItem {
  type?: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class McpConnection {
  readonly config: McpServerConfig;
  private readonly options: ConnectionOptions;
  private client: Client | null = null;
  private entriesByTool: McpToolEntry[] = [];
  private state: McpServerState = 'disabled';
  private failure: string | null = null;

  constructor(config: McpServerConfig, options: ConnectionOptions) {
    this.config = config;
    this.options = options;
    if (config.configError) {
      this.state = 'failed';
      this.failure = config.configError;
    } else if (!config.enabled) {
      this.state = 'disabled';
    }
  }

  get id(): string {
    return this.config.id;
  }

  getServerState(): McpServerState {
    return this.state;
  }

  getError(): string | null {
    return this.failure ? this.scrub(this.failure) : null;
  }

  entries(): McpToolEntry[] {
    return this.entriesByTool;
  }

  hasTool(fullName: string): boolean {
    return this.entriesByTool.some((entry) => entry.fullName === fullName);
  }

  private scrub(text: string): string {
    let out = text;
    for (const secret of this.options.secrets) {
      if (secret.length >= 4) out = out.split(secret).join('***');
    }
    return out.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***');
  }

  private createTransport(): Transport {
    if (this.config.transport === 'http') {
      const url = new URL(this.config.url as string);
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { ...this.config.headers },
        },
      });
    }
    const env = { ...getDefaultEnvironment(), ...this.config.env };
    return new StdioClientTransport({
      command: this.config.command as string,
      args: this.config.args,
      env,
      stderr: this.config.quiet ? 'ignore' : 'inherit',
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.state === 'failed' && this.config.configError) return;
    if (!this.config.enabled) {
      this.state = 'disabled';
      return;
    }
    this.state = 'starting';
    this.failure = null;
    try {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      const transport = this.createTransport();
      this.client = client;
      await withTimeout(
        client.connect(transport, { timeout: this.config.startTimeoutMs }),
        this.config.startTimeoutMs,
        `连接 MCP 服务「${this.config.id}」超时（${this.config.startTimeoutMs}ms）`,
      );
      const listed = await client.listTools({}, { timeout: this.config.startTimeoutMs });
      this.entriesByTool = this.buildEntries((listed.tools ?? []) as McpToolDescriptor[]);
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed';
      this.failure = errorText(error);
      await this.teardown();
    }
  }

  private buildEntries(tools: McpToolDescriptor[]): McpToolEntry[] {
    const used = new Set<string>();
    const entries: McpToolEntry[] = [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      if (!allowsTool(this.config.allowTools, this.config.id, tool.name)) continue;
      if (allowsTool(this.config.denyTools, this.config.id, tool.name)) continue;
      if (entries.length >= this.options.maxToolsPerServer) break;
      const fullName = dedupeToolName(used, this.config.id, tool.name);
      const schema = toOpenAiToolSchema(this.config.id, tool);
      schema.function.name = fullName;
      entries.push({ fullName, serverId: this.config.id, toolName: tool.name, schema });
    }
    return entries;
  }

  async call(fullName: string, rawArgs: string): Promise<McpCallResult> {
    if (this.state !== 'ready' || !this.client) {
      const detail = this.getError();
      return {
        ok: false,
        message: `MCP 服务「${this.config.id}」不可用（状态 ${this.state}）${detail ? `：${detail}` : ''}`,
      };
    }
    const entry = this.entriesByTool.find((item) => item.fullName === fullName);
    if (!entry) {
      return { ok: false, message: `MCP 服务「${this.config.id}」没有暴露工具 ${fullName}` };
    }
    let args: Record<string, unknown> = {};
    if (rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else return { ok: false, message: `MCP 工具参数必须是 JSON 对象：${rawArgs.slice(0, 200)}` };
      } catch {
        return { ok: false, message: `MCP 工具参数不是合法 JSON：${rawArgs.slice(0, 200)}` };
      }
    }
    try {
      const result = (await this.client.callTool(
        { name: entry.toolName, arguments: args },
        undefined,
        { timeout: this.config.callTimeoutMs },
      )) as {
        content?: McpContentItem[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const parts: string[] = [];
      for (const item of result.content ?? []) {
        switch (item?.type) {
          case 'text':
            if (typeof item.text === 'string' && item.text) parts.push(item.text);
            break;
          case 'image':
            parts.push(`[图片输出已省略${item.mimeType ? `（${item.mimeType}）` : ''}]`);
            break;
          case 'audio':
            parts.push('[音频输出已省略]');
            break;
          case 'resource_link':
            parts.push(`[资源链接] ${item.uri ?? item.name ?? ''}`.trim());
            break;
          case 'resource':
            parts.push(item.resource?.text ?? `[资源] ${item.resource?.uri ?? ''}`.trim());
            break;
          default:
            break;
        }
      }
      if (result.structuredContent !== undefined) {
        try {
          parts.push(JSON.stringify(result.structuredContent));
        } catch {
          parts.push('[structuredContent 无法序列化]');
        }
      }
      const text = parts.join('\n\n').trim();
      const message = truncate(text || '（MCP 服务返回空结果）', this.options.maxResultChars);
      return {
        ok: result.isError !== true,
        message,
        data: {
          server: this.config.id,
          tool: entry.toolName,
          isError: result.isError === true,
          chars: message.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: `MCP 工具 ${entry.toolName} 调用失败：${this.scrub(errorText(error))}`,
      };
    }
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await withTimeout(client.close(), CLOSE_TIMEOUT_MS, '关闭 MCP 连接超时');
    } catch {
      // 关闭失败不影响主流程；子进程由传输层负责回收
    }
  }

  async close(): Promise<void> {
    const previous = this.state;
    await this.teardown();
    this.entriesByTool = [];
    this.state = previous === 'failed' ? 'failed' : previous === 'disabled' ? 'disabled' : 'stopped';
  }
}
