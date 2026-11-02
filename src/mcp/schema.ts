/**
 * MCP 工具 → OpenAI Function Calling 的适配层。
 *
 * 模型侧的工具名必须满足 `^[a-zA-Z0-9_-]{1,64}$`，而 MCP 允许点号（例如飞书的
 * `im.v1.message.create`），所以统一命名成 `mcp__<server>__<tool>` 并做字符清洗；
 * 超过 64 字符时用短哈希兜底，保证名字稳定且可反查。
 */
import { createHash } from 'node:crypto';
import type { OpenAiToolSchema } from '../types.ts';

export const MCP_TOOL_PREFIX = 'mcp__';
const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 600;

/** MCP 工具的最小结构（避免依赖 SDK 的内部类型）。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function sanitizeFragment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'x';
}

export function mcpToolName(serverId: string, toolName: string): string {
  const candidate = `${MCP_TOOL_PREFIX}${sanitizeFragment(serverId)}__${sanitizeFragment(toolName)}`;
  if (candidate.length <= MAX_TOOL_NAME) return candidate;
  const digest = createHash('sha256').update(`${serverId}\u0000${toolName}`).digest('hex').slice(0, 6);
  return `${candidate.slice(0, MAX_TOOL_NAME - 7)}_${digest}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function normalizeParameters(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { type: 'object', properties: {} };
  }
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  // 这两个关键字只对 JSON Schema 文档自身有意义，部分网关会因此拒绝请求。
  delete out.$schema;
  delete out.$id;
  if (out.type !== 'object') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
    out.properties = {};
  }
  return out;
}

export function toOpenAiToolSchema(serverId: string, tool: McpToolDescriptor): OpenAiToolSchema {
  const description = (tool.description ?? '').trim();
  return {
    type: 'function',
    function: {
      name: mcpToolName(serverId, tool.name),
      description: `[MCP:${serverId}] ${truncate(description || tool.name, MAX_DESCRIPTION)}`,
      parameters: normalizeParameters(tool.inputSchema),
    },
  };
}

/**
 * 白名单匹配：
 * - `*`：所有服务、所有工具；
 * - `server`：该服务全部工具；
 * - `server:tool` / `server:*`：精确匹配 / 该服务全部工具；
 * - `*:tool`：任意服务里的同名工具。
 */
export function allowsTool(patterns: string[], serverId: string, toolName: string): boolean {
  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern) continue;
    if (pattern === '*') return true;
    const colon = pattern.indexOf(':');
    if (colon < 0) {
      if (pattern === serverId) return true;
      continue;
    }
    const server = pattern.slice(0, colon);
    const tool = pattern.slice(colon + 1);
    if (server !== serverId && server !== '*') continue;
    if (tool === '*' || tool === toolName) return true;
  }
  return false;
}

/** 同一个服务内部去重：极端情况下两个原始工具可能清洗成同一个名字。 */
export function dedupeToolName(used: Set<string>, serverId: string, toolName: string): string {
  let candidate = mcpToolName(serverId, toolName);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  for (;;) {
    const digest = createHash('sha256').update(`${serverId}\u0000${toolName}\u0000${index}`).digest('hex').slice(0, 4);
    candidate = `${mcpToolName(serverId, toolName).slice(0, MAX_TOOL_NAME - 5)}_${digest}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}
