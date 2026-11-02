/**
 * MCP 插件注册表：把「外接 MCP 服务」做成可安装/启用/禁用/编辑的插件。
 *
 * 设计要点（对齐 DSH 的插件思路，但刻意精简）：
 * - 插件状态落 `data/mcp/plugins.json`，凭据（env / headers）单独用 AES-256-GCM 加密后内嵌；
 * - 插件只有 enabled 开关，不做事先/事后 hook 的注册表；
 * - 单个插件坏掉（凭据解不开、配置非法）只标记该插件，不阻塞其它插件与主流程；
 * - 兼容旧的 `config/mcp.json`：插件库首次创建时把旧配置导入为 imported 插件。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MCP_DEFAULTS, loadMcpConfig } from './config.ts';
import { SecretBox, SecretBoxError } from './secret-box.ts';
import type { McpServerConfig, McpTransport } from './types.ts';

export type McpPluginSource = 'user' | 'builtin' | 'imported';

export interface McpPlugin {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  allowTools: string[];
  denyTools: string[];
  startTimeoutMs: number;
  callTimeoutMs: number;
  quiet: boolean;
  /** 明文只在内存中；落盘时合并加密。 */
  env: Record<string, string>;
  headers: Record<string, string>;
  source: McpPluginSource;
  installedAt: string;
  updatedAt: string;
  credentialError?: string;
}

/** 对外（Web API）展示的插件视图：凭据只暴露键名，不暴露值。 */
export interface McpPluginPublic extends Omit<McpPlugin, 'env' | 'headers'> {
  envKeys: string[];
  headerKeys: string[];
  hasCredentials: boolean;
}

export interface McpPluginInput {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: McpTransport;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  allowTools?: string[] | null;
  denyTools?: string[] | null;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  quiet?: boolean;
  /** 传了才整体替换；值 `***` 表示保留原值。 */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  clearCredentials?: boolean;
  source?: McpPluginSource;
}

interface StoredPlugin extends Omit<McpPlugin, 'env' | 'headers' | 'credentialError'> {
  envKeys: string[];
  headerKeys: string[];
  /** SecretBox.seal({ env, headers }) */
  credentials?: string;
}

interface StoreFile {
  version: 1;
  plugins: StoredPlugin[];
}

export class McpPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpPluginError';
  }
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEEP = '***';

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return PLUGIN_ID.test(slug) ? slug : `mcp-${Date.now().toString(36).slice(-6)}`;
}

function stringMap(value: Record<string, string> | undefined, field: string): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpPluginError(`${field} 必须是键值对象`);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key).trim();
    if (!name) continue;
    if (typeof raw !== 'string') throw new McpPluginError(`${field}.${name} 必须是字符串`);
    out[name] = raw;
  }
  return out;
}

function applySecretPatch(existing: Record<string, string>, patch: Record<string, string> | undefined): Record<string, string> {
  if (!patch) return existing;
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const name = String(key).trim();
    if (!name) continue;
    const value = String(raw);
    if (value === '') continue;
    if (value === KEEP) {
      if (existing[name] !== undefined) next[name] = existing[name];
      continue;
    }
    next[name] = value;
  }
  return next;
}

/** 新建时丢弃空值与占位符，保证 hasCredentials 反映真实配置。 */
function pruneSecrets(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value && value !== KEEP) out[key] = value;
  }
  return out;
}

function normalizeArray(value: string[] | null | undefined, fallback: string[] = []): string[] {
  if (value === null || value === undefined) return fallback;
  if (!Array.isArray(value)) throw new McpPluginError('工具白名单必须是字符串数组');
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new McpPluginError(`${field} 必须是正数`);
  return Math.floor(value);
}

export class McpPluginStore {
  readonly dataDir: string;
  private readonly root: string;
  private readonly file: string;
  private readonly box: SecretBox;
  private plugins = new Map<string, McpPlugin>();
  private loaded = false;
  private loadError: string | null = null;

  constructor(options: { dataDir: string; root?: string }) {
    this.dataDir = options.dataDir;
    this.root = options.root ?? process.cwd();
    this.file = path.join(this.dataDir, 'mcp', 'plugins.json');
    this.box = new SecretBox(this.dataDir);
  }

  get storeFile(): string {
    return this.file;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (existsSync(this.file)) {
      await this.readStore();
      return;
    }
    const imported = await this.importLegacy();
    this.plugins = imported;
    await this.writeStore();
  }

  private async importLegacy(): Promise<Map<string, McpPlugin>> {
    const result = new Map<string, McpPlugin>();
    try {
      const legacy = loadMcpConfig(this.root);
      for (const server of legacy.servers) {
        if (server.configError) continue;
        const stamp = nowIso();
        result.set(server.id, {
          id: server.id,
          name: server.id,
          description: server.description || '从 config/mcp.json 导入',
          enabled: server.enabled,
          transport: server.transport,
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          url: server.url,
          allowTools: server.allowTools,
          denyTools: server.denyTools,
          startTimeoutMs: server.startTimeoutMs,
          callTimeoutMs: server.callTimeoutMs,
          quiet: server.quiet,
          env: server.env,
          headers: server.headers,
          source: 'imported',
          installedAt: stamp,
          updatedAt: stamp,
        });
      }
    } catch (error) {
      this.loadError = `旧配置导入失败：${error instanceof Error ? error.message : String(error)}`;
    }
    return result;
  }

