/**
 * 读取并校验 config/mcp.json（可用 BOLE_MCP_CONFIG 指向别处）。
 *
 * 原则：
 * - 文件不存在 = 没有外接服务，属于正常状态，不报错；
 * - 顶层结构错误（不是合法 JSON、servers 不是对象）= 配置错误，显式抛出；
 * - 单个服务的错误（缺 command、密钥环境变量没设）= 记在该服务上，其它服务照常可用。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../util/fsx.ts';
import type { McpConfig, McpDefaults, McpServerConfig, McpTransport } from './types.ts';

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

export const MCP_DEFAULTS: McpDefaults = {
  startTimeoutMs: 20_000,
  callTimeoutMs: 60_000,
  maxToolsPerServer: 32,
  maxResultChars: 8_000,
};

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** `${ENV:NAME}` 或带默认值的 `${ENV:NAME:-fallback}`。 */
const ENV_REF = /\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function resolveMcpConfigPath(root = projectRoot()): string {
  const override = process.env.BOLE_MCP_CONFIG?.trim();
  return override ? path.resolve(override) : path.join(root, 'config', 'mcp.json');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringArray(value: unknown, field: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${field} 必须是字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      issues.push(`${field} 必须是字符串数组`);
      continue;
    }
    out.push(item);
  }
  return out;
}

function readStringMap(value: unknown, field: string, issues: string[], missing: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${field} 必须是字符串键值对`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') {
      issues.push(`${field}.${key} 必须是字符串`);
      continue;
    }
    out[key] = expandEnv(raw, missing);
  }
  return out;
}

function expandEnv(value: string, missing: string[]): string {
  return value.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const found = process.env[name];
    if (found !== undefined) return found;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
}

function positiveInt(value: unknown, fallback: number, field: string, issues: string[]): number {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    issues.push(`${field} 必须是正数`);
    return fallback;
  }
  return Math.floor(num);
}

function parseDefaults(raw: unknown): McpDefaults {
  if (raw === undefined) return { ...MCP_DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpConfigError('MCP 配置的 defaults 必须是对象');
  }
  const value = raw as Record<string, unknown>;
  const issues: string[] = [];
  const defaults: McpDefaults = {
    startTimeoutMs: positiveInt(value.startTimeoutMs, MCP_DEFAULTS.startTimeoutMs, 'defaults.startTimeoutMs', issues),
    callTimeoutMs: positiveInt(value.callTimeoutMs, MCP_DEFAULTS.callTimeoutMs, 'defaults.callTimeoutMs', issues),
    maxToolsPerServer: positiveInt(value.maxToolsPerServer, MCP_DEFAULTS.maxToolsPerServer, 'defaults.maxToolsPerServer', issues),
    maxResultChars: positiveInt(value.maxResultChars, MCP_DEFAULTS.maxResultChars, 'defaults.maxResultChars', issues),
  };
  if (issues.length) throw new McpConfigError(`MCP 配置 defaults 非法：${issues.join('；')}`);
  return defaults;
}

function parseServer(id: string, raw: unknown, defaults: McpDefaults): McpServerConfig {
  const issues: string[] = [];
  const missing: string[] = [];
  if (!SERVER_ID.test(id)) {
    issues.push(`服务 id「${id}」非法：需匹配 ${SERVER_ID.source}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      id,
      enabled: false,
      transport: 'stdio',
      args: [],
      env: {},
      headers: {},
      startTimeoutMs: defaults.startTimeoutMs,
      callTimeoutMs: defaults.callTimeoutMs,
      allowTools: ['*'],
      denyTools: [],
      quiet: false,
      description: '',
      configError: issues.concat('服务配置必须是对象').join('；'),
    };
  }
  const value = raw as Record<string, unknown>;
  const url = value.url === undefined ? undefined : expandEnv(String(value.url), missing);
  const commandRaw = asString(value.command);
  const command = commandRaw === undefined ? undefined : expandEnv(commandRaw, missing);
  const transportRaw = asString(value.transport)?.toLowerCase();
  let transport: McpTransport;
  if (transportRaw === 'stdio' || transportRaw === 'http') {
    transport = transportRaw;
  } else if (transportRaw !== undefined) {
    issues.push(`transport 只支持 stdio / http（收到 ${transportRaw}）`);
    transport = 'stdio';
  } else {
    transport = command ? 'stdio' : 'http';
  }
  if (command && url) issues.push('command 与 url 只能二选一（stdio 用 command，http 用 url）');
  if (transport === 'stdio' && !command) issues.push('stdio 服务缺少 command');
  if (transport === 'http' && !url) issues.push('http 服务缺少 url');

  const allowTools = readStringArray(value.allowTools, 'allowTools', issues);
  const denyTools = readStringArray(value.denyTools, 'denyTools', issues);
  const env = readStringMap(value.env, 'env', issues, missing);
  const headers = readStringMap(value.headers, 'headers', issues, missing);
  const cwd = value.cwd === undefined ? undefined : expandEnv(String(value.cwd), missing);
  const args = readStringArray(value.args, 'args', issues).map((arg) => expandEnv(arg, missing));

  if (missing.length) {
    issues.push(`环境变量未设置：${[...new Set(missing)].join(', ')}`);
  }

  return {
    id,
    enabled: value.enabled === undefined ? true : value.enabled !== false,
    transport,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    startTimeoutMs: positiveInt(value.startTimeoutMs, defaults.startTimeoutMs, 'startTimeoutMs', issues),
    callTimeoutMs: positiveInt(value.callTimeoutMs, defaults.callTimeoutMs, 'callTimeoutMs', issues),
    allowTools: allowTools.length ? allowTools : ['*'],
    denyTools,
    quiet: value.quiet === true,
    description: asString(value.description)?.trim() ?? '',
    ...(issues.length ? { configError: issues.join('；') } : {}),
  };
}

