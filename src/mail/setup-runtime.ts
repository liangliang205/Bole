import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { mailEnvironment } from './client.ts';

const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*(?:@[a-zA-Z0-9_.^~+-]+)?$/);
type Cli = { command: string; baseArgs: string[]; package: string };
export interface MailAuthorizationStatus { state: 'missing' | 'waiting' | 'completed' | 'failed'; urls: string[]; error?: string; message?: string }
type Auth = { child: ChildProcess; timer: NodeJS.Timeout; state: 'waiting' | 'completed' | 'failed'; urls: string[]; error?: string; output: string };
function authorizationError(output: string, exitCode: number | null): string {
  const match = output.match(/"message"\s*:\s*("(?:\\.|[^"\\])*")/);
  let detail = '';
  if (match) {
    try { detail = String(JSON.parse(match[1])).replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\b(?:access|refresh|id)[_-]?token\s*[=:]\s*\S+/gi, 'token=[已隐藏]').slice(0, 500); }
    catch { /* Fall back to the exit code. */ }
  }
  return `授权未完成${detail ? `：${detail}` : ''}（退出码 ${exitCode}）；未自动重试。`;
}
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[省略]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|password|secret|credential|authorization/i.test(key) ? '[已隐藏]' : redact(item, depth + 1)]));
  return typeof value === 'string' ? value.slice(0, 4000) : value;
}
function run(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { cwd, env, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) {
      let detail = '';
      try { const parsed = JSON.parse(stdout) as { error?: { message?: string } }; if (typeof parsed.error?.message === 'string') detail = parsed.error.message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 500); } catch { /* Not a structured CLI error. */ }
      reject(new Error(`CLI 操作失败或超时${detail ? '：' + detail : '，请检查软件源和运行环境'}；系统未自动重试`));
    } else resolve(stripVTControlCharacters(stdout).slice(0, 20000));
  }));
}

/** No shell execution. OAuth stays alive between chat turns and never returns tokens. */
export class MailSetupRuntime {
  private auth = new Map<string, Auth>();
  readonly dataDir: string;
  constructor(dataDir: string) { this.dataDir = dataDir; }
  async install(input: string): Promise<Cli[]> {
    const pkg = packageName.parse(input);
    const dir = path.join(this.dataDir, 'mail-clis', createHash('sha256').update(pkg).digest('hex').slice(0, 20));
    await mkdir(dir, { recursive: true });
    const require = createRequire(import.meta.url);
    const npm = path.join(path.dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js');
    await run(process.execPath, [npm, 'install', '--prefix', dir, '--no-audit', '--no-fund', '--', pkg]);
    const name = pkg.replace(/@[^/]+$/, '');
    const packageDir = path.join(dir, 'node_modules', name);
    const metadata = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const bins = typeof metadata.bin === 'string' ? [metadata.bin] : Object.values(metadata.bin ?? {});
    if (!bins.length) throw new Error('安装的包没有可执行 CLI，请提供正确的软件包');
    const root = await realpath(packageDir);
    return Promise.all(bins.slice(0, 8).map(async (bin) => {
      const file = await realpath(path.resolve(packageDir, bin));
      if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file))) throw new Error('CLI 入口超出安装目录');
      const header = (await readFile(file)).subarray(0, 100).toString('utf8');
      const nodeScript = /\.[cm]?js$/i.test(file) || /^#!.*\bnode\b/.test(header);
      return { package: pkg, command: nodeScript ? process.execPath : file, baseArgs: nodeScript ? [file] : [] };
    }));
  }
  async help(cli: Cli, args: string[]): Promise<string> {
    const identity = /^(?:\+me|whoami|identity|me|account show|profile get|auth status)(?: --(?:json|format=json|output=json))?$/i.test(args.join(' '));
    if (!args.length || (!identity && !args.some((arg) => ['--help', '-h', '--version', '--print-output-schema'].includes(arg))) || args.some((arg) => /[\r\n]/.test(arg))) throw new Error('仅支持 CLI 帮助、输出字段说明或只读身份查询；登录请使用 start_mail_authorization，收取简历请使用 start_mail_screening');
    const output = await run(cli.command, [...cli.baseArgs, ...args]);
    if (!identity) return output;
    try { return JSON.stringify(redact(JSON.parse(output))); }
    catch { throw new Error('身份查询未返回 JSON，请根据插件文档配置身份查询接口'); }
  }
  async startAuth(key: string, cli: Cli, args: string[], restart = false) {
    const previous = this.auth.get(key);
    if (previous?.state === 'waiting' || previous && !restart) return this.authStatus(key);
    if (previous) this.auth.delete(key);
    if (!/^(?:auth (?:login|authorize)|login|authorize|oauth (?:login|authorize))(?: |$)/i.test(args.join(' ')) || args.some((arg) => /[\r\n]/.test(arg))) throw new Error('只允许启动邮箱登录授权命令');
    const env = mailEnvironment();
    const payload = Buffer.from(JSON.stringify({ command: cli.command, args: [...cli.baseArgs, ...args], cwd: process.cwd() })).toString('base64url');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./pty-host.ts', import.meta.url)), payload], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const timer = setTimeout(() => {
      const current = this.auth.get(key);
      if (current?.state !== 'waiting') return;
      current.state = 'failed';
      current.error = '授权等待已超时；未自动重试。';
      current.output = '';
      current.child.kill();
    }, 300000);
    const state: Auth = { child, timer, state: 'waiting', urls: [], output: '' };
    this.auth.set(key, state);
    const collect = (chunk: Buffer) => {
      state.output = stripVTControlCharacters((state.output + chunk.toString()).slice(-20000));
      state.urls = [...new Set(state.output.match(/https:\/\/[^\s<>"']+/g) ?? [])].slice(0, 5);
    };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.on('error', () => { clearTimeout(state.timer); state.state = 'failed'; state.error = '授权进程启动失败，请检查 CLI 环境；未自动重试。'; });
    child.on('close', (exitCode) => {
      clearTimeout(state.timer);
      if (state.state !== 'failed') state.state = exitCode === 0 ? 'completed' : 'failed';
      if (state.state === 'failed') state.error ??= authorizationError(state.output, exitCode);
      state.output = '';
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return this.authStatus(key);
  }
  authStatus(key: string): MailAuthorizationStatus {
    const state = this.auth.get(key);
    return state ? { state: state.state, urls: state.state === 'waiting' ? state.urls : [], error: state.error, message: '授权进程结束后还需检查邮箱身份，不能据此宣称连接成功。' } : { state: 'missing', urls: [], message: '尚无授权进程；服务重启后请先检查邮箱连接，不会自动重复授权。' };
  }
  close() { for (const state of this.auth.values()) { clearTimeout(state.timer); if (state.state === 'waiting') state.child.kill(); } this.auth.clear(); }
}
