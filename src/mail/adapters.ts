import { z } from 'zod';
import { execFile } from 'node:child_process';
import type { Ledger } from '../core/ledger.ts';
import { mailCommand, mailboxIdentity, type MailCommand } from './client.ts';

const operationSchema = z.object({ args: z.array(z.string()).max(100), resultPath: z.string().default('') }).strict();
export const mailAdapterSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).refine((id) => id !== 'agently-mail'),
  name: z.string().min(1).max(100), skillId: z.string().max(64).optional(),
  command: z.string().min(1).max(2000), baseArgs: z.array(z.string()).max(50).default([]),
  operations: z.object({ identity: operationSchema, search: operationSchema, read: operationSchema, download: operationSchema, send: operationSchema }).strict(),
  fields: z.object({ email: z.string(), items: z.string(), messageId: z.string(), nextCursor: z.string().optional(),
    sender: z.string(), attachments: z.string(), attachmentId: z.string(), filename: z.string(), size: z.string().optional(), savedPath: z.string() }).strict(),
}).strict();
export type MailAdapterDefinition = z.infer<typeof mailAdapterSchema>;
export const MAIL_ADAPTER_SCHEMA = 'CREATE TABLE IF NOT EXISTS mail_adapters (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL);';
export class MailAdapterStore {
  readonly ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  list(): MailAdapterDefinition[] { return this.ledger.db.prepare('SELECT definition_json FROM mail_adapters ORDER BY id').all().map((r) => mailAdapterSchema.parse(JSON.parse(String(r.definition_json)))); }
  save(input: unknown): MailAdapterDefinition {
    const value = mailAdapterSchema.parse(input);
    if (value.skillId && !this.ledger.db.prepare('SELECT 1 FROM skill_plugins WHERE id=?').get(value.skillId)) throw new Error('请先安装适配器关联的 Skill');
    this.ledger.db.prepare('INSERT INTO mail_adapters VALUES(?,?) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json').run(value.id, JSON.stringify(value));
    this.ledger.appendEvent(null, 'HR', 'mail.adapter.saved', { id: value.id });
    return value;
  }
}
export interface MailAdapter {
  identity(): Promise<string>;
  search(query: { query: string; after?: string }, cursor?: string): Promise<unknown>;
  read(messageId: string): Promise<unknown>;
  download(messageId: string, attachmentId: string, dir: string): Promise<unknown>;
  send(value: { to: string; subject: string; body: string }): Promise<unknown>;
}
export function agentlyAdapter(command: MailCommand = mailCommand): MailAdapter {
  return {
    identity: () => mailboxIdentity(command),
    search: (q, cursor) => command(['message', '+search', '--dir', 'inbox', '--has-attachments', '--limit', '50', ...(q.query ? ['--q', q.query] : []), ...(q.after ? ['--after', q.after] : []), ...(cursor ? ['--cursor', cursor] : [])]),
    read: (id) => command(['message', '+read', '--id', id]),
    download: (id, att, dir) => command(['attachment', '+download', '--msg', id, '--att', att, '--output', './'], dir),
    send: (v) => command(['message', '+send', '--to', v.to, '--subject', v.subject, '--body', v.body, '--body-format', 'plain', '--confirmed']),
  };
}
export type AdapterRunner = (command: string, args: string[], cwd?: string) => Promise<unknown>;
const run: AdapterRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    try {
      const value: unknown = JSON.parse(stdout);
      if (error || value && typeof value === 'object' && 'ok' in value && value.ok === false) { reject(new Error('邮箱适配器调用失败，请检查对应 CLI 的授权与接口配置；发信结果不确定时请人工核对，勿自动重发')); return; }
      resolve(value);
    } catch { reject(new Error('邮箱适配器未返回合法 JSON，请检查命令和返回字段映射')); }
  });
});
function field(value: unknown, key: string): unknown {
  if (!key) return value;
  return key.split('.').reduce<unknown>((current, part) => current && typeof current === 'object' && Object.hasOwn(current, part) ? (current as Record<string, unknown>)[part] : undefined, value);
}
/** CLI Skill adapter. Arguments are separate process arguments, never shell code. */
export function configuredAdapter(definition: MailAdapterDefinition, runner: AdapterRunner = run): MailAdapter {
  const d = mailAdapterSchema.parse(definition);
  const invoke = async (op: keyof typeof d.operations, input: Record<string, unknown>, cwd?: string) => {
    const replace = (s: string) => s.replace(/\{([a-zA-Z]+)\}/g, (_all, name: string) => name === 'input' ? JSON.stringify(input) : String(input[name] ?? ''));
    const value = await runner(d.command, [...d.baseArgs, ...d.operations[op].args.map(replace)], cwd);
    return field(value, d.operations[op].resultPath);
  };
  return {
    identity: async () => z.email().parse(field(await invoke('identity', {}), d.fields.email)),
    search: async (q, cursor) => {
      const value = await invoke('search', { query: q.query, after: q.after ?? '', cursor: cursor ?? '', limit: 50 });
      const next = field(value, d.fields.nextCursor ?? '');
      return { data: z.array(z.unknown()).parse(field(value, d.fields.items)).map((item) => ({ message_id: field(item, d.fields.messageId) })), pagination: { has_more: d.fields.nextCursor ? Boolean(next) : false, next_cursor: typeof next === 'string' ? next : null } };
    },
    read: async (id) => {
      const value = await invoke('read', { messageId: id });
      return { message_id: id, from: { email: field(value, d.fields.sender) }, attachments: z.array(z.unknown()).parse(field(value, d.fields.attachments)).map((a) => ({ attachment_id: field(a, d.fields.attachmentId), filename: field(a, d.fields.filename), ...(d.fields.size ? { size: field(a, d.fields.size) } : {}) })) };
    },
    download: async (id, att, dir) => ({ saved_to: field(await invoke('download', { messageId: id, attachmentId: att, outputDir: dir }, dir), d.fields.savedPath) }),
    send: async (value) => {
      const result = await invoke('send', { to: value.to, subject: value.subject, body: value.body });
      if (result === undefined || result === null || result === false) throw new Error('邮箱适配器未返回发送回执，请核对已发送邮件；系统不会自动重发');
      return result;
    },
  };
}
export function resolveMailAdapter(snapshot?: unknown, legacy?: MailCommand): MailAdapter {
  return snapshot ? configuredAdapter(mailAdapterSchema.parse(snapshot)) : agentlyAdapter(legacy);
}
