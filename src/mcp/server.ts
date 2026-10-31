import { createInterface } from 'node:readline';
import path from 'node:path';
import { InboxStore } from './inbox.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: 'inbox.list',
    description: '列出邮箱中的简历邮件（mock 邮箱扫描 inbox/*.eml）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'inbox.get',
    description: '获取一封邮件的正文与附件（附件以 base64 返回）',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string' } },
      required: ['messageId'],
      additionalProperties: false,
    },
  },
];

export class HireboxServer {
  readonly store: InboxStore;

  constructor(inboxDir: string) {
    this.store = new InboxStore(inboxDir);
  }

  handle(request: JsonRpcRequest): JsonRpcResponse | null {
    const id = request.id ?? null;
    if (request.method.startsWith('notifications/')) return null;

    try {
      switch (request.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'hirebox-mock', version: '0.1.0' },
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call': {
          const params = request.params ?? {};
          const name = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          if (name === 'inbox.list') {
            const messages = this.store.list();
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ messages }) }],
                isError: false,
              },
            };
          }
          if (name === 'inbox.get') {
            const messageId = String(args.messageId ?? '');
            if (!messageId) throw new Error('缺少 messageId');
            const message = this.store.get(messageId);
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(message) }],
                isError: false,
              },
            };
          }
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `未知工具: ${name}` },
          };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `未知方法: ${request.method}` },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}

export function runStdioServer(inboxDir: string): void {
  const server = new HireboxServer(inboxDir);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`);
      return;
    }
    const response = server.handle(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const inboxArg = process.argv.indexOf('--inbox');
  const inboxDir = inboxArg > 0 ? process.argv[inboxArg + 1] : process.env.BOLE_INBOX ?? path.resolve('data', 'inbox');
  runStdioServer(inboxDir);
}
