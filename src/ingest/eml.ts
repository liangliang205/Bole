/** 最小 RFC822/MIME 解析器：支持 multipart、base64、quoted-printable、RFC2047 编码头。 */

export interface EmlAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmlMessage {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
  attachments: EmlAttachment[];
}

interface Part {
  headers: Record<string, string>;
  body: Buffer;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function decodeQuotedPrintable(input: string): Buffer {
  const cleaned = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '=') {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = ch.charCodeAt(0);
    bytes.push(code <= 0xff ? code : 0x3f);
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return Buffer.from(body, 'latin1');
}

function charsetDecode(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return new TextDecoder(charset.toLowerCase()).decode(Buffer.from(data, 'base64'));
      }
      const bytes: number[] = [];
      const qp = data.replace(/_/g, ' ');
      for (let i = 0; i < qp.length; i += 1) {
        if (qp[i] === '=') {
          bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(qp.charCodeAt(0));
        }
      }
      return new TextDecoder(charset.toLowerCase()).decode(Buffer.from(bytes));
    } catch {
      return value;
    }
  });
}

function boundaryOf(contentType: string): string | null {
  return /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1] ?? null;
}

function parsePart(raw: string): Part {
  const splitAt = raw.search(/\r?\n\r?\n/);
  if (splitAt < 0) {
    return { headers: {}, body: Buffer.from(raw, 'latin1') };
  }
  const headers = parseHeaders(raw.slice(0, splitAt));
  const bodyRaw = raw.slice(splitAt).replace(/^\r?\n\r?\n/, '');
  return { headers, body: decodeTransfer(bodyRaw, headers['content-transfer-encoding'] ?? '') };
}

function collectText(part: Part, out: string[]): void {
  const contentType = part.headers['content-type'] ?? 'text/plain';
  if (/^multipart\//i.test(contentType)) {
    const boundary = boundaryOf(contentType);
    if (!boundary) return;
    const raw = part.body.toString('latin1');
    const sections = raw.split(`--${boundary}`);
    for (const section of sections) {
      if (!section.includes(':')) continue;
      const child = parsePart(section.replace(/^\r?\n/, ''));
      collectText(child, out);
    }
    return;
  }
  if (/^text\//i.test(contentType)) {
    const disposition = part.headers['content-disposition'] ?? '';
    if (/attachment/i.test(disposition)) return;
    out.push(charsetDecode(part.body, contentType));
  }
}

function collectAttachments(part: Part, out: EmlAttachment[]): void {
  const contentType = part.headers['content-type'] ?? 'text/plain';
  if (/^multipart\//i.test(contentType)) {
    const boundary = boundaryOf(contentType);
    if (!boundary) return;
    const raw = part.body.toString('latin1');
    for (const section of raw.split(`--${boundary}`)) {
      if (!section.includes(':')) continue;
      collectAttachments(parsePart(section.replace(/^\r?\n/, '')), out);
    }
    return;
  }
  const disposition = part.headers['content-disposition'] ?? '';
  const filename =
    /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(disposition)?.[1] ??
    /name\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1];
  if (filename && (/attachment/i.test(disposition) || /^application\/|^image\//i.test(contentType))) {
    out.push({
      filename: decodeRfc2047(filename).trim(),
      contentType,
      content: part.body,
    });
  }
}

export function parseEml(raw: string): EmlMessage {
  const top = parsePart(raw);
  const subject = decodeRfc2047(top.headers['subject'] ?? '(无主题)');
  const from = decodeRfc2047(top.headers['from'] ?? '');
  const date = top.headers['date'] ?? '';
  const messageId = (top.headers['message-id'] ?? '').replace(/^<|>$/g, '') || `eml_${Buffer.from(subject).toString('hex').slice(0, 12)}`;
  const textParts: string[] = [];
  collectText(top, textParts);
  const attachments: EmlAttachment[] = [];
  collectAttachments(top, attachments);
  return {
    messageId,
    subject,
    from,
    date,
    bodyText: textParts.join('\n').trim(),
    attachments,
  };
}
