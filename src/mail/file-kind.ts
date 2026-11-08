/**
 * 按文件头判断邮件附件的真实类型，避免仅凭扩展名被改名文件绕过。
 * 支持招聘场景常见的五类：PDF、DOCX、DOC、图片、纯文本/HTML。
 * 纯文本没有魔数，用扩展名 + 可打印字符比例判断。
 */
import path from 'node:path';

export type MailFileKind = 'pdf' | 'docx' | 'doc' | 'image' | 'text';

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_MAGIC = Buffer.from('GIF8');
const BMP_MAGIC = Buffer.from('BM');
const TIFF_LE_MAGIC = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE_MAGIC = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'html', 'htm']);

function startsWith(content: Buffer, magic: Buffer): boolean {
  return content.subarray(0, magic.length).equals(magic);
}

/** 视觉模型需要的 MIME；识别不出来返回 null。 */
export function detectImageMime(content: Buffer): string | null {
  if (startsWith(content, PNG_MAGIC)) return 'image/png';
  if (startsWith(content, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(content, GIF_MAGIC)) return 'image/gif';
  if (startsWith(content, BMP_MAGIC)) return 'image/bmp';
  if (startsWith(content, TIFF_LE_MAGIC) || startsWith(content, TIFF_BE_MAGIC)) return 'image/tiff';
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decodeText(buffer: Buffer): string | null {
  const utf8 = buffer.toString('utf8');
  if ((utf8.match(/�/g) ?? []).length / Math.max(1, utf8.length) <= 0.01) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buffer);
    if (!gbk.includes('�')) return gbk;
  } catch {
    // 回退失败
  }
  return null;
}

function looksLikeText(content: Buffer): boolean {
  const text = decodeText(content);
  if (!text) return false;
  const printable = (text.match(/[一-鿿A-Za-z0-9]/g) ?? []).length;
  return text.length >= 20 && printable / text.length > 0.6;
}

export function detectFileKind(content: Buffer, filename: string): MailFileKind | null {
  if (startsWith(content, PDF_MAGIC)) return 'pdf';
  if (startsWith(content, ZIP_MAGIC)) {
    // docx 是 ZIP；用条目名区分普通压缩包
    const head = content.subarray(0, Math.min(content.length, 8192));
    return head.includes('word/') || head.includes('[Content_Types].xml') ? 'docx' : null;
  }
  if (startsWith(content, OLE_MAGIC)) return 'doc';
  if (detectImageMime(content)) return 'image';
  const ext = path.extname(filename).toLowerCase().slice(1);
  if (TEXT_EXTENSIONS.has(ext) && looksLikeText(content)) return 'text';
  return null;
}

export function kindMatchesExtension(kind: MailFileKind, filename: string): boolean {
  const ext = path.extname(filename).toLowerCase().slice(1);
  if (kind === 'pdf') return ext === 'pdf';
  if (kind === 'docx') return ext === 'docx';
  if (kind === 'doc') return ext === 'doc';
  if (kind === 'image') return IMAGE_EXTENSIONS.has(ext);
  return TEXT_EXTENSIONS.has(ext);
}
