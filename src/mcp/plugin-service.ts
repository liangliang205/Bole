/**
 * MCP 插件服务：把「插件注册表」与「运行时连接」绑在一起。
 *
 * - 任何写操作（安装/启停/编辑/删除）都串行执行，并在事务末尾重建连接池；
 * - 重建失败不会让旧连接失效（旧管理器在新管理器就绪后才关闭）；
 * - 对 Web/CLI 只暴露 view() 与 test()，不泄漏凭据。
 */
import { McpManager } from './manager.ts';
import { McpPluginError, McpPluginStore, type McpPluginInput, type McpPluginPublic } from './plugins.ts';
import type { McpStatus } from './types.ts';

export interface McpPluginTestResult {
  ok: boolean;
  state: string;
  tools: string[];
  error?: string;
  latencyMs: number;
}

export interface McpPluginView {
  enabled: boolean;
  storeFile: string;
  loadError: string | null;
  plugins: McpPluginPublic[];
  status: McpStatus;
}

export class McpPluginService {
  readonly root: string;
  private readonly store: McpPluginStore;
  private manager: McpManager;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(root: string, store: McpPluginStore, manager: McpManager) {
    this.root = root;
    this.store = store;
    this.manager = manager;
  }

  static async create(options: { dataDir: string; root?: string }): Promise<McpPluginService> {
    const store = new McpPluginStore({ dataDir: options.dataDir, root: options.root });
    await store.ensureLoaded();
    const manager = await McpManager.create({ root: options.root, servers: store.serverConfigs() });
    return new McpPluginService(options.root ?? process.cwd(), store, manager);
  }

  /** 后台启动所有启用插件；重复调用幂等。 */
  async start(): Promise<void> {
    await this.manager.start();
  }

  /** 当前生效的连接池（对话主 Agent 用）。 */
  managerRef(): McpManager {
    return this.manager;
  }

  async view(): Promise<McpPluginView> {
    await this.manager.start();
    const plugins = this.store.public();
    return {
      enabled: plugins.some((plugin) => plugin.enabled),
      storeFile: this.store.storeFile,
      loadError: this.store.getLoadError(),
      plugins,
      status: this.manager.status(),
    };
  }

  async install(input: McpPluginInput): Promise<McpPluginPublic> {
    return await this.mutate(async () => {
      const plugin = await this.store.install(input);
      await this.rebuild();
      return this.publicOf(plugin.id);
    });
  }

  async update(id: string, patch: McpPluginInput): Promise<McpPluginPublic> {
    return await this.mutate(async () => {
      await this.store.update(id, patch);
      await this.rebuild();
      return this.publicOf(id);
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      await this.store.remove(id);
      await this.rebuild();
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpPluginPublic> {
    return await this.mutate(async () => {
      await this.store.setEnabled(id, enabled);
      await this.rebuild();
      return this.publicOf(id);
    });
  }

  /** 从磁盘重新读取插件库并重建连接（用于手改 plugins.json 后热重载）。 */
  async reload(): Promise<McpPluginView> {
    return await this.mutate(async () => {
      await this.store.reload();
      await this.rebuild();
      return await this.view();
    });
  }

  /** 单独测试一个插件：临时连接、列工具、立刻关闭，避免污染主连接池。 */
  async test(id: string): Promise<McpPluginTestResult> {
    const plugin = this.store.get(id);
    if (!plugin) throw new McpPluginError(`插件不存在：${id}`);
    const startedAt = Date.now();
    const manager = await McpManager.create({ root: this.root, servers: [this.store.serverConfigFor(plugin)] });
    try {
      await manager.start();
      const status = manager.status();
      const server = status.servers[0];
      return {
        ok: server?.state === 'ready',
        state: server?.state ?? 'failed',
        tools: server?.toolNames ?? [],
        ...(server?.error ? { error: server.error } : {}),
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      await manager.close();
    }
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  private publicOf(id: string): McpPluginPublic {
    const found = this.store.public().find((plugin) => plugin.id === id);
    if (!found) throw new McpPluginError(`插件不存在：${id}`);
    return found;
  }

  private async rebuild(): Promise<void> {
    const next = await McpManager.create({ root: this.root, servers: this.store.serverConfigs() });
    await next.start();
    const previous = this.manager;
    this.manager = next;
    void previous.close();
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}
