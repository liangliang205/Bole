/**
 * 截图对照工具。
 *
 *   node scripts/shoot.mjs --base http://127.0.0.1:8787 --out .shots/old
 *   node scripts/shoot.mjs --compare --out .shots/f1 --batch f1
 *   node scripts/shoot.mjs --compare --baseline .shots/baseline-a --out .shots/visual-1
 *   node scripts/shoot.mjs --manual
 *
 * 判定交给调用者：脚本只报差异比例，不因差异大小改变退出码；
 * 只有当页面报错或截图失败时才以 1 退出。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { states } from './states.mjs';

const VIEWPORT = { width: 1440, height: 900 };

function parseArgs(argv) {
  const out = { mode: 'base', base: 'http://127.0.0.1:8787', newBase: 'http://127.0.0.1:5173', out: '.shots/out', batch: '', only: [], baseline: '', manual: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') out.base = argv[++index];
    else if (arg === '--new-base') out.newBase = argv[++index];
    else if (arg === '--out') out.out = argv[++index];
    else if (arg === '--batch') out.batch = argv[++index];
    else if (arg === '--only') out.only = argv[++index].split(',').map((item) => item.trim());
    else if (arg === '--baseline') { out.baseline = argv[++index]; out.mode = 'baseline'; }
    else if (arg === '--compare') out.mode = 'compare';
    else if (arg === '--manual') out.manual = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

function selected(state, options) {
  if (options.only.length > 0) return options.only.includes(state.name);
  if (options.batch) return state.batch === options.batch;
  return true;
}

async function applySteps(page, steps) {
  for (const step of steps) {
    if (step.waitFor) await page.waitForSelector(step.waitFor, { state: 'visible', timeout: 15000 });
    if (step.click) await page.click(step.click, { timeout: 15000 });
    if (step.fill) await page.fill(step.fill.selector, step.fill.value);
    if (step.press) await page.keyboard.press(step.press);
    if (step.waitMs) await page.waitForTimeout(step.waitMs);
  }
}

async function shoot(page, base, state, file) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await applySteps(page, state.steps);
  const buffer = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await writeFile(file, buffer);
  return buffer;
}

async function diffPair(oldFile, newFile, diffFile) {
  const [oldBuffer, newBuffer] = await Promise.all([readOrNull(oldFile), readOrNull(newFile)]);
  if (!oldBuffer || !newBuffer) return { pct: null, note: '缺图' };
  const a = PNG.sync.read(oldBuffer);
  const b = PNG.sync.read(newBuffer);
  if (a.width !== b.width || a.height !== b.height) {
    return { pct: 100, note: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  await writeFile(diffFile, PNG.sync.write(diff));
  return { pct: (changed / (a.width * a.height)) * 100, note: '' };
}

async function readOrNull(file) {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(file);
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
const runnable = states.filter((state) => selected(state, options) && !state.manual);

if (options.manual) {
  process.stdout.write(`旧版：${options.base}\n新版：${options.newBase}\n`);
  for (const state of runnable) process.stdout.write(`- ${state.name}（batch ${state.batch}）\n`);
  process.exit(0);
}

await mkdir(options.out, { recursive: true });

if (options.mode === 'baseline') {
  const { cp } = await import('node:fs/promises');
  const pairs = [];
  for (const state of runnable) {
    const baseFile = path.join(options.baseline, `${state.name}.png`);
    const nextFile = path.join(options.out, `${state.name}-new.png`);
    const diffFile = path.join(options.out, `${state.name}-diff.png`);
    pairs.push({ state, baseFile, nextFile, diffFile });
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  let failures = 0;
  for (const pair of pairs) {
    try {
      await shoot(page, options.newBase, pair.state, pair.nextFile);
    } catch (error) {
      failures += 1;
      process.stdout.write(`FAIL ${pair.state.name}: ${String(error).split('\n')[0]}\n`);
    }
  }
  await browser.close();
  for (const pair of pairs) {
    const result = await diffPair(pair.baseFile, pair.nextFile, pair.diffFile);
    if (result.pct === null) continue;
    process.stdout.write(`DIFF ${pair.state.name} ${result.pct.toFixed(3)}%${result.note ? ` (${result.note})` : ''}\n`);
  }
  process.stdout.write(`baseline 对照完成：${options.out}\n`);
  void cp;
  process.exit(failures === 0 ? 0 : 1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const shots = new Map();
let failures = 0;

for (const state of runnable) {
  const suffix = options.mode === 'compare' ? '-old' : '';
  const file = path.join(options.out, `${state.name}${suffix}.png`);
  try {
    await shoot(page, options.base, state, file);
    shots.set(state.name, file);
    process.stdout.write(`SHOT ${state.name} -> ${file}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${state.name}: ${String(error).split('\n')[0]}\n`);
  }
}

if (options.mode === 'compare') {
  for (const state of runnable) {
    const oldFile = shots.get(state.name);
    if (!oldFile) continue;
    const nextFile = path.join(options.out, `${state.name}-new.png`);
    const diffFile = path.join(options.out, `${state.name}-diff.png`);
    try {
      await shoot(page, options.newBase, state, nextFile);
    } catch (error) {
      failures += 1;
      process.stdout.write(`FAIL ${state.name} (new): ${String(error).split('\n')[0]}\n`);
      continue;
    }
    const result = await diffPair(oldFile, nextFile, diffFile);
    if (result.pct === null) continue;
    process.stdout.write(`DIFF ${state.name} ${result.pct.toFixed(3)}%${result.note ? ` (${result.note})` : ''}\n`);
  }
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
