import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const stylesDir = 'frontend/src/styles';
const root = 'frontend/src';

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css')).map((f) => path.join(stylesDir, f));
const codeText = walk(root)
  .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// 每个类出现在哪些 CSS 文件的哪些规则里
const declarations = new Map(); // class -> [{file, selector}]
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    for (const cls of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
      const list = declarations.get(cls[1]) ?? [];
      list.push({ file: path.basename(file), selector: selector.replace(/\s+/g, ' ').slice(0, 70) });
      declarations.set(cls[1], list);
    }
  }
}

// 只有在源码里"整词"出现才算被引用
const referenced = (name) => new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(codeText);

const dead = [...declarations.entries()].filter(([name]) => !referenced(name));

const byFile = new Map();
for (const [name, rules] of dead) {
  for (const rule of rules) {
    const key = rule.file;
    byFile.set(key, (byFile.get(key) ?? 0) + 1);
  }
}

process.stdout.write(`未引用类 ${dead.length} 个，涉及规则 ${dead.reduce((n, [, rules]) => n + rules.length, 0)} 条\n\n`);
process.stdout.write('按文件分布：\n');
for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${file.padEnd(16)} ${count} 条规则\n`);
}

process.stdout.write('\n逐个类（类名 | 规则数 | 首次出现的选择器）：\n');
for (const [name, rules] of [...dead].sort((a, b) => a[0].localeCompare(b[0]))) {
  process.stdout.write(`  .${name.padEnd(24)} ${String(rules.length).padStart(2)}  ${rules[0].file}  ${rules[0].selector}\n`);
}
