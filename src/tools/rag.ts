import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../util/ids.ts';
import { tokenize } from '../util/text.ts';

export interface RagDoc {
  id: string;
  title: string;
  heading: string;
  text: string;
}

export interface RagHit extends RagDoc {
  score: number;
}

interface PersistedIndex {
  version: number;
  hash: string;
  docs: RagDoc[];
}

const INDEX_VERSION = 1;

function chunkDocument(title: string, text: string): RagDoc[] {
  const chunks: RagDoc[] = [];
  let heading = title;
  let buffer: string[] = [];
  let bufferLength = 0;
  let counter = 0;

  const flush = (): void => {
    if (bufferLength === 0) return;
    const body = buffer.join('\n').trim();
    if (body.length >= 40) {
      chunks.push({
        id: `${title}#${counter}`,
        title,
        heading,
        text: body.slice(0, 900),
      });
      counter += 1;
    }
    buffer = [];
    bufferLength = 0;
  };

  for (const line of text.split('\n')) {
    const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      heading = headingMatch[2].trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    buffer.push(line);
    bufferLength += line.length + 1;
    if (bufferLength > 520) flush();
  }
  flush();
  return chunks;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const length = Math.max(1, tokens.length);
  for (const [token, count] of tf) tf.set(token, count / length);
  return tf;
}

function vectorNorm(vector: Map<string, number>): number {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

/** 轻量 RAG：TF-IDF + 余弦相似度，零外部依赖、结果确定。P1 可替换为 ChromaDB/Qdrant。 */
export class RagIndex {
  readonly docs: RagDoc[];
  private idf: Map<string, number>;
  private vectors: Map<string, number>[];
  private norms: number[];

  constructor(docs: RagDoc[]) {
    this.docs = docs;
    const df = new Map<string, number>();
    const tfs = docs.map((doc) => {
      const tf = termFrequency(tokenize(`${doc.title} ${doc.heading} ${doc.text}`));
      for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
      return tf;
    });
    const total = Math.max(1, docs.length);
    this.idf = new Map();
    for (const [token, count] of df) {
      this.idf.set(token, Math.log((total + 1) / (count + 0.5)) + 1);
    }
    this.vectors = tfs.map((tf) => {
      const vector = new Map<string, number>();
      for (const [token, freq] of tf) {
        const weight = freq * (this.idf.get(token) ?? 1);
        if (weight > 0) vector.set(token, weight);
      }
      return vector;
    });
    this.norms = this.vectors.map(vectorNorm);
  }

  static fromKnowledge(knowledgeDir: string): RagIndex {
    if (!existsSync(knowledgeDir)) return new RagIndex([]);
    const docs: RagDoc[] = [];
    const files = readdirSync(knowledgeDir).filter((name) => name.endsWith('.md')).sort();
    for (const file of files) {
      const text = readFileSync(path.join(knowledgeDir, file), 'utf8');
      docs.push(...chunkDocument(file.replace(/\.md$/, ''), text));
    }
    return new RagIndex(docs);
  }

  static loadOrBuild(knowledgeDir: string, indexDir: string): RagIndex {
    if (!existsSync(knowledgeDir)) return new RagIndex([]);
    const files = readdirSync(knowledgeDir).filter((name) => name.endsWith('.md')).sort();
    const hash = sha256Hex(files.map((f) => `${f}:${readFileSync(path.join(knowledgeDir, f), 'utf8')}`).join('\n')).slice(0, 16);
    const cacheFile = path.join(indexDir, 'rag.json');
    if (existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as PersistedIndex;
        if (cached.version === INDEX_VERSION && cached.hash === hash) return new RagIndex(cached.docs);
      } catch {
        // 缓存损坏则重建
      }
    }
    const index = RagIndex.fromKnowledge(knowledgeDir);
    try {
      mkdirSync(indexDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ version: INDEX_VERSION, hash, docs: index.docs }), 'utf8');
    } catch {
      // 索引持久化失败不影响检索
    }
    return index;
  }

  search(query: string, topK = 4, predicate?: (doc: RagDoc) => boolean): RagHit[] {
    const queryTf = termFrequency(tokenize(query));
    const queryVector = new Map<string, number>();
    for (const [token, freq] of queryTf) {
      const idf = this.idf.get(token);
      if (idf) queryVector.set(token, freq * idf);
    }
    const queryNorm = vectorNorm(queryVector);
    if (queryNorm === 0) return [];
    const scored: RagHit[] = [];
    for (let i = 0; i < this.docs.length; i += 1) {
      const doc = this.docs[i];
      if (predicate && !predicate(doc)) continue;
      const vector = this.vectors[i];
      const norm = this.norms[i];
      if (norm === 0) continue;
      let dot = 0;
      for (const [token, weight] of queryVector) {
        const other = vector.get(token);
        if (other) dot += weight * other;
      }
      if (dot <= 0) continue;
      scored.push({ ...doc, score: Number((dot / (queryNorm * norm)).toFixed(4)) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK);
  }

  get size(): number {
    return this.docs.length;
  }

  titles(): string[] {
    return [...new Set(this.docs.map((d) => d.title))];
  }
}
