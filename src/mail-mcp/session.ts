import { stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';
import { ensureDir } from '../util/fsx.ts';
import {
  attachmentName,
  decodeId,
  encodeId,
  isResumeCandidate,
  leaves,
} from './structure.ts';

export interface SessionConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
  /** 163/126 需要 IMAP ID 命令 */
  sendId: boolean;
  /** 附件下载的本地缓存目录，由服务端决定，不接受调用方传入 */
  cacheDir: string;
}

export interface SearchPage {
  data: Array<{ message_id: string }>;
  pagination: { has_more: boolean; next_cursor: string | null };
}

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  size: number;
}

/**
 * 只读 IMAP 会话：
 * - 进程内只保留一条连接，所有操作串行，避免反复登录被服务器限流；
 * - 每次操作都用 readOnly 锁打开邮箱（EXAMINE），不会标记已读；
 * - 不暴露任何写方法。
 */
export class ImapSession {
  private readonly config: SessionConfig;
  private client: ImapFlow | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: SessionConfig) {
    this.config = config;
  }

  private run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const client = await this.ensureClient();
      const lock = await client.getMailboxLock(this.config.folder, { readOnly: true });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // 旧连接已经断了，忽略
      }
      this.client = null;
    }
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
      disableAutoIdle: true,
      ...(this.config.sendId
        ? { clientInfo: { name: 'Bole', version: '0.1.0', vendor: 'bole' } }
        : {}),
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async identity(): Promise<string> {
    return this.config.user;
  }

  async search(options: {
    after?: string;
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<SearchPage> {
    return this.run(async (client) => {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error('邮箱未打开，无法搜索');
      const uidValidity = mailbox.uidValidity;

      const criteria: { since?: Date } = {};
      if (options.after) criteria.since = new Date(options.after);

      const found = await client.search(criteria, { uid: true });
      if (found === false) throw new Error('邮箱服务器拒绝了搜索条件');
      if (found === undefined) throw new Error('邮箱未打开，无法搜索');

      let uids = found;
      if (options.cursor) {
        const cursorUid = decodeId(options.cursor).uid;
        uids = uids.filter((uid) => uid < cursorUid);
      }
      // 招聘场景优先看最近投递：UID 降序，最新邮件排在最前
      uids = [...uids].sort((a, b) => b - a);

      const page = uids.slice(0, options.limit);
      if (!page.length) return { data: [], pagination: { has_more: false, next_cursor: null } };

      const messages = await client.fetchAll(
        page,
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      );

      const keyword = options.query?.trim().toLowerCase() ?? '';
      const data: Array<{ message_id: string }> = [];
      for (const message of messages) {
        const subject = message.envelope?.subject ?? '';
        const from = message.envelope?.from?.[0]?.address ?? '';
        if (keyword) {
          const hit = subject.toLowerCase().includes(keyword) || from.toLowerCase().includes(keyword);
          if (!hit) continue;
        }
        const attachments = leaves(message.bodyStructure).filter(isResumeCandidate);
        if (!attachments.length) continue;
        data.push({ message_id: encodeId(uidValidity, message.uid) });
      }

      const last = page[page.length - 1];
      const hasMore = uids.length > page.length;
      return {
        data,
        pagination: {
          has_more: hasMore,
          next_cursor: hasMore ? encodeId(uidValidity, last) : null,
        },
      };
    });
  }

  async read(
    messageId: string,
  ): Promise<{ message_id: string; from: { email: string }; subject: string; attachments: AttachmentInfo[] }> {
    return this.run(async (client) => {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error('邮箱未打开，无法读取');
      const { uidValidity, uid } = decodeId(messageId);
      if (uidValidity !== mailbox.uidValidity.toString()) {
        throw new Error('邮箱 UIDVALIDITY 已变化，请重新搜索');
      }

      const message = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      );
      if (!message) throw new Error(`邮件不存在：${messageId}`);

      const attachments = leaves(message.bodyStructure)
        .filter(isResumeCandidate)
        .map((node) => ({
          attachmentId: String(node.part),
          filename: attachmentName(node),
          size: node.size ?? 0,
        }));

      return {
        message_id: messageId,
        from: { email: message.envelope?.from?.[0]?.address ?? '' },
        subject: message.envelope?.subject ?? '',
        attachments,
      };
    });
  }

  async download(
    messageId: string,
    attachmentId: string,
  ): Promise<{ cachePath: string; filename: string; bytes: number }> {
    return this.run(async (client) => {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error('邮箱未打开，无法下载');
      const { uidValidity, uid } = decodeId(messageId);
      if (uidValidity !== mailbox.uidValidity.toString()) {
        throw new Error('邮箱 UIDVALIDITY 已变化，请重新搜索');
      }

      const message = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!message) throw new Error(`邮件不存在：${messageId}`);

      const node = leaves(message.bodyStructure).find(
        (item) => String(item.part) === attachmentId && isResumeCandidate(item),
      );
      if (!node) throw new Error(`附件不存在或格式不支持：${attachmentId}`);

      await ensureDir(this.config.cacheDir);
      const safeName =
        path
          .basename(attachmentName(node))
          .replace(/[\\/:*?"<>|]/g, '_')
          .slice(0, 120) || `${uid}-${attachmentId}`;
      const cachePath = path.join(this.config.cacheDir, `${uid}-${attachmentId}-${safeName}`);

      const result = await client.download(String(uid), attachmentId, { uid: true });
      if (!result.content) throw new Error(`附件下载失败：${safeName}`);
      await pipeline(result.content, createWriteStream(cachePath));

      return { cachePath, filename: safeName, bytes: (await stat(cachePath)).size };
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}