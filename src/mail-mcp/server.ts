import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImapSession } from './session.ts';

const TOOLS: Tool[] = [
  {
    name: 'identity',
    description: '返回当前招聘邮箱地址。只读。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'search',
    description:
      '只读搜索邮箱中含简历附件（pdf/docx/doc）的邮件。返回 message_id 列表与翻页游标。不修改任何邮件状态。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按主题/发件人本地过滤，可留空' },
        after: { type: 'string', description: 'ISO 时间，只取该时间之后收到的邮件' },
        cursor: { type: 'string', description: '上一页返回的 next_cursor' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 20' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'read',
    description: '读取单封邮件的发件人、主题与附件清单。只读。',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'search 返回的 message_id' } },
      required: ['messageId'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'download',
    description:
      '把指定附件下载到服务端缓存目录，返回本地绝对路径。只读，不会把邮件标为已读，也不会删除或移动邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        attachmentId: { type: 'string', description: 'read 返回的 attachmentId' },
      },
      required: ['messageId', 'attachmentId'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
];

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`缺少参数 ${key}`);
  return value;
}

function intArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

export function createMailServer(session: ImapSession): Server {
  const handlers: Record<string, Handler> = {
    identity: async () => ({ email: await session.identity() }),
    search: async (args) =>
      await session.search({
        query: optionalString(args, 'query'),
        after: optionalString(args, 'after'),
        cursor: optionalString(args, 'cursor'),
        limit: intArg(args, 'limit', 20, 1, 100),
      }),
    read: async (args) => await session.read(requiredString(args, 'messageId')),
    download: async (args) =>
      await session.download(requiredString(args, 'messageId'), requiredString(args, 'attachmentId')),
  };

  const server = new Server(
    { name: 'bole-mail-imap', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (!handler) return errorResult(`未知工具：${request.params.name}`);
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}