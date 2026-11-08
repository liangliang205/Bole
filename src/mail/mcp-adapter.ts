import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { resolvePaths } from '../config.ts';
import { McpConnection } from '../mcp/client.ts';
import { mcpToolName } from '../mcp/schema.ts';
import type { McpServerConfig } from '../mcp/types.ts';
import { loadAccount } from './accounts.ts';
import type { MailAdapter, McpMailAdapterDefinition } from './adapters.ts';

/**
 * 把只读邮箱 MCP 服务包装成 MailAdapter。
 * 整个任务复用一条连接，close() 时关闭子进程。
 */
export function mcpMailAdapter(definition: McpMailAdapterDefinition): MailAdapter {
  const paths = resolvePaths();
  const cacheDir = path.join(paths.dataDir, 'mail-cache');
  let pending: Promise<McpConnection> | null = null;

  const connect = (): Promise<McpConnection> => {
    pending ??= (async () => {
      const account = await loadAccount(definition.accountRef);
      const config: McpServerConfig = {
        id: definition.id,
        enabled: true,
        transport: 'stdio',
        command: definition.command ?? process.execPath,
        args: definition.args.length
          ? definition.args
          : [path.join(paths.root, 'src', 'mail-mcp', 'index.ts')],
        env: {
          BOLE_MAIL_VENDOR: account.vendor,
          BOLE_MAIL_USER: account.user,
          BOLE_MAIL_PASSWORD: account.password,
          BOLE_MAIL_FOLDER: definition.folder,
          BOLE_MAIL_CACHE: cacheDir,
          ...(account.host ? { BOLE_MAIL_HOST: account.host } : {}),
          ...(account.port ? { BOLE_MAIL_PORT: String(account.port) } : {}),
        },
        headers: {},
        startTimeoutMs: 20_000,
        callTimeoutMs: definition.callTimeoutMs,
        allowTools: ['*'],
        denyTools: [],
        quiet: true,
        description: '',
      };
      const connection = new McpConnection(config, {
        maxToolsPerServer: 16,
        maxResultChars: 1_000_000,
        secrets: [account.password],
      });
      await connection.start();
      if (connection.getServerState() !== 'ready') {
        throw new Error(connection.getError() ?? `MCP 邮箱服务 ${definition.id} 启动失败`);
      }
      return connection;
    })();
    return pending;
  };

  const call = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const connection = await connect();
    const result = await connection.call(mcpToolName(definition.id, tool), JSON.stringify(args));
    if (!result.ok) throw new Error(result.message);
    return JSON.parse(result.message) as T;
  };

  return {
    identity: async () => (await call<{ email: string }>('identity', {})).email,
    search: (query, cursor) => call('search', { query: query.query, after: query.after, cursor }),
    read: (messageId) => call('read', { messageId }),
    download: async (messageId, attachmentId, dir) => {
      const file = await call<{ cachePath: string; filename: string }>('download', {
        messageId,
        attachmentId,
      });
      const root = path.resolve(cacheDir);
      const source = path.resolve(file.cachePath);
      const relative = path.relative(root, source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('MCP 邮箱服务返回了缓存目录之外的路径');
      }
      const target = path.join(dir, path.basename(file.filename));
      await copyFile(source, target);
      return { saved_to: path.basename(target) };
    },
    send: async () => {
      throw new Error('该邮箱是只读 MCP 适配器，不支持发送；请改用可发送的邮箱配置');
    },
    close: async () => {
      const current = pending;
      pending = null;
      if (!current) return;
      const connection = await current.catch(() => null);
      if (connection) await connection.close();
    },
  };
}