  private async readStore(): Promise<void> {
    let parsed: unknown;
    try {
      const text = (await readFile(this.file, 'utf8')).replace(/^\uFEFF/, '');
      parsed = JSON.parse(text);
    } catch (error) {
      this.loadError = `插件库不是合法 JSON：${this.file}（${error instanceof Error ? error.message : String(error)}）`;
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.loadError = `插件库格式非法：${this.file}`;
      return;
    }
    const stored = (parsed as StoreFile).plugins;
    if (!Array.isArray(stored)) {
      this.loadError = `插件库缺少 plugins 数组：${this.file}`;
      return;
    }
    const map = new Map<string, McpPlugin>();
    for (const item of stored) {
      if (!item || typeof item.id !== 'string') continue;
      map.set(item.id, await this.hydrate(item));
    }
    this.plugins = map;
  }

  private async hydrate(stored: StoredPlugin): Promise<McpPlugin> {
    let env: Record<string, string> = {};
    let headers: Record<string, string> = {};
    let credentialError: string | undefined;
    if (stored.credentials) {
      try {
        const opened = await this.box.open<{ env?: Record<string, string>; headers?: Record<string, string> }>(stored.credentials);
        env = opened.env ?? {};
        headers = opened.headers ?? {};
      } catch (error) {
        credentialError = error instanceof SecretBoxError ? error.message : `凭据解密失败：${String(error)}`;
      }
    }
    const { envKeys: _envKeys, headerKeys: _headerKeys, credentials: _credentials, ...rest } = stored;
    return {
      ...rest,
      env,
      headers,
      ...(credentialError ? { credentialError } : {}),
    };
  }

  private async writeStore(): Promise<void> {
    const stored: StoredPlugin[] = [];
    for (const plugin of this.list()) {
      const record: StoredPlugin = {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        enabled: plugin.enabled,
        transport: plugin.transport,
        command: plugin.command,
        args: plugin.args,
        cwd: plugin.cwd,
        url: plugin.url,
        allowTools: plugin.allowTools,
        denyTools: plugin.denyTools,
        startTimeoutMs: plugin.startTimeoutMs,
        callTimeoutMs: plugin.callTimeoutMs,
        quiet: plugin.quiet,
        source: plugin.source,
        installedAt: plugin.installedAt,
        updatedAt: plugin.updatedAt,
        envKeys: Object.keys(plugin.env),
        headerKeys: Object.keys(plugin.headers),
      };
      if (Object.keys(plugin.env).length || Object.keys(plugin.headers).length) {
        record.credentials = await this.box.seal({ env: plugin.env, headers: plugin.headers });
      }
      stored.push(record);
    }
    const payload: StoreFile = { version: 1, plugins: stored };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
  }

