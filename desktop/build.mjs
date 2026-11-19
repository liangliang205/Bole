/**
 * desktop 构建脚本：
 *   node build.mjs --dev    → esbuild 打包 main/preload 到 out/，然后启动 electron
 *   node build.mjs          → 只构建（打包用，之后接 electron-builder）
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const dev = process.argv.includes('--dev');
const here = import.meta.dirname;

mkdirSync(path.join(here, 'out'), { recursive: true });

await build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  outfile: path.join(here, 'out', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(here, 'src', 'preload.ts')],
  outfile: path.join(here, 'out', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

copyFileSync(path.join(here, 'src', 'splash.html'), path.join(here, 'out', 'splash.html'));

if (!dev) process.exit(0);

const child = spawn(electronPath, [path.join(here, 'out', 'main.cjs')], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
child.on('exit', (code) => process.exit(code ?? 0));
