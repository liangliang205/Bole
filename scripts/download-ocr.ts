import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolvePaths } from '../src/config.ts';

const LANGS = (process.env.BOLE_OCR_LANG || 'chi_sim+eng').split('+').map((item) => item.trim()).filter(Boolean);
const BASE = process.env.BOLE_TESSDATA_URL || 'https://tessdata.projectnaptha.com/4.0.0';

const paths = resolvePaths();
await mkdir(paths.ocrDir, { recursive: true });

for (const lang of LANGS) {
  const target = path.join(paths.ocrDir, `${lang}.traineddata.gz`);
  if (existsSync(target)) {
    process.stdout.write(`已存在 ${target}\n`);
    continue;
  }
  const url = `${BASE}/${lang}.traineddata.gz`;
  process.stdout.write(`下载 ${url}\n`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
  const temp = `${target}.download`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rename(temp, target);
  process.stdout.write(`完成 ${target}\n`);
}

process.stdout.write('OCR 语言数据就绪。图片简历将使用本地 Tesseract；也可设置 BOLE_OCR_URL 走外部服务。\n');
