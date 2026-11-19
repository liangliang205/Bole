/**
 * desktop 构建脚本：
 *   node build.mjs --dev    → esbuild 打包 main/preload，然后启动 electron
 *   node build.mjs --dist   → esbuild + 检查 staging + electron-builder 出安装包
 */
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const dev = process.argv.includes('--dev');
const dist = process.argv.includes('--dist');
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

if (dist) {
  const staging = path.join(here, 'staging', 'server');
  if (!existsSync(staging)) {
    process.stderr.write('缺少 desktop/staging/server，请先运行：node prepare-server.mjs\n');
    process.exit(1);
  }
  const builder = spawnSync(
    process.execPath,
    [path.join(here, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', 'dir', '--config', path.join(here, 'electron-builder.yml')],
    { cwd: here, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
  );
  process.exit(builder.status ?? 1);
}

if (!dev) process.exit(0);

const child = spawn(electronPath, [path.join(here, 'out', 'main.cjs')], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
child.on('exit', (code) => process.exit(code ?? 0));
