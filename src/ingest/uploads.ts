import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir, readJsonSafe } from '../util/fsx.ts';
import { newId } from '../util/ids.ts';
import type { UploadedFile } from '../types.ts';

const ALLOWED_EXT = new Set([
  'pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff',
]);

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

interface UploadMeta {
  uploadId: string;
  filename: string;
  storedName: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export function sanitizeFilename(input: string): string {
  // eslint-disable-next-line no-control-regex -- 文件名清洗必须覆盖 C0 控制字符，否则会写出不可见文件名
  const base = path.basename(String(input || 'resume')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  const safe = base.slice(0, 120) || 'resume';
  return safe;
}

export function detectContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function isSupportedUpload(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return ALLOWED_EXT.has(ext);
}

export async function saveUpload(
  input: { filename: string; contentBase64: string },
  uploadsDir: string,
): Promise<UploadedFile> {
  const filename = sanitizeFilename(input.filename);
  if (!isSupportedUpload(filename)) {
    throw new UploadError(`不支持的文件类型：${path.extname(filename) || filename}（支持 pdf/docx/txt/md/html/png/jpg/webp/gif/bmp/tiff）`);
  }
  const encoded = String(input.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!encoded) throw new UploadError('文件内容为空');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) throw new UploadError('文件内容为空或 base64 解码失败');
  if (buffer.length > 25 * 1024 * 1024) throw new UploadError('单个文件不能超过 25MB');

  const uploadId = newId('up');
  const dir = path.join(uploadsDir, uploadId);
  await ensureDir(dir);
  const storedName = filename;
  const filePath = path.join(dir, storedName);
  await writeFile(filePath, buffer);
  const meta: UploadMeta = {
    uploadId,
    filename,
    storedName,
    contentType: detectContentType(filename),
    size: buffer.length,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { uploadId, filename, path: filePath, size: buffer.length, contentType: meta.contentType };
}

export async function loadUpload(uploadId: string, uploadsDir: string): Promise<UploadedFile | null> {
  if (!/^up_[a-z0-9]+$/.test(uploadId)) return null;
  const dir = path.join(uploadsDir, uploadId);
  const meta = await readJsonSafe<UploadMeta>(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const filePath = path.join(dir, meta.storedName);
  try {
    const buffer = await readFile(filePath);
    return {
      uploadId,
      filename: meta.filename,
      path: filePath,
      size: buffer.length,
      contentType: meta.contentType,
    };
  } catch {
    return null;
  }
}

export async function listUploads(uploadIds: string[], uploadsDir: string): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const id of uploadIds) {
    const file = await loadUpload(id, uploadsDir);
    if (file) files.push(file);
  }
  return files;
}
