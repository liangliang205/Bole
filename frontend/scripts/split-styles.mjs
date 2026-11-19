/**
 * 一次性组织重构：把旧全局样式表按职责切成三份。
 *
 *   tokens.css  主题变量（:root / html[data-theme]）
 *   base.css    reset、html/body、布局骨架与工具类
 *   legacy.css  其余全部（原样、原顺序）
 *
 * 只搬位置，不改声明；audit-styles.mjs 逐条比对。生成后本脚本可弃用。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..');
const source = path.join(repoRoot, 'src', 'web', 'public', 'styles.css');
const outDir = path.join(repoRoot, 'frontend', 'src', 'styles');

const text = await readFile(source, 'utf8');
const lines = text.split(/\r?\n/);
const sectionStart = lines.findIndex((line) => /^[ \t]*\/\*\s*(sidebar|buttons|main)\s*\*\//.test(line));
if (sectionStart < 0) throw new Error('没有找到第一个 section 注释，无法定位拆分点');

const head = lines.slice(0, sectionStart).join('\n');
const themeStart = head.indexOf(':root');
if (themeStart < 0) throw new Error('头部没有 :root 主题变量块');
let depth = 0;
let themeEnd = themeStart;
for (; themeEnd < head.length; themeEnd += 1) {
  if (head[themeEnd] === '{') depth += 1;
  else if (head[themeEnd] === '}') {
    depth -= 1;
    if (depth === 0) { themeEnd += 1; break; }
  }
}
const tokens = head.slice(themeStart, themeEnd);
const base = `${head.slice(0, themeStart)}${head.slice(themeEnd)}`;
const legacy = lines.slice(sectionStart).join('\n');

await writeFile(path.join(outDir, 'tokens.css'), `${tokens.trim()}\n`, 'utf8');
await writeFile(path.join(outDir, 'base.css'), `${base.trim()}\n`, 'utf8');
await writeFile(path.join(outDir, 'legacy.css'), `${legacy.trim()}\n`, 'utf8');

process.stdout.write(
  `tokens ${tokens.split('\n').length} 行 / base ${base.trim().split('\n').length} 行 / legacy ${legacy.trim().split('\n').length} 行\n`,
);
