import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { ocrImage } from './ocr.ts';

export interface NormalizedDoc {
  format: string;
  text: string;
  warnings: string[];
}

export interface NormalizeOptions {
  /** 自定义 OCR（模型/外部服务）；缺省使用本地 Tesseract。 */
  ocr?: (buffer: Buffer, filename: string, mimeType: string) => Promise<string>;
}

export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`不支持该格式：${format}`);
    this.name = 'UnsupportedFormatError';
  }
}

export class EmptyDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyDocumentError';
  }
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function imageMimeType(filename: string, contentType = ''): string {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return MIME_BY_EXT[ext] ?? (/^image\//i.test(contentType) ? contentType.split(';')[0] : 'image/png');
}

export function detectFormat(filename: string, contentType = ''): string {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (ext) {
    if (ext === 'htm') return 'html';
    if (ext === 'markdown') return 'md';
    if (IMAGE_EXT.has(ext)) return 'image';
    return ext;
  }
  if (/pdf/i.test(contentType)) return 'pdf';
  if (/wordprocessingml|docx/i.test(contentType)) return 'docx';
  if (/image\//i.test(contentType)) return 'image';
  if (/html/i.test(contentType)) return 'html';
  if (/text\//i.test(contentType)) return 'txt';
  return 'unknown';
}

function decodeText(buffer: Buffer): { text: string; encoding: string } {
  const utf8 = buffer.toString('utf8');
  const replacementRatio = (utf8.match(/\uFFFD/g) ?? []).length / Math.max(1, utf8.length);
  if (replacementRatio > 0.01) {
    try {
      const gbk = new TextDecoder('gbk').decode(buffer);
      if (!gbk.includes('\uFFFD')) return { text: gbk, encoding: 'gbk' };
    } catch {
      // 回退 utf-8
    }
  }
  return { text: utf8, encoding: 'utf-8' };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('无效的 ZIP 文件：找不到中央目录');
}

/** 读取 docx（ZIP）中的文件条目，支持 store 与 deflate。 */
export function unzip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!content) throw new Error(`不支持的 ZIP 压缩方法: ${method}`);
    files.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export function docxToText(buffer: Buffer): string {
  const files = unzip(buffer);
  const documentXml = files.get('word/document.xml');
  if (!documentXml) throw new Error('docx 缺少 word/document.xml');
  const xml = documentXml.toString('utf8');
  const text = xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/(?:w:p|w:tr)>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text);
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfDocument {
  numPages: number;
  getPage: (page: number) => Promise<{ getTextContent: () => Promise<{ items: PdfTextItem[] }>; cleanup: () => void }>;
  destroy: () => Promise<void>;
}

/** 使用 PDF.js 提取文本层。扫描件（无文本层）请上传图片走 OCR。 */
export async function pdfToText(buffer: Buffer): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> };
  };
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const pages: string[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join('');
      pages.push(pageText.trim());
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  const text = pages.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < 20) {
    throw new UnsupportedFormatError('pdf（无文本层，可能是扫描件；请上传图片走 OCR）');
  }
  return text;
}

export async function normalizeDocument(buffer: Buffer, filename: string, contentType = '', options: NormalizeOptions = {}): Promise<NormalizedDoc> {
  const format = detectFormat(filename, contentType);
  const warnings: string[] = [];
  let text = '';

  if (format === 'txt' || format === 'md') {
    const decoded = decodeText(buffer);
    text = decoded.text;
    if (decoded.encoding !== 'utf-8') warnings.push(`按 ${decoded.encoding} 解码`);
  } else if (format === 'html') {
    text = htmlToText(decodeText(buffer).text);
  } else if (format === 'docx') {
    text = docxToText(buffer);
  } else if (format === 'pdf') {
    text = await pdfToText(buffer);
    warnings.push('PDF 文本层提取；扫描件请上传图片走 OCR');
  } else if (format === 'image') {
    text = options.ocr
      ? await options.ocr(buffer, filename, imageMimeType(filename, contentType))
      : await ocrImage(buffer, filename);
    warnings.push('图片 OCR 提取，可能存在识别误差');
  } else if (format === 'doc') {
    throw new UnsupportedFormatError('doc（旧版 Word，请另存为 docx）');
  } else {
    const decoded = decodeText(buffer);
    const printable = (decoded.text.match(/[\u4e00-\u9fffA-Za-z0-9]/g) ?? []).length;
    if (decoded.text.length > 20 && printable / decoded.text.length > 0.6) {
      text = decoded.text;
      warnings.push(`未知格式按纯文本处理（${format}）`);
    } else {
      throw new UnsupportedFormatError(format);
    }
  }

  const cleaned = text
    // eslint-disable-next-line no-control-regex -- NUL 是 PDF/DOCX 文本层常见残留，必须主动剥掉
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (cleaned.length < 20) throw new EmptyDocumentError('内容为空或过短（OCR/文本层提取后 <20 字符）');
  return { format, text: cleaned, warnings };
}
