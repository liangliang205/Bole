import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { HireboxServer } from './server.ts';
import type { InboxMessageDetail, InboxMessageMeta } from './inbox.ts';

export interface McpTransport {
  readonly kind: string;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`MCP 错误 ${code}: ${message}`);
    this.name = 'McpError';
    this.code = code;
  }
}

export class InProcessTransport implements McpTransport {
  readonly kind = 'in-process';
  private server: HireboxServer;

  constructor(inboxDir: string) {
    this.server = new HireboxServer(inboxDir);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = this.server.handle({ jsonrpc: '2.0', id: 1, method, params });
    if (!response) return {};
    if (response.error) throw new McpError(response.error.code, response.error.message);
    return response.result;
  }

  notify(): void {
    // in-process 无通知语义
  }

  async close(): Promise<void> {
    // 无资源需要释放
  }
}

/** 真实 MCP stdio 传输：spawn 一个独立进程，按行发送 JSON-RPC。 */
export class StdioTransport implements McpTransport {
  readonly kind = 'stdio';
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;

  constructor(inboxDir: string, serverEntry?: string) {
    const entry = serverEntry ?? path.resolve(import.meta.dirname, 'server.ts');
    this.child = spawn(process.execPath, [entry, '--inbox', inboxDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line) as RpcResponse;
        if (response.id === null || response.id === undefined) return;
        const entryPending = this.pending.get(Number(response.id));
        if (!entryPending) return;
        clearTimeout(entryPending.timer);
        this.pending.delete(Number(response.id));
        if (response.error) entryPending.reject(new McpError(response.error.code, response.error.message));
        else entryPending.resolve(response.result);
      } catch {
        // 忽略无法解析的行
      }
    });
    this.child.stderr.on('data', () => {
      // 保留 stderr 但不阻塞
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const [id, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(new Error(`MCP 进程已退出（请求 ${id} 未完成）`));
        this.pending.delete(id);
      }
    });
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (this.closed) throw new Error('MCP 传输已关闭');
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, item] of this.pending) clearTimeout(item.timer);
    this.pending.clear();
    this.child.kill();
  }
}

interface ToolCallResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface HireboxConnectOptions {
  inboxDir: string;
  mode?: 'in-process' | 'stdio';
  timeoutMs?: number;
}

export class HireboxClient {
  private transport: McpTransport;
  private timeoutMs: number;

  constructor(transport: McpTransport, timeoutMs = 5000) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  static async connect(opts: HireboxConnectOptions): Promise<HireboxClient> {
    const transport: McpTransport =
      opts.mode === 'stdio' ? new StdioTransport(opts.inboxDir) : new InProcessTransport(opts.inboxDir);
    const client = new HireboxClient(transport, opts.timeoutMs ?? 5000);
    await client.initialize();
    return client;
  }

  get transportKind(): string {
    return this.transport.kind;
  }

  async initialize(): Promise<void> {
    await this.transport.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bole-fetcher', version: '0.1.0' },
      },
      this.timeoutMs,
    );
    this.transport.notify('notifications/initialized');
  }

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await this.transport.request('tools/call', { name, arguments: args }, this.timeoutMs)) as ToolCallResult;
    if (result.isError) throw new McpError(-32603, `工具 ${name} 返回错误`);
    const text = result.content?.[0]?.text;
    if (!text) throw new McpError(-32603, `工具 ${name} 返回空结果`);
    return JSON.parse(text) as unknown;
  }

  async listInbox(): Promise<InboxMessageMeta[]> {
    const data = (await this.callTool('inbox.list')) as { messages: InboxMessageMeta[] };
    return data.messages;
  }

  async getMessage(messageId: string): Promise<InboxMessageDetail> {
    return (await this.callTool('inbox.get', { messageId })) as InboxMessageDetail;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
