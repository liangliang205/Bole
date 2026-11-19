/**
 * 把服务端 + 前端产物 staging 到 desktop/staging/server，供 electron-builder 打进 resources/server。
 * 步骤：复制源码 → 装生产依赖 → 剪枝跨平台二进制 → 打包冒烟（readyz / 静态 / ocr / pty）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const stagingRoot = path.join(import.meta.dirname, 'staging');
const serverDir = path.join(stagingRoot, 'server');
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        total += statSync(full).size;
        files += 1;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { mb: total / 1024 / 1024, files };
}

// ---------- 1. 重建 staging（保留已下载的 ocr）----------
const ocrDir = path.join(serverDir, 'ocr');
const ocrBackup = path.join(stagingRoot, 'ocr-cache');
if (existsSync(ocrDir)) {
  rmSync(ocrBackup, { recursive: true, force: true });
  cpSync(ocrDir, ocrBackup, { recursive: true });
  log('暂存 ocr 目录');
}
rmSync(serverDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });
log(`重建 ${serverDir}`);
if (existsSync(ocrBackup)) {
  mkdirSync(serverDir, { recursive: true });
  cpSync(ocrBackup, path.join(serverDir, 'ocr'), { recursive: true });
  log('恢复 ocr 目录');
}

for (const item of ['src', 'config', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']) {
  const from = path.join(repoRoot, item);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(serverDir, item), { recursive: true });
  log(`复制 ${item}`);
}

// 前端产物：服务端默认找 <root>/frontend/dist，这里换成 web/ 并用 BOLE_WEB_DIR 指过去
const distDir = path.join(repoRoot, 'frontend', 'dist');
if (existsSync(distDir)) {
  cpSync(distDir, path.join(serverDir, 'web'), { recursive: true });
  log('复制 frontend/dist → web/');
} else {
  log('警告：frontend/dist 不存在，请先 pnpm web:build');
}

// ---------- 2. 安装生产依赖 ----------
log('安装生产依赖（pnpm install --prod --frozen-lockfile）…');
const install = spawnSync(pnpm, ['install', '--prod', '--frozen-lockfile', '--node-linker=hoisted', '--ignore-scripts=false'], {
  cwd: serverDir,
  stdio: 'inherit',
  shell: isWindows,
});
if (install.status !== 0) {
  log(`依赖安装失败（exit ${install.status}）`);
  process.exit(1);
}

// ---------- 3. 剪枝 ----------
const pruneTargets = [
  '@deepseek-ai+libreoffice-kit-wasm',
  '@deepseek-ai+libreoffice-kit-darwin-arm64',
  '@deepseek-ai+libreoffice-kit-darwin-x64',
  '@deepseek-ai+libreoffice-kit-win32-arm64',
  '@tencent-qqmail+agently-cli-darwin-arm64',
  '@tencent-qqmail+agently-cli-darwin-x64',
  '@tencent-qqmail+agently-cli-linux-arm64',
  '@tencent-qqmail+agently-cli-linux-x64',
  '@napi-rs+canvas-darwin-arm64',
  '@napi-rs+canvas-darwin-x64',
  '@napi-rs+canvas-linux-arm64',
  '@napi-rs+canvas-linux-x64',
  '@napi-rs+canvas-win32-arm64',
];

const pnpmDir = path.join(serverDir, 'node_modules', '.pnpm');
const hoisted = !existsSync(pnpmDir);
if (hoisted) {
  const modules = path.join(serverDir, 'node_modules');
  const hoistedTargets = [
    '@deepseek-ai/libreoffice-kit-wasm',
    '@deepseek-ai/libreoffice-kit-darwin-arm64',
    '@deepseek-ai/libreoffice-kit-darwin-x64',
    '@deepseek-ai/libreoffice-kit-win32-arm64',
    '@tencent-qqmail/agently-cli-darwin-arm64',
    '@tencent-qqmail/agently-cli-darwin-x64',
    '@tencent-qqmail/agently-cli-linux-arm64',
    '@tencent-qqmail/agently-cli-linux-x64',
    '@napi-rs/canvas-darwin-arm64',
    '@napi-rs/canvas-darwin-x64',
    '@napi-rs/canvas-linux-arm64',
    '@napi-rs/canvas-linux-x64',
    '@napi-rs/canvas-win32-arm64',
  ];
  for (const target of hoistedTargets) {
    const full = path.join(modules, target);
    if (!existsSync(full)) continue;
    const { mb } = dirSize(full);
    rmSync(full, { recursive: true, force: true });
    log(`pruned ${target} (${mb.toFixed(1)} MB)`);
  }
}
if (!hoisted) {
  for (const entry of readdirSync(pnpmDir)) {
    if (!pruneTargets.some((target) => entry.startsWith(target))) continue;
    const full = path.join(pnpmDir, entry);
    const { mb } = dirSize(full);
    rmSync(full, { recursive: true, force: true });
    log(`pruned ${entry} (${mb.toFixed(1)} MB)`);
  }
}

// 删掉跨平台 prebuilds（只留 win32-x64）
const ptyDir = path.join(pnpmDir);
if (existsSync(ptyDir)) {
  for (const entry of readdirSync(ptyDir)) {
    if (!entry.startsWith('node-pty@')) continue;
    const prebuilds = path.join(ptyDir, entry, 'node_modules', 'node-pty', 'prebuilds');
    if (!existsSync(prebuilds)) continue;
    for (const platform of readdirSync(prebuilds)) {
      if (platform === 'win32-x64') continue;
      const full = path.join(prebuilds, platform);
      const { mb } = dirSize(full);
      rmSync(full, { recursive: true, force: true });
      log(`pruned node-pty/prebuilds/${platform} (${mb.toFixed(1)} MB)`);
    }
  }
}

// 清理悬空符号链接（顶层包名指向已删的 .pnpm 目录）
const topModules = path.join(serverDir, 'node_modules');
if (existsSync(topModules)) {
  for (const entry of readdirSync(topModules)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(topModules, entry);
    let isLink = false;
    try {
      isLink = statSync(full, { throwIfNoEntry: false }) === undefined;
    } catch {
      isLink = true;
    }
    if (isLink) {
      rmSync(full, { recursive: true, force: true });
      log(`pruned dangling link ${entry}`);
    }
  }
}

const size = dirSize(serverDir);
log(`staging 体积 ${size.mb.toFixed(0)} MB / ${size.files} 个文件`);

// ---------- 4. 冒烟 ----------
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
};

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
  BOLE_ROOT: serverDir,
  BOLE_WEB_DIR: path.join(serverDir, 'web'),
  BOLE_DATA_DIR: path.join(stagingRoot, 'smoke-data'),
  BOLE_RUNS: path.join(stagingRoot, 'smoke-runs'),
};
rmSync(env.BOLE_DATA_DIR, { recursive: true, force: true });
rmSync(env.BOLE_RUNS, { recursive: true, force: true });

const child = spawn(process.execPath, [path.join(serverDir, 'src', 'cli', 'index.ts'), 'web', '--port', '18787', '--host', '127.0.0.1'], {
  cwd: serverDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

const started = Date.now();
let url = null;
await new Promise((resolve) => {
  const onData = (chunk) => {
    const text = String(chunk);
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(text);
    if (match && !url) {
      url = match[0];
      resolve();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', () => resolve());
  setTimeout(resolve, 90_000);
});

if (!url) {
  record('readyz', false, '服务端没有打印启动 URL');
} else {
  let readyzOk = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${url}/readyz`);
      if (response.status === 200) { readyzOk = true; break; }
    } catch {
      // 继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  record('readyz', readyzOk, `等 ${Date.now() - started}ms 仍非 200`);

  try {
    const response = await fetch(`${url}/`);
    const html = await response.text();
    record('static', response.status === 200 && html.includes('id="root"'), `status=${response.status}`);
  } catch (error) {
    record('static', false, String(error));
  }
}

child.kill();
await new Promise((resolve) => setTimeout(resolve, 300));

const ocrFiles = ['chi_sim.traineddata.gz', 'eng.traineddata.gz'];
const ocrSmokeDir = path.join(serverDir, 'ocr');
const ocrPresent = ocrFiles.filter((file) => existsSync(path.join(ocrSmokeDir, file)));
record('ocr', ocrPresent.length === ocrFiles.length, `缺少 ${ocrFiles.filter((f) => !ocrPresent.includes(f)).join(', ')}`);

// pty 探测（子进程里直接 require，验证 staging 的 node-pty 可用）
const ptyResolvable = spawnSync(process.execPath, ['-e', "try{require.resolve('node-pty',{paths:[process.cwd()]});console.log('resolvable')}catch{process.exit(4)}"], {
  cwd: serverDir,
  encoding: 'utf8',
  timeout: 10_000,
});
const ptyProbe = String(ptyResolvable.stdout ?? '').includes('resolvable') ? spawnSync(process.execPath, ['-e', "const p=require('node-pty'); const t=p.spawn(process.env.COMSPEC||'cmd.exe',['/c','echo ptyok'],{cols:80,rows:24}); t.onData(d=>{if(String(d).includes('ptyok')){console.log('pty ok');process.exit(0)}}); setTimeout(()=>process.exit(3),8000)"], {
  cwd: serverDir,
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  timeout: 20_000,
}) : { stdout: '', stderr: '服务端目录里没有 node-pty（后端未直接依赖它，属于可选能力）' };
record('pty', String(ptyProbe.stdout ?? '').includes('pty ok'), String(ptyProbe.stderr ?? '').slice(0, 200));

const passed = results.filter((item) => item.ok).length;
log(`\n${passed}/${results.length} 冒烟通过`);
process.exit(passed === results.length ? 0 : 1);
