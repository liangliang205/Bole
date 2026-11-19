import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * electron-builder 的 extraResources 会过滤掉 node_modules，
 * 而服务端是"源码 + 生产依赖"直接运行的（node-pty/koffi 等原生模块无法打包成单文件）。
 * 这里在打包后把 staging 的依赖目录补进 resources/server。
 */
export default async function afterPack(context) {
  const here = import.meta.dirname;
  const source = path.join(here, 'staging', 'server');
  const target = path.join(context.appOutDir, 'resources', 'server');
  if (!existsSync(source)) {
    process.stderr.write(`[after-pack] 缺少 ${source}\n`);
    return;
  }
  let copied = 0;
  for (const entry of ['node_modules', 'ocr', 'web', 'src', 'config', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) {
    const from = path.join(source, entry);
    if (!existsSync(from)) continue;
    const to = path.join(target, entry);
    cpSync(from, to, { recursive: true, dereference: true, force: true });
    copied += 1;
  }
  const size = dirSize(target);
  process.stdout.write(`[after-pack] 补齐 ${copied} 项 → ${target}（${size.toFixed(0)} MB）\n`);
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile()) total += statSync(full).size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total / 1024 / 1024;
}
