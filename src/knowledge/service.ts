import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId } from '../util/ids.ts';
import { normalizeDocument } from '../ingest/normalize.ts';
import { tokenize } from '../util/text.ts';

export type EmbeddingProvider = 'none' | 'ollama' | 'openai';

export interface KnowledgeSettings {
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  rerankModel: string;
  rerankBaseUrl: string;
  rerankApiKey: string;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
  autoRecall: boolean;
  maxContextChars: number;
  smartChunk: boolean;
}

export interface PublicKnowledgeSettings extends Omit<KnowledgeSettings, 'embeddingApiKey' | 'rerankApiKey'> {
  hasEmbeddingKey: boolean;
  hasRerankKey: boolean;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  documentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  baseId: string;
  title: string;
  filename: string;
  format: string;
  chars: number;
  status: string;
  warning: string;
  createdAt: string;
}

export interface KnowledgeHit {
  baseId: string;
  baseName: string;
  documentId: string;
  title: string;
  heading: string;
  text: string;
  score: number;
}

interface ChunkRow extends Record<string, unknown> {
  id: string;
  doc_id: string;
  base_id: string;
  title: string;
  base_name: string;
  heading: string;
  text: string;
  embedding_json: string | null;
  embed_model: string | null;
}

interface ChunkDraft {
  heading: string;
  text: string;
}

