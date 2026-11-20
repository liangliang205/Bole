import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const codeFiles = walk('frontend/src').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
const used = new Set();
for (const file of codeFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/['"`]\/api\/[A-Za-z0-9_\-/${}.:]*/g)) {
    const raw = match[0].slice(1);
    if (raw.startsWith('/api/client')) continue;
    // 归一化模板变量为 :id
    const normalized = raw.replace(/\$\{[^}]*\}/g, ':id').replace(/\/$/, '');
    used.add(normalized);
  }
}

const server = walk('src').filter((f) => f.endsWith('.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');
// 服务端里所有出现的 /api/... 字面量（含正则形式）
const declared = new Set();
for (const match of server.matchAll(/\/api\/[A-Za-z0-9_\-]+/g)) declared.add(match[0]);

const missing = [...used].filter((p) => {
  // 逐段比较：把 :id 当通配
  const prefix = p.split('/').slice(0, 3).join('/');
  return ![...declared].some((d) => prefix.startsWith(d) || d.startsWith(prefix));
}).sort();

process.stdout.write(`前端调用的 /api 路径 ${used.size} 个\n`);
process.stdout.write(`服务端出现的 /api 前缀 ${declared.size} 个\n\n`);
if (missing.length === 0) process.stdout.write('没有发现前端调用但服务端不存在的接口\n');
else {
  process.stdout.write('疑似前端调用、服务端未声明的接口：\n');
  for (const item of missing) process.stdout.write(`  ${item}\n`);
}
