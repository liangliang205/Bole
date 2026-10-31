import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ensureDir } from '../util/fsx.ts';
import { newId } from '../util/ids.ts';
import { attachmentFingerprint, dedupKeyFromText } from '../ingest/dedup.ts';
import { normalizeDocument } from '../ingest/normalize.ts';
import { HireboxClient } from '../mcp/client.ts';
import type { FetchManifest, ResumeRow } from '../types.ts';
import type { AgentDeps } from './deps.ts';

export interface FetcherInput {
  inboxDir: string;
  mcpMode?: 'in-process' | 'stdio';
  client?: HireboxClient;
}

export interface FetcherResult {
  manifest: FetchManifest;
  resumes: ResumeRow[];
}

function safeExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.bin';
}

/**
 * 获取 Agent：全流程唯一简历入口。
 * 经 MCP 拉取 → 去重（附件 sha256 + 正文指纹）→ 格式归一 → 落盘 + 台账。
 */
export async function runFetcher(deps: AgentDeps, input: FetcherInput): Promise<FetcherResult> {
  const manifest: FetchManifest = { pulled: 0, duplicates: [], failed: [], resumes: [] };
  const created: ResumeRow[] = [];
  deps.events.emit(deps.jobId, 'fetcher', 'fetch.started', {
    inboxDir: input.inboxDir,
    mcpMode: input.mcpMode ?? 'in-process',
  });

  const client = input.client ?? (await HireboxClient.connect({
    inboxDir: input.inboxDir,
    mode: input.mcpMode ?? 'in-process',
  }));

  try {
    deps.events.emit(deps.jobId, 'fetcher', 'mcp.connected', { transport: client.transportKind });
    let messages;
    try {
      messages = await client.listInbox();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      manifest.failed.push({ messageId: '*', reason: `MCP inbox.list 失败：${reason}` });
      deps.events.emit(deps.jobId, 'fetcher', 'fetch.failed', { reason });
      return { manifest, resumes: created };
    }

    for (let i = 0; i < messages.length; i += 1) {
      const meta = messages[i];
      const label = `R${String(i + 1).padStart(2, '0')}`;
      const resumeId = newId('res');
      try {
        const message = await client.getMessage(meta.messageId);
        const attachment = message.attachments[0];
        let buffer: Buffer;
        let filename: string;
        if (attachment) {
          buffer = Buffer.from(attachment.contentBase64, 'base64');
          filename = attachment.filename;
        } else if (message.bodyText.trim().length >= 50) {
          buffer = Buffer.from(message.bodyText, 'utf8');
          filename = 'body.txt';
        } else {
          throw new Error('邮件无可用简历附件，正文也过短');
        }

        const normalized = normalizeDocument(buffer, filename, attachment?.contentType ?? '');
        const sha256 = attachmentFingerprint(buffer);
        const dedupKey = dedupKeyFromText(normalized.text);
        const existing = deps.ledger.findResumeByDedup(deps.jobId, dedupKey, sha256);

        if (existing) {
          const duplicate = deps.ledger.insertResume({
            id: resumeId,
            jobId: deps.jobId,
            label,
            sha256,
            dedupKey,
            sourceMsgId: meta.messageId,
            sourcePath: meta.file,
            rawPath: '',
            normPath: '',
            format: normalized.format,
            status: 'duplicate',
            reasons: [`重复投递：与 ${existing.label} 的正文指纹或附件哈希一致`],
          });
          manifest.duplicates.push(label);
          created.push(duplicate);
          deps.events.emit(deps.jobId, 'fetcher', 'resume.duplicate', {
            resumeId,
            label,
            duplicateOf: existing.label,
            sha256: sha256.slice(0, 12),
          });
          continue;
        }

        const rawPath = path.join(deps.runDir, 'resumes', 'raw', `${resumeId}${safeExt(filename)}`);
        const normPath = path.join(deps.runDir, 'resumes', 'norm', `${resumeId}.txt`);
        await ensureDir(path.dirname(rawPath));
        await ensureDir(path.dirname(normPath));
        await writeFile(rawPath, buffer);
        await writeFile(normPath, `${normalized.text}\n`, 'utf8');

        const resume = deps.ledger.insertResume({
          id: resumeId,
          jobId: deps.jobId,
          label,
          sha256,
          dedupKey,
          sourceMsgId: meta.messageId,
          sourcePath: meta.file,
          rawPath,
          normPath,
          format: normalized.format,
          status: 'queued',
          reasons: normalized.warnings,
        });
        created.push(resume);
        manifest.pulled += 1;
        manifest.resumes.push({ resumeId, label, format: normalized.format, path: normPath });
        deps.events.emit(deps.jobId, 'fetcher', 'resume.fetched', {
          resumeId,
          label,
          format: normalized.format,
          bytes: buffer.length,
          chars: normalized.text.length,
          warnings: normalized.warnings,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        manifest.failed.push({ messageId: meta.messageId, reason });
        const failedRow = deps.ledger.insertResume({
          id: resumeId,
          jobId: deps.jobId,
          label,
          sha256: '',
          dedupKey: '',
          sourceMsgId: meta.messageId,
          sourcePath: meta.file,
          rawPath: '',
          normPath: '',
          format: 'unknown',
          status: 'failed',
          reasons: [`简历接入失败：${reason}`],
        });
        created.push(failedRow);
        deps.events.emit(deps.jobId, 'fetcher', 'resume.fetch_failed', {
          resumeId,
          label,
          reason,
        });
      }
    }

    deps.events.emit(deps.jobId, 'fetcher', 'fetch.completed', {
      messages: messages.length,
      pulled: manifest.pulled,
      duplicates: manifest.duplicates.length,
      failed: manifest.failed.length,
    });
    return { manifest, resumes: created };
  } finally {
    await client.close();
  }
}
