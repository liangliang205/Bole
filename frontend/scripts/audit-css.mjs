import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = 'frontend/src';
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const files = walk(root);
const cssFiles = files.filter((f) => f.endsWith('.css'));
const codeFiles = files.filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

const declared = new Map();
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const match of text.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    const name = match[1];
    if (!declared.has(name)) declared.set(name, path.basename(file));
  }
}

// 在整个源码文本里找类名出现（不只 className 属性），避免把动态拼的类判成死代码
const usage = new Map(); // class -> Set(component file)
for (const file of codeFiles) {
  const text = readFileSync(file, 'utf8');
  for (const [name] of declared) {
    if (new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(text)) {
      const set = usage.get(name) ?? new Set();
      set.add(path.basename(file));
      usage.set(name, set);
    }
  }
}

const used = [...usage.keys()];
const unused = [...declared.keys()].filter((name) => !usage.has(name)).sort();
const shared = [...usage.entries()].filter(([, set]) => set.size > 1).map(([name, set]) => [name, set.size]);
const exclusive = [...usage.entries()].filter(([, set]) => set.size === 1);

process.stdout.write(`声明类 ${declared.size}；源码中出现 ${used.length}；未出现（候选死 CSS）${unused.length}\n`);
process.stdout.write(`跨文件共用 ${shared.length}；被单一文件使用 ${exclusive.length}\n\n`);

process.stdout.write('未被任何源码引用的类（前 40）：\n');
process.stdout.write(`${unused.slice(0, 40).join(' ')}\n\n`);

process.stdout.write('独占类最多的文件（可优先模块化的候选）：\n');
const byFile = new Map();
for (const [name, set] of exclusive) {
  const file = [...set][0];
  byFile.set(file, [...(byFile.get(file) ?? []), name]);
}
for (const [file, names] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  process.stdout.write(`  ${file.padEnd(26)} ${String(names.length).padStart(3)} 个：${names.slice(0, 6).join(' ')}${names.length > 6 ? ' …' : ''}\n`);
}
