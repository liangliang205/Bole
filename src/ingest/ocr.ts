import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../config.ts';

export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

type TesseractWorker = {
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
};

let workerPromise: Promise<TesseractWorker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let activeUsers = 0;

/** 每个使用 OCR 的批次/运行登记一次，最后一个释放时再终止 worker，避免并发运行互相踩踏。 */
export function acquireOcr(): void {
  activeUsers += 1;
}

export async function releaseOcr(): Promise<void> {
  activeUsers = Math.max(0, activeUsers - 1);
  if (activeUsers > 0) return;
  await closeOcr();
}

function langList(): string[] {
  const raw = process.env.BOLE_OCR_LANG || 'chi_sim+eng';
  return raw.split('+').map((item) => item.trim()).filter(Boolean);
}

async function assertLocalLanguageData(langPath: string, langs: string[]): Promise<void> {
  const missing = langs.filter((lang) => !existsSync(path.join(langPath, `${lang}.traineddata.gz`)));
  if (missing.length > 0) {
    throw new OcrUnavailableError(
      `缺少 OCR 语言数据：${missing.join(', ')}。请运行 pnpm ocr:download，或设置 BOLE_OCR_URL 使用外部 OCR 服务。`,
    );
  }
}

async function getWorker(): Promise<TesseractWorker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const paths = resolvePaths();
    const langs = langList();
    await assertLocalLanguageData(paths.ocrDir, langs);
    const { createWorker } = (await import('tesseract.js')) as unknown as {
      createWorker: (langs: string, oem: number, options: Record<string, unknown>) => Promise<TesseractWorker>;
    };
    return createWorker(langs.join('+'), 1, {
      langPath: paths.ocrDir,
      logger: () => {},
      cachePath: paths.ocrDir,
      gzip: true,
    });
  })();
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    throw error;
  }
}

async function ocrViaHttp(buffer: Buffer, filename: string): Promise<string> {
  const url = process.env.BOLE_OCR_URL as string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.BOLE_OCR_KEY) headers.Authorization = `Bearer ${process.env.BOLE_OCR_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ filename, imageBase64: buffer.toString('base64') }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new OcrUnavailableError(`外部 OCR 服务失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as { text?: string; result?: { text?: string } };
  const text = data.text ?? data.result?.text ?? '';
  if (!text.trim()) throw new OcrUnavailableError('外部 OCR 服务返回空文本');
  return text;
}

/** 图片 OCR：优先使用配置的外部 OCR 服务，否则使用本地 Tesseract（需要 pnpm ocr:download）。 */
export async function ocrImage(buffer: Buffer, filename = 'resume.png'): Promise<string> {
  if (process.env.BOLE_OCR_URL) return ocrViaHttp(buffer, filename);
  const run = queue.then(async () => {
    const worker = await getWorker();
    const result = await worker.recognize(buffer);
    return result.data.text;
  });
  queue = run.catch(() => {});
  return run;
}

/** 结束本地 Tesseract worker，释放子进程/定时器；直接调用方（测试/脚本）使用。 */
export async function closeOcr(): Promise<void> {
  await queue.catch(() => {});
  const current = workerPromise;
  workerPromise = null;
  if (!current) return;
  try {
    const worker = await current;
    await worker.terminate();
  } catch {
    // worker 未成功创建或已退出
  }
}
