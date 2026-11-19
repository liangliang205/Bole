import { copyFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** 把旧的全局样式表复制成前端侧的样式源，并提示是否与原表一致。 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const source = path.join(repoRoot, 'src', 'web', 'public', 'styles.css');
const target = path.join(repoRoot, 'frontend', 'src', 'styles', 'bole.css');

const sourceText = await readFile(source, 'utf8');
let previous = null;
try {
  previous = await readFile(target, 'utf8');
} catch {
  previous = null;
}

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);

if (previous !== null && previous !== sourceText) {
  process.stdout.write('警告：目标样式与源样式不同，已用源覆盖。迁移期目标只能是源的副本。\n');
}
process.stdout.write(`已同步 ${source} -> ${target}（${sourceText.split('\n').length} 行）\n`);