const DEFAULT_SETTINGS: KnowledgeSettings = {
  embeddingProvider: 'none',
  embeddingModel: '',
  embeddingBaseUrl: 'http://127.0.0.1:11434',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  topK: 4,
  chunkSize: 800,
  chunkOverlap: 100,
  autoRecall: true,
  maxContextChars: 4000,
  smartChunk: true,
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_provider TEXT NOT NULL DEFAULT 'none',
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
  embedding_api_key TEXT NOT NULL DEFAULT '',
  rerank_model TEXT NOT NULL DEFAULT '',
  rerank_base_url TEXT NOT NULL DEFAULT '',
  rerank_api_key TEXT NOT NULL DEFAULT '',
  top_k INTEGER NOT NULL DEFAULT 4,
  chunk_size INTEGER NOT NULL DEFAULT 800,
  chunk_overlap INTEGER NOT NULL DEFAULT 100,
  auto_recall INTEGER NOT NULL DEFAULT 1,
  max_context_chars INTEGER NOT NULL DEFAULT 4000,
  smart_chunk INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  base_id TEXT NOT NULL,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  warning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_documents_base ON knowledge_documents(base_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  base_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  embedding_json TEXT,
  embed_model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_base ON knowledge_chunks(base_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_doc ON knowledge_chunks(doc_id);
`;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('地址必须以 http:// 或 https:// 开头');
  return trimmed;
}

function normalizeProvider(value: string): EmbeddingProvider {
  return value === 'ollama' || value === 'openai' ? value : 'none';
}

function chunkHeading(line: string): string | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
  return match ? match[2].trim() : null;
}

/** 按 Markdown 标题/自然段切块；超长段落按字符窗口再切，并保留重叠。 */
export function chunkKnowledgeText(raw: string, settings: Pick<KnowledgeSettings, 'chunkSize' | 'chunkOverlap' | 'smartChunk'>): ChunkDraft[] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];
  const target = clamp(Math.trunc(settings.chunkSize), 120, 8000);
  const overlap = clamp(Math.trunc(settings.chunkOverlap), 0, Math.max(0, target - 40));
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: '', body: [] };
  for (const line of text.split('\n')) {
    const heading = settings.smartChunk ? chunkHeading(line) : null;
    if (heading !== null) {
      if (current.body.join('\n').trim()) sections.push(current);
      current = { heading, body: [] };
    } else if (line.startsWith('#')) {
      if (current.body.join('\n').trim()) sections.push(current);
      current = { heading: current.heading, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('\n').trim()) sections.push(current);
  if (sections.length === 0) sections.push({ heading: '', body: [text] });

  const chunks: ChunkDraft[] = [];
  for (const section of sections) {
    const paragraphs = section.body.join('\n').split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
    let buffer = '';
    const flush = (): void => {
      const value = buffer.trim();
      if (value.length >= 2) chunks.push({ heading: section.heading, text: value });
      buffer = '';
    };
    for (const paragraph of paragraphs.length ? paragraphs : [section.body.join('\n')]) {
      if (paragraph.length > target) {
        flush();
        for (let start = 0; start < paragraph.length; start += Math.max(1, target - overlap)) {
          const piece = paragraph.slice(start, start + target).trim();
          if (piece.length >= 2) chunks.push({ heading: section.heading, text: piece });
          if (start + target >= paragraph.length) break;
        }
        continue;
      }
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length > target && buffer) {
        const carry = overlap > 0 ? buffer.slice(-overlap) : '';
        flush();
        buffer = carry ? `${carry}\n\n${paragraph}` : paragraph;
      } else {
        buffer = candidate;
      }
    }
    flush();
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

function lexicalScore(query: Set<string>, row: ChunkRow): number {
  const corpus = tokenize(`${row.title} ${row.heading} ${row.text}`);
  if (corpus.length === 0) return 0;
  const seen = new Set(corpus);
  let matched = 0;
  let weighted = 0;
  for (const token of query) {
    if (!seen.has(token)) continue;
    matched += 1;
    weighted += token.length >= 2 ? 1.4 : 1;
  }
  if (matched === 0) return 0;
  const coverage = matched / query.size;
  const density = Math.min(1, (weighted * 3) / Math.max(1, Math.sqrt(corpus.length)));
  return Math.min(1, coverage * 0.75 + density * 0.25);
}

function formatRowHit(row: ChunkRow, score: number): KnowledgeHit {
  return {
    baseId: row.base_id,
    baseName: row.base_name,
    documentId: row.doc_id,
    title: row.title,
    heading: row.heading,
    text: row.text,
    score: Number(score.toFixed(4)),
  };
}

/** 本地知识库：SQLite 存知识库/文档/分块，可选 Ollama/OpenAI embedding 与 rerank。 */
export class KnowledgeService {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.ensureSettings();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureSettings(): void {
    const row = this.db.prepare('SELECT id FROM knowledge_settings WHERE id=1').get();
    if (row) return;
    const ts = nowIso();
    this.db.prepare(`INSERT INTO knowledge_settings
      (id,embedding_provider,embedding_model,embedding_base_url,embedding_api_key,rerank_model,rerank_base_url,rerank_api_key,top_k,chunk_size,chunk_overlap,auto_recall,max_context_chars,smart_chunk,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      DEFAULT_SETTINGS.embeddingProvider,
      DEFAULT_SETTINGS.embeddingModel,
      DEFAULT_SETTINGS.embeddingBaseUrl,
      DEFAULT_SETTINGS.embeddingApiKey,
      DEFAULT_SETTINGS.rerankModel,
      DEFAULT_SETTINGS.rerankBaseUrl,
      DEFAULT_SETTINGS.rerankApiKey,
      DEFAULT_SETTINGS.topK,
      DEFAULT_SETTINGS.chunkSize,
      DEFAULT_SETTINGS.chunkOverlap,
      DEFAULT_SETTINGS.autoRecall ? 1 : 0,
      DEFAULT_SETTINGS.maxContextChars,
      DEFAULT_SETTINGS.smartChunk ? 1 : 0,
      ts,
    );
  }

  settings(): KnowledgeSettings {
    const row = this.db.prepare('SELECT * FROM knowledge_settings WHERE id=1').get() as Record<string, unknown>;
    return {
      embeddingProvider: normalizeProvider(String(row.embedding_provider ?? 'none')),
      embeddingModel: String(row.embedding_model ?? ''),
      embeddingBaseUrl: String(row.embedding_base_url ?? DEFAULT_SETTINGS.embeddingBaseUrl),
      embeddingApiKey: String(row.embedding_api_key ?? ''),
      rerankModel: String(row.rerank_model ?? ''),
      rerankBaseUrl: String(row.rerank_base_url ?? ''),
      rerankApiKey: String(row.rerank_api_key ?? ''),
      topK: Number(row.top_k ?? DEFAULT_SETTINGS.topK),
      chunkSize: Number(row.chunk_size ?? DEFAULT_SETTINGS.chunkSize),
      chunkOverlap: Number(row.chunk_overlap ?? DEFAULT_SETTINGS.chunkOverlap),
      autoRecall: Number(row.auto_recall ?? 1) === 1,
      maxContextChars: Number(row.max_context_chars ?? DEFAULT_SETTINGS.maxContextChars),
      smartChunk: Number(row.smart_chunk ?? 1) === 1,
    };
  }

  publicSettings(): PublicKnowledgeSettings {
    const settings = this.settings();
    const { embeddingApiKey, rerankApiKey, ...rest } = settings;
    return { ...rest, hasEmbeddingKey: Boolean(embeddingApiKey), hasRerankKey: Boolean(rerankApiKey) };
  }

  updateSettings(patch: Partial<KnowledgeSettings> & { clearEmbeddingKey?: boolean; clearRerankKey?: boolean }): KnowledgeSettings {
    const current = this.settings();
    const next: KnowledgeSettings = { ...current };
    if (patch.embeddingProvider !== undefined) next.embeddingProvider = normalizeProvider(String(patch.embeddingProvider));
    if (patch.embeddingModel !== undefined) next.embeddingModel = String(patch.embeddingModel).trim();
    if (patch.embeddingBaseUrl !== undefined) next.embeddingBaseUrl = safeUrl(String(patch.embeddingBaseUrl)) || DEFAULT_SETTINGS.embeddingBaseUrl;
    if (patch.embeddingApiKey !== undefined && String(patch.embeddingApiKey).trim()) next.embeddingApiKey = String(patch.embeddingApiKey).trim();
    if (patch.clearEmbeddingKey) next.embeddingApiKey = '';
    if (patch.rerankModel !== undefined) next.rerankModel = String(patch.rerankModel).trim();
    if (patch.rerankBaseUrl !== undefined) next.rerankBaseUrl = safeUrl(String(patch.rerankBaseUrl));
    if (patch.rerankApiKey !== undefined && String(patch.rerankApiKey).trim()) next.rerankApiKey = String(patch.rerankApiKey).trim();
    if (patch.clearRerankKey) next.rerankApiKey = '';
    if (patch.topK !== undefined) next.topK = clamp(Math.trunc(Number(patch.topK) || DEFAULT_SETTINGS.topK), 1, 50);
    if (patch.chunkSize !== undefined) next.chunkSize = clamp(Math.trunc(Number(patch.chunkSize) || DEFAULT_SETTINGS.chunkSize), 120, 8000);
    if (patch.chunkOverlap !== undefined) next.chunkOverlap = clamp(Math.trunc(Number(patch.chunkOverlap) || 0), 0, Math.max(0, next.chunkSize - 40));
    if (patch.autoRecall !== undefined) next.autoRecall = Boolean(patch.autoRecall);
    if (patch.maxContextChars !== undefined) next.maxContextChars = clamp(Math.trunc(Number(patch.maxContextChars) || DEFAULT_SETTINGS.maxContextChars), 500, 20000);
    if (patch.smartChunk !== undefined) next.smartChunk = Boolean(patch.smartChunk);
    this.db.prepare(`UPDATE knowledge_settings SET
      embedding_provider=?, embedding_model=?, embedding_base_url=?, embedding_api_key=?,
      rerank_model=?, rerank_base_url=?, rerank_api_key=?, top_k=?, chunk_size=?, chunk_overlap=?,
      auto_recall=?, max_context_chars=?, smart_chunk=?, updated_at=? WHERE id=1`).run(
      next.embeddingProvider,
      next.embeddingModel,
      next.embeddingBaseUrl,
      next.embeddingApiKey,
      next.rerankModel,
      next.rerankBaseUrl,
      next.rerankApiKey,
      next.topK,
      next.chunkSize,
      next.chunkOverlap,
      next.autoRecall ? 1 : 0,
      next.maxContextChars,
      next.smartChunk ? 1 : 0,
      nowIso(),
    );
    return next;
  }

  listBases(): KnowledgeBase[] {
    const rows = this.db.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM knowledge_documents d WHERE d.base_id=b.id) AS document_count,
        (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.base_id=b.id) AS chunk_count
      FROM knowledge_bases b ORDER BY b.enabled DESC, b.updated_at DESC, b.id
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      enabled: Number(row.enabled ?? 0) === 1,
      documentCount: Number(row.document_count ?? 0),
      chunkCount: Number(row.chunk_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getBase(id: string): KnowledgeBase | undefined {
    return this.listBases().find((base) => base.id === id);
  }

  createBase(input: { name: string; description?: string }): KnowledgeBase {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 100) throw new Error('知识库名称需为 1-100 个字符');
    const description = String(input.description ?? '').trim().slice(0, 2000);
    const id = newId('kb');
    const ts = nowIso();
    this.db.prepare('INSERT INTO knowledge_bases (id,name,description,enabled,created_at,updated_at) VALUES (?,?,?,0,?,?)')
      .run(id, name, description, ts, ts);
    return this.getBase(id)!;
  }

  updateBase(id: string, patch: { name?: string; description?: string; enabled?: boolean }): KnowledgeBase {
    const base = this.getBase(id);
    if (!base) throw new Error('知识库不存在');
    let name = base.name;
    if (patch.name !== undefined) {
      name = String(patch.name).trim();
      if (!name || name.length > 100) throw new Error('知识库名称需为 1-100 个字符');
    }
    const description = patch.description !== undefined ? String(patch.description).trim().slice(0, 2000) : base.description;
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : base.enabled;
    this.db.prepare('UPDATE knowledge_bases SET name=?,description=?,enabled=?,updated_at=? WHERE id=?')
      .run(name, description, enabled ? 1 : 0, nowIso(), id);
    return this.getBase(id)!;
  }

  deleteBase(id: string): void {
    if (!this.getBase(id)) throw new Error('知识库不存在');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE base_id=?').run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE base_id=?').run(id);
      this.db.prepare('DELETE FROM knowledge_bases WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDocuments(baseId: string): KnowledgeDocument[] {
    const rows = this.db.prepare('SELECT * FROM knowledge_documents WHERE base_id=? ORDER BY created_at DESC').all(baseId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      baseId: String(row.base_id),
      title: String(row.title),
      filename: String(row.filename),
      format: String(row.format),
      chars: Number(row.chars ?? 0),
      status: String(row.status ?? 'active'),
      warning: String(row.warning ?? ''),
      createdAt: String(row.created_at),
    }));
  }

  async addDocument(baseId: string, input: { filename: string; buffer: Buffer; contentType?: string }): Promise<KnowledgeDocument> {
    if (!this.getBase(baseId)) throw new Error('知识库不存在');
    if (!input.buffer.length) throw new Error('文档内容为空');
    if (input.buffer.length > 25 * 1024 * 1024) throw new Error('文档不能超过 25MB');
    const filename = path.basename(input.filename || 'document.txt');
    const normalized = await normalizeDocument(input.buffer, filename, input.contentType ?? '');
    const text = normalized.text.trim();
    if (!text) throw new Error('文档没有可索引的文本');
    const settings = this.settings();
    const chunks = chunkKnowledgeText(text, settings);
    if (chunks.length === 0) throw new Error('文档切块为空');
    const id = newId('doc');
    const title = filename.replace(/\.[^.]+$/, '') || filename;
    const ts = nowIso();
    const embeddings = await this.embedTexts(chunks.map((chunk) => `${title}\n${chunk.heading}\n${chunk.text}`));
    const warning = embeddings === null && settings.embeddingProvider !== 'none'
      ? '嵌入模型调用失败，当前仅使用关键词检索'
      : normalized.warnings.join('；');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO knowledge_documents (id,base_id,title,filename,format,chars,status,warning,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, baseId, title, filename, normalized.format, text.length, 'active', warning, ts);
      chunks.forEach((chunk, index) => {
        const vector = embeddings?.[index];
        this.db.prepare('INSERT INTO knowledge_chunks (id,doc_id,base_id,ordinal,heading,text,embedding_json,embed_model,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            newId('chk'),
            id,
            baseId,
            index,
            chunk.heading,
            chunk.text,
            vector ? JSON.stringify(vector) : null,
            vector ? settings.embeddingModel : null,
            ts,
          );
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      id,
      baseId,
      title,
      filename,
      format: normalized.format,
      chars: text.length,
      status: 'active',
      warning,
      createdAt: ts,
    };
  }

  deleteDocument(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_id=?').run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): { bases: number; enabledBases: number; documents: number; chunks: number; embeddedChunks: number } {
    const bases = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_bases').get() as { n: number };
    const enabled = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_bases WHERE enabled=1').get() as { n: number };
    const documents = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get() as { n: number };
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as { n: number };
    const embedded = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE embedding_json IS NOT NULL').get() as { n: number };
    return {
      bases: Number(bases.n),
      enabledBases: Number(enabled.n),
      documents: Number(documents.n),
      chunks: Number(chunks.n),
      embeddedChunks: Number(embedded.n),
    };
  }

  hasEnabledBases(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM knowledge_bases WHERE enabled=1 LIMIT 1').get();
    return Boolean(row);
  }

  /** 画像/评估/建议阶段调用：必须至少启用一个知识库，且开启自动召回。 */
  async recall(query: string, topK?: number): Promise<KnowledgeHit[]> {
    if (!this.settings().autoRecall || !this.hasEnabledBases()) return [];
    return this.search(query, { topK });
  }

  async search(query: string, options: { topK?: number; baseIds?: string[] } = {}): Promise<KnowledgeHit[]> {
    const text = String(query ?? '').trim();
    if (text.length < 2) return [];
    const settings = this.settings();
    const topK = clamp(Math.trunc(options.topK ?? settings.topK), 1, 50);
    const allowed = options.baseIds?.length ? new Set(options.baseIds) : null;
    const rows = this.db.prepare(`
      SELECT c.id,c.doc_id,c.base_id,c.heading,c.text,c.embedding_json,c.embed_model,
             d.title,b.name AS base_name
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id=c.doc_id
      JOIN knowledge_bases b ON b.id=c.base_id
      WHERE b.enabled=1
      ORDER BY c.ordinal ASC
      LIMIT 12000
    `).all() as ChunkRow[];
    const candidates = allowed ? rows.filter((row) => allowed.has(row.base_id)) : rows;
    if (candidates.length === 0) return [];
    const queryTokens = new Set(tokenize(text));
    const semantic = await this.embedTexts([text]);
    const semanticQuery = semantic?.[0];
    const lexical = candidates
      .map((row) => ({ row, score: lexicalScore(queryTokens, row) }))
      .filter((item) => item.score > 0);
    let ranked: { row: ChunkRow; score: number }[];
    if (semanticQuery) {
      ranked = [];
      for (const row of candidates) {
        const vector = row.embedding_json ? (JSON.parse(row.embedding_json) as number[]) : null;
        const cosineScore = vector && row.embed_model === settings.embeddingModel ? cosine(semanticQuery, vector) : 0;
        const lexicalValue = lexicalScore(queryTokens, row);
        const score = cosineScore > 0 ? cosineScore * 0.75 + lexicalValue * 0.25 : lexicalValue;
        if (score > 0) ranked.push({ row, score });
      }
    } else {
      ranked = lexical;
    }
    ranked.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
    const limited = ranked.slice(0, Math.max(topK * 4, 20));
    const reranked = await this.rerank(text, limited);
    return reranked.slice(0, topK).map(({ row, score }) => formatRowHit(row, score));
  }

  async testEmbedding(): Promise<{ ok: boolean; model: string; dimensions: number; error?: string }> {
    const settings = this.settings();
    if (settings.embeddingProvider === 'none') return { ok: false, model: '', dimensions: 0, error: '未启用嵌入模型' };
    const vectors = await this.embedTexts(['知识库连接测试']);
    if (!vectors) return { ok: false, model: settings.embeddingModel, dimensions: 0, error: '无法连接嵌入服务' };
    return { ok: true, model: settings.embeddingModel, dimensions: vectors[0]?.length ?? 0 };
  }

  private async embedTexts(texts: string[]): Promise<number[][] | null> {
    const settings = this.settings();
    if (settings.embeddingProvider === 'none' || !settings.embeddingModel.trim() || texts.length === 0) return null;
    const batches: string[][] = [];
    for (let index = 0; index < texts.length; index += 32) batches.push(texts.slice(index, index + 32));
    const vectors: number[][] = [];
    try {
      for (const batch of batches) {
        if (settings.embeddingProvider === 'ollama') {
          const base = settings.embeddingBaseUrl.replace(/\/$/, '');
          let response = await fetch(`${base}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.embeddingModel, input: batch }),
            signal: AbortSignal.timeout(60_000),
          });
          if (response.ok) {
            const data = (await response.json()) as { embeddings?: number[][] };
            if (Array.isArray(data.embeddings)) {
              vectors.push(...data.embeddings);
              continue;
            }
          }
          // 兼容旧版 Ollama /api/embeddings
          for (const item of batch) {
            response = await fetch(`${base}/api/embeddings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: settings.embeddingModel, prompt: item }),
              signal: AbortSignal.timeout(60_000),
            });
            if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
            const data = (await response.json()) as { embedding?: number[] };
            if (!data.embedding) throw new Error('Ollama 返回空向量');
            vectors.push(data.embedding);
          }
        } else {
          const base = settings.embeddingBaseUrl.replace(/\/$/, '');
          const endpoint = /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (settings.embeddingApiKey) headers.Authorization = `Bearer ${settings.embeddingApiKey}`;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: settings.embeddingModel, input: batch }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
          const data = (await response.json()) as { data?: { embedding?: number[] }[] };
          const batchVectors = (data.data ?? []).map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item));
          if (batchVectors.length !== batch.length) throw new Error('Embedding 返回数量不匹配');
          vectors.push(...batchVectors);
        }
      }
      return vectors;
    } catch {
      return null;
    }
  }

  private async rerank(query: string, candidates: { row: ChunkRow; score: number }[]): Promise<{ row: ChunkRow; score: number }[]> {
    const settings = this.settings();
    if (!settings.rerankModel || !settings.rerankBaseUrl || candidates.length === 0) return candidates;
    try {
      const base = settings.rerankBaseUrl.replace(/\/$/, '');
      const endpoint = /\/rerank$/i.test(base)
        ? base
        : /\/v1$/i.test(base) ? `${base}/rerank` : `${base}/v1/rerank`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.rerankApiKey) headers.Authorization = `Bearer ${settings.rerankApiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.rerankModel,
          query,
          documents: candidates.map(({ row }) => `${row.title}\n${row.heading}\n${row.text}`),
          top_n: candidates.length,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return candidates;
      const data = (await response.json()) as { results?: { index?: number; relevance_score?: number }[] };
      const byIndex = new Map<number, number>();
      for (const result of data.results ?? []) {
        if (typeof result.index === 'number' && typeof result.relevance_score === 'number') byIndex.set(result.index, result.relevance_score);
      }
      if (byIndex.size === 0) return candidates;
      return candidates
        .map((candidate, index) => ({ ...candidate, score: byIndex.get(index) ?? candidate.score }))
        .sort((a, b) => b.score - a.score);
    } catch {
      return candidates;
    }
  }
}

export function formatKnowledgeReferences(hits: KnowledgeHit[], maxChars = 4000): string {
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const head = `【${hit.baseName} / ${hit.title}${hit.heading ? ` / ${hit.heading}` : ''}】`;
    const body = hit.text.length > 700 ? `${hit.text.slice(0, 700)}…` : hit.text;
    const line = `${head}\n${body}`;
    if (used + line.length > maxChars && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n\n');
}
