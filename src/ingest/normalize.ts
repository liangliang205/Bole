import { inflateRawSync, inflateSync } from 'node:zlib';
import path from 'node:path';

export interface NormalizedDoc {
  format: string;
  text: string;
  warnings: string[];
}

export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`P0 不支持该格式：${format}`);
    this.name = 'UnsupportedFormatError';
  }
}

export class EmptyDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyDocumentError';
  }
}

export function detectFormat(filename: string, contentType = ''): string {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (ext) {
    if (ext === 'htm') return 'html';
    if (['txt', 'md', 'html', 'docx', 'pdf', 'doc'].includes(ext)) return ext;
    return ext;
  }
  if (/pdf/i.test(contentType)) return 'pdf';
  if (/wordprocessingml|docx/i.test(contentType)) return 'docx';
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
      // 忽略：回退 utf-8
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
    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`不支持的 ZIP 压缩方法: ${method}`);
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

function pdfUnescape(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_m, ch: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[ch] ?? ch))
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** PDF 尽力而为提取：仅支持未加密、文本操作符可读的 PDF；中文 CID 字体可能失败（已写入已知限制）。 */
export function pdfToText(buffer: Buffer): string {
  const latin = buffer.toString('latin1');
  const chunks: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(latin)) !== null) {
    const raw = Buffer.from(match[1], 'latin1');
    let content = '';
    for (const inflater of [inflateSync, inflateRawSync]) {
      try {
        content = inflater(raw).toString('latin1');
        break;
      } catch {
        // 尝试下一种
      }
    }
    if (!content) content = match[1];
    const textRe = /\((?:\\.|[^\\()])*\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ/g;
    let t: RegExpExecArray | null;
    while ((t = textRe.exec(content)) !== null) {
      const token = t[0];
      if (token.endsWith('TJ')) {
        const inner = token.slice(1, token.lastIndexOf(']'));
        const parts = inner.match(/\((?:\\.|[^\\()])*\)/g) ?? [];
        chunks.push(parts.map((p) => pdfUnescape(p.slice(1, -1))).join(''));
      } else {
        const open = token.indexOf('(');
        const close = token.lastIndexOf(')');
        chunks.push(pdfUnescape(token.slice(open + 1, close)));
      }
    }
  }
  const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = (text.match(/[\u4e00-\u9fffA-Za-z0-9，。、；：（）()\s]/g) ?? []).length;
  if (text.length === 0 || printable / text.length < 0.6) {
    throw new UnsupportedFormatError('pdf（文本层不可提取，可能为扫描件或 CID 字体）');
  }
  return text;
}

export function normalizeDocument(buffer: Buffer, filename: string, contentType = ''): NormalizedDoc {
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
    text = pdfToText(buffer);
    warnings.push('PDF 文本层提取，复杂排版可能丢失分段');
  } else if (format === 'doc') {
    throw new UnsupportedFormatError('doc（P0 仅支持 docx，请另存为 docx）');
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
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (cleaned.length < 20) throw new EmptyDocumentError('附件内容为空或过短（<20 字符）');
  return { format, text: cleaned, warnings };
}
