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

const files = walk('frontend/src').filter((file) => file.endsWith('.tsx'));
let total = 0;
let dead = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // 抓取每个 <button ...> 的起始片段（到第一个 > 结束，允许跨行）
  for (const match of text.matchAll(/<button\b[\s\S]*?>/g)) {
    total += 1;
    const tag = match[0];
    const hasClick = /onClick=|onPointerDown=|onMouseDown=/.test(tag);
    const isSubmit = /type="submit"/.test(tag);
    const isReset = /type="reset"/.test(tag);
    const viaProps = /\{\.\.\.[^}]*\}/.test(tag); // 展开 props 可能携带事件
    if (!hasClick && !isSubmit && !isReset && !viaProps) {
      dead += 1;
      const line = text.slice(0, match.index).split('\n').length;
      const id = /id="([^"]+)"/.exec(tag)?.[1] ?? '';
      const textContent = tag.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      process.stdout.write(`${path.basename(file)}:${line}  id=${id || '—'}  ${textContent}\n`);
    }
  }
}

process.stdout.write(`\n共 ${total} 个 button，其中 ${dead} 个没有任何事件绑定\n`);
