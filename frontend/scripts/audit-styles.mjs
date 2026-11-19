/**
 * 样式等价审计：证明 styles/ 下的拆分与旧全局样式表逐条等价。
 *
 *   node scripts/audit-styles.mjs
 *   node scripts/audit-styles.mjs --verbose
 *
 * 判定：三份文件（tokens/base/legacy）的规则多重集必须与
 * src/web/public/styles.css 完全一致，差一条即失败。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { splitRules, countByKey } from './css-rules.mjs';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..');
const sourceFile = path.join(repoRoot, 'src', 'web', 'public', 'styles.css');
const stylesDir = path.join(repoRoot, 'frontend', 'src', 'styles');
const parts = ['tokens.css', 'base.css', 'legacy.css'];
const verbose = process.argv.includes('--verbose');

const sourceRules = splitRules(await readFile(sourceFile, 'utf8'));
const partRules = [];
for (const name of parts) {
  const file = path.join(stylesDir, name);
  for (const rule of splitRules(await readFile(file, 'utf8'))) partRules.push({ ...rule, file: name });
}

const sourceMap = countByKey(sourceRules);
const partMap = countByKey(partRules);

const missing = [];
for (const [key, count] of sourceMap) {
  const found = partMap.get(key) ?? 0;
  if (found < count) missing.push({ key, expected: count, found });
}
const orphan = [];
for (const [key, count] of partMap) {
  const wanted = sourceMap.get(key) ?? 0;
  if (count > wanted) orphan.push({ key, found: count, expected: wanted });
}

const label = (key) => key.split('||')[0].slice(0, 96);
if (missing.length > 0) {
  process.stdout.write(`MISSING ${missing.length} 条源规则在拆分里丢失或改动了：\n`);
  for (const item of missing.slice(0, verbose ? missing.length : 15)) {
    process.stdout.write(`  - ${label(item.key)}（需要 ${item.expected}，找到 ${item.found}）\n`);
  }
}
if (orphan.length > 0) {
  process.stdout.write(`ORPHAN ${orphan.length} 条规则在源里找不到（说明被改写或新增）：\n`);
  for (const item of orphan.slice(0, verbose ? orphan.length : 15)) {
    process.stdout.write(`  - ${label(item.key)}（找到 ${item.found}，源里 ${item.expected}）\n`);
  }
}

process.stdout.write(
  `audit: ${sourceRules.length} source rules, ${partRules.length} in parts, ` +
  `${missing.length} missing, ${orphan.length} orphan\n`,
);

process.exit(missing.length === 0 && orphan.length === 0 ? 0 : 1);
