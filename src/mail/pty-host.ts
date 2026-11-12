import { spawn } from 'node-pty';

interface Payload { command: string; args: string[]; cwd: string }

function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(2);
}

let payload: Payload;
try {
  payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8')) as Payload;
  if (!payload.command || !Array.isArray(payload.args) || !payload.cwd) fail('无效的认证终端参数');
} catch {
  fail('无法解析认证终端参数');
}

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const terminal = spawn(payload.command, payload.args, {
  name: 'xterm-color', cols: 120, rows: 30, cwd: payload.cwd, env, useConpty: process.platform === 'win32',
});
terminal.onData((data) => process.stdout.write(data));
terminal.onExit(({ exitCode }) => process.exit(exitCode));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { try { terminal.kill(); } finally { process.exit(1); } });
