import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir } from '../util/fsx.ts';
import { newId } from '../util/ids.ts';
import { attachmentFingerprint, dedupKeyFromText } from '../ingest/dedup.ts';
import { detectFormat, normalizeDocument } from '../ingest/normalize.ts';
import { closeOcr } from '../ingest/ocr.ts';
import type { FetchManifest, ResumeRow, UploadedFile } from '../types.ts';
import type { AgentDeps } from './deps.ts';

export interface FetcherInput {
  files: UploadedFile[];
}

export interface FetcherResult {
  manifest: FetchManifest;
  resumes: ResumeRow[];
}

/**
 * 接入 Agent：真实上传文件 → 去重 → 格式归一 → 落盘 + 台账。
 * 产品路径不再读取本地 mock 邮箱；简历来源只有用户上传。
 */
export async function runFetcher(deps: AgentDeps, input: FetcherInput): Promise<FetcherResult> {
  const manifest: FetchManifest = { pulled: 0, duplicates: [], failed: [], resumes: [] };
  const created: ResumeRow[] = [];
  let usedOcr = false;
  deps.events.emit(deps.jobId, 'fetcher', 'fetch.started', { files: input.files.length });

  for (let i = 0; i < input.files.length; i += 1) {
    const file = input.files[i];
    const label = `R${String(i + 1).padStart(2, '0')}`;
    const resumeId = newId('res');
    if (detectFormat(file.filename, file.contentType) === 'image') usedOcr = true;
    try {
      const buffer = await readFile(file.path);
      const normalized = await normalizeDocument(buffer, file.filename, file.contentType);
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
          sourceMsgId: file.uploadId,
          sourcePath: file.uploadId,
          rawPath: '',
          normPath: '',
          format: normalized.format,
          status: 'duplicate',
          reasons: [`重复投递：与 ${existing.label} 的正文指纹或文件哈希一致`],
        });
        manifest.duplicates.push(label);
        created.push(duplicate);
        deps.events.emit(deps.jobId, 'fetcher', 'resume.duplicate', {
          resumeId,
          label,
          duplicateOf: existing.label,
          filename: file.filename,
          sha256: sha256.slice(0, 12),
        });
        continue;
      }

      const rawPath = path.join(deps.runDir, 'resumes', 'raw', `${resumeId}${path.extname(file.filename).toLowerCase()}`);
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
        sourceMsgId: file.uploadId,
        sourcePath: file.uploadId,
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
        filename: file.filename,
        format: normalized.format,
        bytes: buffer.length,
        chars: normalized.text.length,
        warnings: normalized.warnings,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      manifest.failed.push({ messageId: file.uploadId, reason });
      const failedRow = deps.ledger.insertResume({
        id: resumeId,
        jobId: deps.jobId,
        label,
        sha256: '',
        dedupKey: '',
        sourceMsgId: file.uploadId,
        sourcePath: file.uploadId,
        rawPath: '',
        normPath: '',
        format: 'unknown',
        status: 'failed',
        reasons: [`简历接入失败（${file.filename}）：${reason}`],
      });
      created.push(failedRow);
      deps.events.emit(deps.jobId, 'fetcher', 'resume.fetch_failed', {
        resumeId,
        label,
        filename: file.filename,
        reason,
      });
    }
  }

  if (usedOcr) await closeOcr();
  deps.events.emit(deps.jobId, 'fetcher', 'fetch.completed', {
    files: input.files.length,
    pulled: manifest.pulled,
    duplicates: manifest.duplicates.length,
    failed: manifest.failed.length,
  });
  return { manifest, resumes: created };
}
