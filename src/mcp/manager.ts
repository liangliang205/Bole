/**
 * MCP 管理器：加载配置、拉起所有启用的服务、按 Agent 白名单聚合工具、路由工具调用。
 *
 * 对外只有三个动作：start()（永不抛出）、toolsFor(白名单)、callTool(全名)。
 * 上层（对话主 Agent）只需要把 toolsFor() 的结果并进工具列表。
 */
import { McpConnection } from './client.ts';
import { MCP_DEFAULTS, loadMcpConfig, secretValues } from './config.ts';
import { allowsTool } from './schema.ts';
import type { OpenAiToolSchema } from '../types.ts';
import type { McpCallResult, McpConfig, McpDefaults, McpServerConfig, McpStatus, McpToolEntry } from './types.ts';

export interface McpManagerOptions {
  root?: string;
  /** 直接给服务配置（插件系统用），此时不再读取 config/mcp.json。 */
  servers?: McpServerConfig[];
  defaults?: McpDefaults;
}

export class McpManager {
  readonly root: string;
  private readonly config: McpConfig | null;
  private readonly configError: string | null;
  private readonly connections: McpConnection[];
  private startPromise: Promise<void> | null = null;

  private constructor(root: string, config: McpConfig | null, connections: McpConnection[], configError: string | null) {
    this.root = root;
    this.config = config;
    this.connections = connections;
    this.configError = configError;
  }

  /** 读取配置并构造管理器；配置整体损坏时降级为空管理器（错误记录在 status 里）。 */
  static async create(options: McpManagerOptions = {}): Promise<McpManager> {
    const root = options.root ?? process.cwd();
    if (options.servers) {
      const defaults = options.defaults ?? MCP_DEFAULTS;
      const secrets = secretValues(options.servers);
      const connections = options.servers.map(
        (server) =>
          new McpConnection(server, {
            maxToolsPerServer: defaults.maxToolsPerServer,
            maxResultChars: defaults.maxResultChars,
            secrets,
          }),
      );
      return new McpManager(root, null, connections, null);
    }
    try {
      const config = loadMcpConfig(options.root);
      const secrets = secretValues(config.servers);
      const connections = config.servers.map(
        (server) =>
          new McpConnection(server, {
            maxToolsPerServer: config.defaults.maxToolsPerServer,
            maxResultChars: config.defaults.maxResultChars,
            secrets,
          }),
      );
      return new McpManager(root, config, connections, null);
    } catch (error) {
      return new McpManager(root, null, [], error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 并行启动所有启用服务；单个失败只标记该服务，不影响其它服务与主流程。
   * 幂等：并发调用共享同一个启动 Promise，避免同一服务被拉起两次。
   */
  async start(): Promise<void> {
    if (this.startPromise) return await this.startPromise;
    const targets = this.connections.filter((connection) => connection.config.enabled && !connection.config.configError);
    this.startPromise = Promise.all(targets.map((connection) => connection.start())).then(() => undefined);
    return await this.startPromise;
  }

  /** 是否有任何服务配置（不代表连上）。 */
  isConfigured(): boolean {
    return this.connections.length > 0;
  }

  /** 当前真正可用的工具数量。 */
  readyToolCount(): number {
    return this.connections.reduce(
      (sum, connection) => sum + (connection.getServerState() === 'ready' ? connection.entries().length : 0),
      0,
    );
  }

  /** 按白名单（'*' / 'server' / 'server:tool' / 'server:*'）聚合可用工具。 */
  toolsFor(patterns: string[] | undefined): OpenAiToolSchema[] {
    if (!patterns || patterns.length === 0) return [];
    const schemas: OpenAiToolSchema[] = [];
    for (const connection of this.connections) {
      if (connection.getServerState() !== 'ready') continue;
      for (const entry of connection.entries()) {
        if (allowsTool(patterns, connection.id, entry.toolName)) schemas.push(entry.schema);
      }
    }
    return schemas;
  }

  toolEntries(): McpToolEntry[] {
    return this.connections.flatMap((connection) => connection.entries());
  }

  async callTool(fullName: string, rawArgs: string): Promise<McpCallResult> {
    const connection = this.connections.find((item) => item.hasTool(fullName));
    if (!connection) {
      const known = this.toolEntries().map((entry) => entry.fullName);
      return {
        ok: false,
        message: `未知 MCP 工具：${fullName}${known.length ? `（可用：${known.slice(0, 20).join(', ')}）` : '（当前没有可用的 MCP 工具）'}`,
      };
    }
    return connection.call(fullName, rawArgs);
  }

  status(): McpStatus {
    const servers = this.connections.map((connection) => {
      const error = connection.getError();
      return {
        id: connection.id,
        transport: connection.config.transport,
        enabled: connection.config.enabled,
        state: connection.getServerState(),
        tools: connection.getServerState() === 'ready' ? connection.entries().length : 0,
        toolNames: connection.entries().map((entry) => entry.toolName),
        description: connection.config.description,
        ...(error ? { error } : {}),
      };
    });
    return {
      enabled: servers.some((server) => server.enabled),
      configFile: this.config?.file ?? null,
      ...(this.configError ? { configError: this.configError } : {}),
      tools: servers.reduce((sum, server) => sum + server.tools, 0),
      servers,
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((connection) => connection.close()));
    this.startPromise = null;
  }
}
