import path from 'node:path';
import { nodeExecution } from '../scheduler/context.ts';
import { isSuspension } from '../workflow/builders.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir } from '../util/fsx.ts';
import { newId } from '../util/ids.ts';
import { attachmentFingerprint, dedupKeyFromText } from '../ingest/dedup.ts';
import { detectFormat, normalizeDocument } from '../ingest/normalize.ts';
import { acquireOcr, ocrImage, releaseOcr } from '../ingest/ocr.ts';
import { supportsVision, visionOcr } from '../ingest/vision-ocr.ts';
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
 * 文件来自 HR 上传或招聘邮箱导入，共用归一化和证据链。
 */
export async function runFetcher(deps: AgentDeps, input: FetcherInput): Promise<FetcherResult> {
  const manifest: FetchManifest = { pulled: 0, duplicates: [], failed: [], resumes: [] };
  const created: ResumeRow[] = [];
  const labelOffset = deps.ledger.listResumes(deps.jobId).reduce((max, r) => Math.max(max, Number(r.label.match(/^R(\d+)$/)?.[1] ?? 0)), 0);
  const hasImage = input.files.some((file) => detectFormat(file.filename, file.contentType) === 'image');
  const ocrMode = (process.env.BOLE_OCR_MODE ?? 'deepseek').toLowerCase();
  const ocrFallback = process.env.BOLE_OCR_FALLBACK !== 'false';
  if (hasImage) acquireOcr();
  deps.events.emit(deps.jobId, 'fetcher', 'fetch.started', { files: input.files.length });

  for (let i = 0; i < input.files.length; i += 1) {
    const file = input.files[i];
    const label = `R${String(labelOffset + i + 1).padStart(2, '0')}`;
    const resumeId = newId('res');
    let ocrFallbackReason = '';
    const ocr = async (buffer: Buffer, filename: string, mimeType: string): Promise<string> => {
      if (ocrMode === 'url' && !process.env.BOLE_OCR_URL) {
        throw new Error('BOLE_OCR_MODE=url 但未配置 BOLE_OCR_URL');
      }
      if (ocrMode === 'local' || ocrMode === 'url') return ocrImage(buffer, filename);
      if (!supportsVision(mimeType)) {
        if (!ocrFallback) throw new Error(`DeepSeek Vision 不支持 ${mimeType}，且已关闭本地回退`);
        ocrFallbackReason = `DeepSeek Vision 不支持 ${mimeType}，已回退本地 OCR`;
        return ocrImage(buffer, filename);
      }
      try {
        return await visionOcr(deps, { buffer, filename, mimeType, label });
      } catch (error) {
        if (isSuspension(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        deps.events.emit(deps.jobId, 'fetcher', 'resume.ocr_failed', { label, filename, error: message });
        if (!ocrFallback) throw error;
        ocrFallbackReason = `DeepSeek Vision OCR 失败，已回退本地 Tesseract：${message}`;
        return ocrImage(buffer, filename);
      }
    };
    try {
      const buffer = await readFile(file.path);
      const normalized = await normalizeDocument(buffer, file.filename, file.contentType, { ocr });
      if (ocrFallbackReason) normalized.warnings.push(ocrFallbackReason);
      const sha256 = attachmentFingerprint(buffer);
      const dedupKey = dedupKeyFromText(normalized.text);
      const existing = deps.ledger.findResumeByDedup(deps.jobId, dedupKey, sha256);

      if (existing) {
        nodeExecution.getStore()?.assertOwner();
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

      nodeExecution.getStore()?.assertOwner();
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
      if (isSuspension(error)) throw error;
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

  if (hasImage) await releaseOcr();
  deps.events.emit(deps.jobId, 'fetcher', 'fetch.completed', {
    files: input.files.length,
    pulled: manifest.pulled,
    duplicates: manifest.duplicates.length,
    failed: manifest.failed.length,
  });
  return { manifest, resumes: created };
}