  list(): McpPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): McpPlugin | undefined {
    return this.plugins.get(id);
  }

  getLoadError(): string | null {
    return this.loadError;
  }

  async install(input: McpPluginInput): Promise<McpPlugin> {
    await this.ensureLoaded();
    const name = String(input.name ?? '').trim();
    if (!name) throw new McpPluginError('插件名称不能为空');
    if (name.length > 60) throw new McpPluginError('插件名称过长（≤60 字符）');
    const id = String(input.id ?? slugify(name)).trim();
    if (!PLUGIN_ID.test(id)) throw new McpPluginError(`插件 id 非法：「${id}」需匹配 ${PLUGIN_ID.source}`);
    if (this.plugins.has(id)) throw new McpPluginError(`插件已存在：${id}`);
    const command = input.command?.trim() || undefined;
    const url = input.url?.trim() || undefined;
    const transport = input.transport ?? (command ? 'stdio' : 'http');
    if (transport !== 'stdio' && transport !== 'http') throw new McpPluginError('transport 只支持 stdio / http');
    if (transport === 'stdio' && !command) throw new McpPluginError('stdio 插件缺少启动命令');
    if (transport === 'http' && !url) throw new McpPluginError('http 插件缺少地址');
    if (command && url) throw new McpPluginError('启动命令与地址只能二选一');
    const stamp = nowIso();
    const plugin: McpPlugin = {
      id,
      name,
      description: String(input.description ?? '').trim().slice(0, 400),
      enabled: input.enabled ?? true,
      transport,
      command,
      args: normalizeArray(input.args ?? []),
      cwd: input.cwd?.trim() || undefined,
      url,
      allowTools: normalizeArray(input.allowTools ?? ['*'], ['*']),
      denyTools: normalizeArray(input.denyTools ?? []),
      startTimeoutMs: positive(input.startTimeoutMs, MCP_DEFAULTS.startTimeoutMs, 'startTimeoutMs'),
      callTimeoutMs: positive(input.callTimeoutMs, MCP_DEFAULTS.callTimeoutMs, 'callTimeoutMs'),
      quiet: input.quiet ?? false,
      env: pruneSecrets(stringMap(input.env, 'env')),
      headers: pruneSecrets(stringMap(input.headers, 'headers')),
      source: input.source ?? 'user',
      installedAt: stamp,
      updatedAt: stamp,
    };
    this.plugins.set(id, plugin);
    await this.writeStore();
    return plugin;
  }

  async update(id: string, patch: McpPluginInput): Promise<McpPlugin> {
    await this.ensureLoaded();
    const existing = this.plugins.get(id);
    if (!existing) throw new McpPluginError(`插件不存在：${id}`);
    const command = patch.command === null ? undefined : patch.command?.trim() ?? existing.command;
    const url = patch.url === null ? undefined : patch.url?.trim() ?? existing.url;
    const transport = patch.transport ?? existing.transport;
    if (transport !== 'stdio' && transport !== 'http') throw new McpPluginError('transport 只支持 stdio / http');
    if (transport === 'stdio' && !command) throw new McpPluginError('stdio 插件缺少启动命令');
    if (transport === 'http' && !url) throw new McpPluginError('http 插件缺少地址');
    if (transport === 'stdio' && url) throw new McpPluginError('stdio 插件不能同时设置地址');
    const env = patch.clearCredentials ? {} : applySecretPatch(existing.env, patch.env);
    const headers = patch.clearCredentials ? {} : applySecretPatch(existing.headers, patch.headers);
    const next: McpPlugin = {
      ...existing,
      name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
      description: patch.description !== undefined ? String(patch.description).trim().slice(0, 400) : existing.description,
      enabled: patch.enabled ?? existing.enabled,
      transport,
      command,
      args: patch.args === null ? [] : patch.args ? normalizeArray(patch.args) : existing.args,
      cwd: patch.cwd === null ? undefined : patch.cwd?.trim() || existing.cwd,
      url: transport === 'stdio' ? undefined : url,
      allowTools: patch.allowTools === null ? ['*'] : patch.allowTools ? normalizeArray(patch.allowTools, ['*']) : existing.allowTools,
      denyTools: patch.denyTools === null ? [] : patch.denyTools ? normalizeArray(patch.denyTools) : existing.denyTools,
      startTimeoutMs: patch.startTimeoutMs === undefined ? existing.startTimeoutMs : positive(patch.startTimeoutMs, existing.startTimeoutMs, 'startTimeoutMs'),
      callTimeoutMs: patch.callTimeoutMs === undefined ? existing.callTimeoutMs : positive(patch.callTimeoutMs, existing.callTimeoutMs, 'callTimeoutMs'),
      quiet: patch.quiet ?? existing.quiet,
      env,
      headers,
      updatedAt: nowIso(),
    };
    delete next.credentialError;
    this.plugins.set(id, next);
    await this.writeStore();
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.plugins.delete(id)) throw new McpPluginError(`插件不存在：${id}`);
    await this.writeStore();
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpPlugin> {
    return await this.update(id, { enabled });
  }

  /** 从磁盘重新读取（手改 plugins.json 后热重载），保留当前实例。 */
  async reload(): Promise<void> {
    this.loaded = false;
    this.loadError = null;
    this.plugins.clear();
    await this.ensureLoaded();
  }

  /** 转成 McpConnection 的配置；只返回启用中的插件。 */
  serverConfigs(): McpServerConfig[] {
    return this.list()
      .filter((plugin) => plugin.enabled)
      .map((plugin) => this.serverConfigFor(plugin));
  }

  serverConfigFor(plugin: McpPlugin): McpServerConfig {
    return {
      id: plugin.id,
      enabled: true,
      transport: plugin.transport,
      command: plugin.command,
      args: plugin.args,
      env: plugin.env,
      cwd: plugin.cwd,
      url: plugin.url,
      headers: plugin.headers,
      startTimeoutMs: plugin.startTimeoutMs,
      callTimeoutMs: plugin.callTimeoutMs,
      allowTools: plugin.allowTools,
      denyTools: plugin.denyTools,
      quiet: plugin.quiet,
      description: plugin.description,
      ...(plugin.credentialError ? { configError: plugin.credentialError } : {}),
    };
  }

  public(): McpPluginPublic[] {
    return this.list().map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      enabled: plugin.enabled,
      transport: plugin.transport,
      command: plugin.command,
      args: plugin.args,
      cwd: plugin.cwd,
      url: plugin.url,
      allowTools: plugin.allowTools,
      denyTools: plugin.denyTools,
      startTimeoutMs: plugin.startTimeoutMs,
      callTimeoutMs: plugin.callTimeoutMs,
      quiet: plugin.quiet,
      source: plugin.source,
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
      envKeys: Object.keys(plugin.env),
      headerKeys: Object.keys(plugin.headers),
      hasCredentials: Boolean(Object.keys(plugin.env).length || Object.keys(plugin.headers).length),
      ...(plugin.credentialError ? { credentialError: plugin.credentialError } : {}),
    }));
  }
}
