import path from 'node:path';
import { mkdir, realpath, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mailCommand, type MailCommand } from './client.ts';
import { saveUpload, isSupportedUpload } from '../ingest/uploads.ts';
import type { AgentDeps } from '../agents/deps.ts';
import type { UploadedFile } from '../types.ts';
import type { Ledger } from '../core/ledger.ts';
import { ApprovalStore } from '../core/approvals.ts';
import { MailAdapterStore, mailAdapterSchema, resolveMailAdapter } from './adapters.ts';

export const MAIL_SCHEMA = `CREATE TABLE IF NOT EXISTS recruitment_mail_sources (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, upload_id TEXT NOT NULL,
 message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, sender_email TEXT NOT NULL,
 mailbox TEXT NOT NULL, filename TEXT NOT NULL, PRIMARY KEY(job_id,upload_id),
 UNIQUE(job_id,mailbox,message_id,attachment_id)
);`;
export const mailboxQuerySchema = z.object({
  providerId: z.string().max(64).optional(),
  adapter: z.json().optional(),
  query: z.string().trim().max(300).default(''),
  after: z.iso.datetime({ offset: true }).optional(),
  maxMessages: z.number().int().min(1).max(200).default(50),
}).strict();
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>;
export function freezeMailboxQuery(query: MailboxQuery, ledger: Ledger): MailboxQuery {
  if (!query.providerId || query.providerId === 'agently-mail') { const { adapter: _adapter, ...value } = query; return value; }
  const definition = new MailAdapterStore(ledger).list().find((a) => a.id === query.providerId);
  if (!definition) throw new Error('邮箱适配器不存在，请先在招聘邮箱面板配置');
  if (definition.skillId) {
    const skill = ledger.db.prepare('SELECT definition_json FROM skill_plugins WHERE id=?').get(definition.skillId);
    if (!skill || !JSON.parse(String(skill.definition_json)).enabled) throw new Error('邮箱适配器关联的 Skill 尚未启用');
  }
  return { ...query, adapter: mailAdapterSchema.parse(definition) };
}
const pageSchema = z.object({ data: z.array(z.object({ message_id: z.string().min(1).max(512) })), pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable().optional() }).optional() });
const messageSchema = z.object({ message_id: z.string(), from: z.object({ email: z.email() }), attachments: z.array(z.object({ attachment_id: z.string().min(1).max(512).optional(), filename: z.string(), size: z.coerce.number().nonnegative().optional() })) });

