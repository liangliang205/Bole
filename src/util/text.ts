import type { RawSpan, Span } from '../types.ts';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_GLOBAL_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD_RE = /[a-zA-Z0-9_+#.]+/g;

/** 粗略 token 估算：CJK 约 0.7 token/字，拉丁按词。仅用于离线成本报表，误差在文档中声明。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_GLOBAL_RE) ?? []).length;
  const latinWords = (text.replace(CJK_GLOBAL_RE, ' ').match(LATIN_WORD_RE) ?? []).length;
  const other = Math.max(0, text.length - cjk) / 8;
  return Math.max(1, Math.ceil(cjk * 0.7 + latinWords * 1.3 + other));
}

export function countCjk(text: string): number {
  return (text.match(CJK_GLOBAL_RE) ?? []).length;
}

/** 归一化：统一换行、去行尾空白、压缩多余空行。归一化后的文本才写入 norm 文件并用于计算 span。 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Located {
  start: number;
  end: number;
}

const PUNCT_CANON: Record<string, string> = {
  '：': ':', '，': ',', '。': '.', '；': ';', '、': ',', '（': '(', '）': ')',
  '“': '"', '”': '"', '‘': "'", '’': "'", '！': '!', '？': '?', '—': '-', '－': '-',
  '\u3000': ' ',
};

function canonicalChar(ch: string): string {
  return PUNCT_CANON[ch] ?? ch;
}

/** 连续片段的定位：精确 → trim → 去空白/全半角标点归一化映射。 */
function locateContiguous(text: string, quote: string): Located | null {
  const direct = text.indexOf(quote);
  if (direct >= 0) return { start: direct, end: direct + quote.length };

  const trimmed = quote.trim();
  if (trimmed && trimmed !== quote) {
    const t = text.indexOf(trimmed);
    if (t >= 0) return { start: t, end: t + trimmed.length };
  }

  // 去空白 + 全半角标点归一化后定位
  const compactChars: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!/\s/.test(ch)) {
      compactChars.push(canonicalChar(ch));
      positions.push(i);
    }
  }
  const compactText = compactChars.join('');
  const compactQuote = Array.from(quote)
    .filter((ch) => !/\s/.test(ch))
    .map(canonicalChar)
    .join('');
  const idx = compactText.indexOf(compactQuote);
  if (idx >= 0 && compactQuote.length > 0) {
    return { start: positions[idx], end: positions[idx + compactQuote.length - 1] + 1 };
  }
  return null;
}

/** 宽松定位：先连续匹配；失败再尝试 LLM 常用的省略号拼接片段。 */
export function locateQuote(text: string, quote: string): Located | null {
  if (!quote) return null;
  const direct = locateContiguous(text, quote);
  if (direct) return direct;

  if (!/(?:…|\.\.\.|⋯)/.test(quote)) return null;
  const fragments = quote
    .split(/(?:…|\.\.\.|⋯)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s !== quote);
  for (const fragment of fragments) {
    const located = locateContiguous(text, fragment);
    if (located) return located;
  }
  return null;
}

export interface ResolvedSpans {
  spans: Span[];
  errors: string[];
}

/** 把模型给出的 quote 解析为带字符偏移的 span；任何一条无法定位都视为失效（触发同轮重试）。 */
export function resolveRawSpans(
  text: string,
  raws: RawSpan[],
  fallbackField: string,
): ResolvedSpans {
  const spans: Span[] = [];
  const errors: string[] = [];
  for (const raw of raws ?? []) {
    const quote = typeof raw?.quote === 'string' ? raw.quote.trim() : '';
    if (!quote) {
      errors.push(`空引用（field=${raw?.field ?? fallbackField}）`);
      continue;
    }
    const located = locateQuote(text, quote);
    if (!located) {
      errors.push(`引用无法在原文定位：「${truncate(quote, 40)}」`);
      continue;
    }
    spans.push({
      field: typeof raw.field === 'string' && raw.field ? raw.field : fallbackField,
      quote,
      charStart: located.start,
      charEnd: located.end,
    });
  }
  return { spans, errors };
}

/** 校验已有 span 是否仍可在原文定位（核查用）。 */
export function verifySpan(text: string, span: Span): { ok: boolean; reason: string } {
  if (span.charStart < 0 || span.charEnd > text.length || span.charEnd <= span.charStart) {
    return { ok: false, reason: '字符区间越界' };
  }
  const slice = text.slice(span.charStart, span.charEnd);
  if (slice === span.quote) return { ok: true, reason: '偏移与引用一致' };
  const located = locateQuote(text, span.quote);
  if (!located) return { ok: false, reason: '引文在原文中不存在' };
  if (located.start !== span.charStart || located.end !== span.charEnd) {
    return { ok: true, reason: `偏移可修正（应为 ${located.start}-${located.end}）` };
  }
  return { ok: true, reason: '偏移与引用一致' };
}

const PHONE_RE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const PHONE_DASH_RE = /(?<!\d)1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ID_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const NAME_LINE_RE = /(姓名[:：]\s*)([\u4e00-\u9fa5·]{2,6})/g;

/** 报告/日志脱敏：手机号、邮箱、身份证号、姓名。原文文件仍保存在受控目录，台账不存明文。 */
export function maskPII(text: string): string {
  return text
    .replace(EMAIL_RE, (m) => `${m.slice(0, 2)}***@***`)
    .replace(PHONE_RE, (m) => m.replace(/\d(?=\d{4})/g, '*'))
    .replace(PHONE_DASH_RE, (m) => m.replace(/\d(?=\d{4})/g, '*'))
    .replace(ID_RE, (m) => `${m.slice(0, 4)}**********${m.slice(-2)}`)
    .replace(NAME_LINE_RE, (_m, prefix: string, name: string) => `${prefix}${name[0]}**`);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '为', '对', '等', '中', '上', '下',
  'the', 'and', 'or', 'of', 'to', 'in', 'a', 'an', 'for', 'with', 'on', 'is', 'are', 'be',
]);

/** 中英混合分词：CJK 单字+双字，拉丁词小写。用于 RAG 检索与语义支持度的启发式判断。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const latin = lower.match(LATIN_WORD_RE) ?? [];
  for (const word of latin) {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word);
  }
  const cjkRuns = lower.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      if (!STOPWORDS.has(ch)) tokens.push(ch);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
