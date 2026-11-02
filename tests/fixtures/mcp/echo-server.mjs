/**
 * 测试用的最小 MCP 服务：经由 stdio 暴露 echo / 带点号工具名 / 报错 / 长输出四个工具。
 * 只为验证「外接 MCP」能力（连接、工具发现、命名适配、错误与截断），不代表任何真实业务。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'bole-echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo the given text back.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool(
  'im.v1.message.create',
  {
    description: 'A dotted tool name, mirroring Feishu style API names.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `sent:${text}` }] }),
);

server.registerTool(
  'fail',
  {
    description: 'Always returns an isError result.',
    inputSchema: {},
  },
  async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
);

server.registerTool(
  'big',
  {
    description: 'Returns a long text payload to exercise result truncation.',
    inputSchema: { size: z.number().optional() },
  },
  async ({ size }) => ({ content: [{ type: 'text', text: 'x'.repeat(Math.min(Number(size ?? 4000), 20000)) }] }),
);

await server.connect(new StdioServerTransport());
