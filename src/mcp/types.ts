/**
 * 外接 MCP（Model Context Protocol）的类型定义。
 *
 * 设计约束：
 * - 配置是数据（config/mcp.json），代码只做校验与适配，不把任何具体服务写死；
 * - 连接失败必须降级，不能让一个坏掉的 MCP 服务拖垮筛选主流程；
 * - 工具名要满足 OpenAI function calling 的命名约束，同时保留「哪个服务、哪个原始工具」的可追溯性。
 */
import type { OpenAiToolSchema } from '../types.ts';

export type McpTransport = 'stdio' | 'http';

export interface McpDefaults {
  /** 单个服务的连接 + 工具发现超时。 */
  startTimeoutMs: number;
  /** 单次工具调用超时。 */
  callTimeoutMs: number;
  /** 每个服务最多暴露多少个工具（防止一次注入上百个工具把上下文打爆）。 */
  maxToolsPerServer: number;
  /** 单次工具结果回灌给模型的最大字符数。 */
  maxResultChars: number;
}

/** 一个已解析好的 MCP 服务配置（环境变量已展开、默认值已合并）。 */
export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio：启动命令与参数。 */
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** http：Streamable HTTP 端点。 */
  url?: string;
  headers: Record<string, string>;
  startTimeoutMs: number;
  callTimeoutMs: number;
  /** 允许暴露的工具：'*'、'server:tool'、'server:*'，在 server 粒度上等价于该服务全部工具。 */
  allowTools: string[];
  denyTools: string[];
  /** 是否静默服务进程的 stderr（默认继承，便于排查）。 */
  quiet: boolean;
  description: string;
  /** 配置层面的问题（例如密钥环境变量缺失）：存在时不启动，但也不影响其它服务。 */
  configError?: string;
}

export interface McpConfig {
  version: number;
  /** 实际加载的配置文件路径；不存在时为 null（表示「没有外接服务」而不是错误）。 */
  file: string | null;
  defaults: McpDefaults;
  servers: McpServerConfig[];
}

export type McpServerState = 'disabled' | 'starting' | 'ready' | 'failed' | 'stopped';

export interface McpServerStatus {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  state: McpServerState;
  tools: number;
  toolNames: string[];
  description: string;
  error?: string;
}

export interface McpStatus {
  enabled: boolean;
  configFile: string | null;
  /** 配置文件整体不可用时的原因（例如 JSON 语法错误）。 */
  configError?: string;
  tools: number;
  servers: McpServerStatus[];
}

/** MCP 工具调用结果：结构与 tools-call 的 ToolExecResult 对齐，便于直接回灌模型。 */
export interface McpCallResult {
  ok: boolean;
  message: string;
  files?: string[];
  data?: Record<string, unknown>;
}

/** 已暴露给模型的单个工具条目（保留原始工具名用于白名单匹配）。 */
export interface McpToolEntry {
  fullName: string;
  serverId: string;
  toolName: string;
  schema: OpenAiToolSchema;
}
