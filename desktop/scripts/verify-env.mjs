/**
 * M0 环境验证：Electron 里是否具备 Bole 运行所需的四项能力。
 * 用 ELECTRON_RUN_AS_NODE 走 Electron 自带的 Node，避免与系统 node 混淆。
 * 任一项失败即非零退出——此时应停止打包，回到设计里的 R1 处置。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const results = [];

function run(name, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(electronPath, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
  });
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  const ok = options.check ? options.check(stdout, stderr) : result.status === 0;
  results.push({ name, ok, detail: ok ? '' : (stderr || stdout).slice(0, 400) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? ` (${Date.now() - started}ms)` : `: ${(stderr || stdout).slice(0, 400)}`}\n`);
  return { stdout, stderr, status: result.status };
}

// 1. Node 版本 ≥ 24（后端用了 node:sqlite 与新语法）
run('node ≥ 24', ['-e', 'console.log(process.versions.node)'], {
  check: (stdout) => {
    const major = Number(stdout.split('.')[0]);
    return Number.isFinite(major) && major >= 24;
  },
});

// 2. node:sqlite 可用
run('node:sqlite', ['-e', "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); db.exec('create table t(a)'); console.log('sqlite ok')"], {
  check: (stdout) => stdout.includes('sqlite ok'),
});

// 3. 直接跑 .ts（Node 原生类型擦除）
{
  const dir = mkdtempSync(path.join(tmpdir(), 'bole-probe-'));
  const probe = path.join(dir, 'probe.ts');
  writeFileSync(probe, "const x: number = 1;\nconsole.log('ts ok', x);\n");
  run('运行 TypeScript', [probe], { check: (stdout) => stdout.includes('ts ok 1') });
  rmSync(dir, { recursive: true, force: true });
}

// 4. node-pty（后端 ConPTY 用）
run('node-pty', ['-e', "const p=require('node-pty'); const t=p.spawn(process.env.COMSPEC||'cmd.exe',['/c','echo ptyok'],{cols:80,rows:24}); t.onData(d=>{if(String(d).includes('ptyok')){console.log('pty ok');process.exit(0)}}); setTimeout(()=>{console.log('pty timeout');process.exit(3)},8000)"], {
  timeout: 20_000,
  check: (stdout) => stdout.includes('pty ok'),
});

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length > 0) {
  process.stdout.write(`失败项：${failed.map((item) => item.name).join(', ')}\n`);
  process.stdout.write('按计划：任一失败应停止打包，回到设计文档 §10 的 R1 处置。\n');
  process.exit(1);
}