/** Bounded inbox import. Search filters survive pagination; no mark-read, deletion or URL fetching. */
export async function collectMailbox(deps: AgentDeps, query: MailboxQuery, command: MailCommand = mailCommand): Promise<UploadedFile[]> {
  const adapter = resolveMailAdapter(query.adapter, command);
  const mailbox = await adapter.identity();
  const files: UploadedFile[] = [];
  let cursor: string | undefined;
  let count = 0;
  const cursors = new Set<string>();
  deps.events.emit(deps.jobId, 'fetcher', 'mail.import.started', { mailbox, ...query });
  do {
    const page = pageSchema.parse(await adapter.search(query, cursor));
    for (const summary of page.data) {
      if (count++ >= query.maxMessages) break;
      const message = messageSchema.parse(await adapter.read(summary.message_id));
      if (message.message_id !== summary.message_id) throw new Error('邮箱消息 ID 不一致');
      for (const attachment of message.attachments) {
        if (!isSupportedUpload(attachment.filename) || !attachment.attachment_id || (attachment.size ?? 0) > 25 * 1024 * 1024) {
          deps.events.emit(deps.jobId, 'fetcher', 'mail.attachment.skipped', { messageId: message.message_id, filename: attachment.filename, reason: '不支持的格式、超大附件或无普通附件 ID' });
          continue;
        }
        const old = deps.ledger.db.prepare('SELECT upload_id FROM recruitment_mail_sources WHERE job_id=? AND mailbox=? AND message_id=? AND attachment_id=?').get(deps.jobId, mailbox, message.message_id, attachment.attachment_id);
        if (old) continue;
        const dir = path.join(deps.runDir, 'mail-downloads', randomUUID());
        await mkdir(dir, { recursive: true });
        try {
          const downloaded = z.object({ saved_to: z.string() }).parse(await adapter.download(message.message_id, attachment.attachment_id, dir));
          const saved = await realpath(path.resolve(dir, downloaded.saved_to));
          const root = await realpath(dir);
          const relative = path.relative(root, saved);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('下载附件路径越界');
          if ((await stat(saved)).size > 25 * 1024 * 1024) throw new Error('附件超过 25MB');
          const file = await saveUpload({ filename: attachment.filename, contentBase64: (await readFile(saved)).toString('base64') }, deps.paths.uploadsDir);
          deps.ledger.db.prepare('INSERT INTO recruitment_mail_sources(job_id,upload_id,message_id,attachment_id,sender_email,mailbox,filename,adapter_json) VALUES(?,?,?,?,?,?,?,?)').run(deps.jobId, file.uploadId, message.message_id, attachment.attachment_id, message.from.email, mailbox, file.filename, query.adapter ? JSON.stringify(query.adapter) : null);
          files.push(file);
          deps.events.emit(deps.jobId, 'fetcher', 'mail.attachment.imported', { messageId: message.message_id, uploadId: file.uploadId, filename: file.filename });
        } catch (error) {
          deps.events.emit(deps.jobId, 'fetcher', 'mail.attachment.failed', { messageId: message.message_id, filename: attachment.filename, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    cursor = page.pagination?.has_more ? page.pagination.next_cursor ?? undefined : undefined;
    if (cursor && cursors.has(cursor)) throw new Error('邮箱返回重复分页游标');
    if (cursor) cursors.add(cursor);
  } while (cursor && count < query.maxMessages);
  deps.events.emit(deps.jobId, 'fetcher', 'mail.import.completed', { messages: Math.min(count, query.maxMessages), imported: files.length, capped: !!cursor && count >= query.maxMessages });
  return files;
}

const draftSchema = z.object({ candidate: z.string().min(1), subject: z.string().trim().min(1).max(1000), body: z.string().trim().min(1).max(30000) }).strict();
const approvalSchema = draftSchema.extend({ resumeId: z.string(), to: z.email(), mailbox: z.email(), messageId: z.string(), adapter: z.json().optional() });

/** Only resolves recipients from imported source mail, never model-supplied addresses. */
export function prepareCandidateEmail(ledger: Ledger, jobId: string, args: unknown): string {
  const draft = draftSchema.parse(args);
  if (ledger.getJob(jobId)?.status !== 'completed') throw new Error('请先完成筛选，再由 HR 选定候选人联系');
  const candidate = ledger.listResumes(jobId).find((r) => r.id === draft.candidate || r.label === draft.candidate);
  if (!candidate || ['failed', 'duplicate'].includes(candidate.status)) throw new Error('候选人不存在或未完成有效筛选');
  const source = ledger.db.prepare('SELECT * FROM recruitment_mail_sources WHERE job_id=? AND upload_id=?').get(jobId, candidate.source_msg_id ?? '');
  if (!source) throw new Error('该候选人没有招聘邮箱来源，不能推测收件地址');
  const payload = approvalSchema.parse({ ...draft, candidate: candidate.label, resumeId: candidate.id, to: source.sender_email, mailbox: source.mailbox, messageId: source.message_id, ...(source.adapter_json ? { adapter: JSON.parse(String(source.adapter_json)) } : {}) });
  const approval = new ApprovalStore(ledger).request(jobId, 'recruitment-mail', payload, randomUUID());
  return `候选人 ${candidate.label} 的邮件已准备，等待 HR 审阅并批准；尚未发送。审批 ID：${approval.id}`;
}

export async function sendApprovedCandidateEmail(ledger: Ledger, jobId: string, approvalId: string, command: MailCommand = mailCommand): Promise<void> {
  const store = new ApprovalStore(ledger);
  const approval = store.get(approvalId, jobId);
  if (!approval || approval.kind !== 'recruitment-mail') throw new Error('招聘邮件审批不存在');
  const payload = approvalSchema.parse(JSON.parse(approval.payload_json));
  if (!store.claim(approvalId, jobId)) throw new Error('邮件未获批准或已执行，不会重复发送');
  try {
    const adapter = resolveMailAdapter(payload.adapter, command);
    if (await adapter.identity() !== payload.mailbox) throw new Error('当前邮箱与简历来源邮箱不一致，请切回原邮箱');
    // --confirmed is used only AFTER HR approves the exact persisted recipient and content.
    const result = await adapter.send(payload);
    store.finish(approvalId, jobId, true, result);
    ledger.appendChat(jobId, 'assistant', `已向 ${payload.candidate}（${payload.to}）发送邮件：${payload.subject}`);
  } catch (error) {
    store.finish(approvalId, jobId, false, { error: String(error), uncertain: true });
    ledger.appendChat(jobId, 'assistant', '招聘邮件未确认发送成功。请核对已发送邮箱后再决定是否重新发起；系统不会自动重发。');
    throw error;
  }
}
