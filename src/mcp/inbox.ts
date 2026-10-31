import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseEml } from '../ingest/eml.ts';

export interface InboxMessageMeta {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  attachments: { filename: string; contentType: string; size: number }[];
  file: string;
}

export interface InboxMessageDetail {
  messageId: string;
  subject: string;
  from: string;
  bodyText: string;
  attachments: { filename: string; contentType: string; contentBase64: string }[];
}

/** mock 邮箱：inbox 目录下每封 .eml 即一封邮件。P1 替换为 IMAP MCP，接口不变。 */
export class InboxStore {
  readonly inboxDir: string;
  private cache: Map<string, InboxMessageMeta> | null = null;

  constructor(inboxDir: string) {
    this.inboxDir = inboxDir;
  }

  private load(): Map<string, InboxMessageMeta> {
    if (this.cache) return this.cache;
    const messages = new Map<string, InboxMessageMeta>();
    if (!existsSync(this.inboxDir)) {
      this.cache = messages;
      return messages;
    }
    const files = readdirSync(this.inboxDir)
      .filter((name) => name.toLowerCase().endsWith('.eml'))
      .sort();
    for (const file of files) {
      const full = path.join(this.inboxDir, file);
      try {
        const message = parseEml(readFileSync(full, 'latin1'));
        let messageId = message.messageId;
        if (messages.has(messageId)) messageId = `${messageId}-${file.replace(/\W/g, '')}`;
        messages.set(messageId, {
          messageId,
          subject: message.subject,
          from: message.from,
          date: message.date,
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.content.length,
          })),
          file: full,
        });
      } catch {
        // 单封邮件损坏时跳过，由上层计数
      }
    }
    this.cache = messages;
    return messages;
  }

  list(): InboxMessageMeta[] {
    return [...this.load().values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  get(messageId: string): InboxMessageDetail {
    const meta = this.load().get(messageId);
    if (!meta) throw new Error(`邮件不存在: ${messageId}`);
    const message = parseEml(readFileSync(meta.file, 'latin1'));
    return {
      messageId: meta.messageId,
      subject: message.subject,
      from: message.from,
      bodyText: message.bodyText,
      attachments: message.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentBase64: a.content.toString('base64'),
      })),
    };
  }
}
