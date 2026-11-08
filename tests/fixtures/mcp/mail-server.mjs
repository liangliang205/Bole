/**
 * 测试用的只读邮箱 MCP 服务：不连接任何真实 IMAP，只按固定数据返回四个工具。
 * 用于验证 mcpMailAdapter 的连接、工具命名、JSON 解析、缓存路径校验和 close。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const cacheDir = process.env.BOLE_MAIL_CACHE ?? path.join(process.cwd(), '.mail-cache');
const server = new McpServer({ name: 'bole-mail-fixture', version: '1.0.0' });
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

server.registerTool(
  'identity',
  { description: 'Return the configured mailbox address.', inputSchema: {} },
  async () => json({ email: process.env.BOLE_MAIL_USER ?? 'hr@example.com' }),
);

server.registerTool(
  'search',
  {
    description: 'Return one fixed message with a resume attachment.',
    inputSchema: {
      query: z.string().optional(),
      after: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async () => json({ data: [{ message_id: '1726132069:125' }], pagination: { has_more: false, next_cursor: null } }),
);

server.registerTool(
  'read',
  {
    description: 'Return sender, subject and attachment list.',
    inputSchema: { messageId: z.string() },
  },
  async ({ messageId }) =>
    json({
      message_id: messageId,
      from: { email: 'candidate@example.com' },
      subject: '应聘前端开发工程师',
      attachments: [{ attachmentId: '2', filename: 'resume.pdf', size: 16 }],
    }),
);

server.registerTool(
  'download',
  {
    description: 'Write a fake PDF into the cache dir and return its path.',
    inputSchema: { messageId: z.string(), attachmentId: z.string() },
  },
  async ({ messageId, attachmentId }) => {
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${messageId.replace(/[^0-9]+/g, '-')}-${attachmentId}.pdf`);
    await writeFile(cachePath, '%PDF-1.7\nfixture\n');
    return json({ cachePath, filename: 'resume.pdf', bytes: 16 });
  },
);

await server.connect(new StdioServerTransport());