export function loadMcpConfig(root = projectRoot()): McpConfig {
  const file = resolveMcpConfigPath(root);
  if (!existsSync(file)) {
    return { version: 1, file: null, defaults: { ...MCP_DEFAULTS }, servers: [] };
  }
  let parsed: unknown;
  try {
    // Windows 记事本/PowerShell 可能写出 UTF-8 BOM，先剥掉再解析。
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch (error) {
    throw new McpConfigError(`MCP 配置不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigError(`MCP 配置必须是对象：${file}`);
  }
  const record = parsed as Record<string, unknown>;
  const defaults = parseDefaults(record.defaults);
  const serversRaw = record.servers;
  if (serversRaw === undefined) {
    return { version: Number(record.version ?? 1), file, defaults, servers: [] };
  }
  if (!serversRaw || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    throw new McpConfigError(`MCP 配置的 servers 必须是「服务 id → 配置」的对象：${file}`);
  }
  const servers = Object.entries(serversRaw as Record<string, unknown>).map(([id, value]) => parseServer(id, value, defaults));
  const seen = new Set<string>();
  for (const server of servers) {
    const key = server.id.toLowerCase();
    if (seen.has(key)) {
      throw new McpConfigError(`MCP 服务 id 重复（不区分大小写）：${server.id}`);
    }
    seen.add(key);
  }
  return { version: Number(record.version ?? 1), file, defaults, servers };
}

/** 用于在日志/状态里脱敏：env 与 headers 中看起来像凭据的值。 */
export function secretValues(servers: McpServerConfig[]): string[] {
  const values: string[] = [];
  const secretKey = /(key|secret|token|password|passwd|credential|authorization)/i;
  for (const server of servers) {
    for (const map of [server.env, server.headers]) {
      for (const [key, value] of Object.entries(map)) {
        if (value && value.length >= 4 && (secretKey.test(key) || /^Bearer\s/i.test(value))) values.push(value);
      }
    }
  }
  return values;
}
