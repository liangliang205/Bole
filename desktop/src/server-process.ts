import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseServerUrl } from './launch-url.ts';
import { pickLogPath } from './log-file.ts';

export interface StartInput {
  serverDir: string;
  entry: string;
  dataDir: string;
  runsDir: string;
  logDir: string;
  port: number;
  shutdownToken: string;
}

export interface RunningServer {
  url: string;
  stop: (timeoutMs?: number) => Promise<void>;
  onExit: (cb: (code: number | null) => void) => void;
}

const STDERR_TAIL = 40;

/** 开发态直接用仓库；打包后服务端被 staged 到 resources/server。
 *  bundleDir 是构建产物目录（out/）：开发态退两级到仓库根，打包态在其同级 server/。 */
export function resolveServerLayout(isPackaged: boolean, bundleDir: string): { serverDir: string; entry: string } {
  const serverDir = isPackaged
    ? path.join(bundleDir, '..', '..', 'server')
    : path.resolve(bundleDir, '..', '..');
  // 打包态同样直接跑 TS：Electron 的 Node 支持原生类型擦除，staging 里没有 main.cjs。
  const entry = path.join(serverDir, 'src', 'cli', 'index.ts');
  return { serverDir, entry };
}

export async function startServer(input: StartInput): Promise<RunningServer> {
  mkdirSync(input.logDir, { recursive: true });
  mkdirSync(input.dataDir, { recursive: true });
  mkdirSync(input.runsDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BOLE_ROOT: input.serverDir,
    BOLE_DATA_DIR: input.dataDir,
    BOLE_RUNS: input.runsDir,
    BOLE_SHUTDOWN_TOKEN: input.shutdownToken,
    BOLE_OCR_MODE: process.env.BOLE_OCR_MODE ?? 'deepseek',
  };
  const ocrDir = path.join(input.serverDir, 'ocr');
  if (existsSync(ocrDir)) env.BOLE_OCR_DIR = ocrDir;
  // 打包后前端产物在 <serverDir>/web（staging 时从 frontend/dist 拷入）
  const webDir = path.join(input.serverDir, 'web');
  if (existsSync(webDir)) env.BOLE_WEB_DIR = webDir;

  const child: ChildProcess = spawn(process.execPath, [input.entry, 'web', '--port', String(input.port), '--host', '127.0.0.1'], {
    cwd: input.serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  console.error('[bole] server spawn', { entry: input.entry, cwd: input.serverDir, port: input.port });
  const stderrTail: string[] = [];
  let exited: number | null | undefined;
  const exitCallbacks: ((code: number | null) => void)[] = [];

  const log = (line: string): void => {
    const file = pickLogPath(input.logDir, sizeOf(dirLogPath(input.logDir)), new Date());
    try {
      appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      // 日志失败不能影响启动
    }
  };

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const out = readline.createInterface({ input: child.stdout! });
    out.on('line', (line) => {
      log(line);
      const found = parseServerUrl(line);
      if (found) settle(() => resolve(found));
    });

    const err = readline.createInterface({ input: child.stderr! });
    err.on('line', (line) => {
      log(line);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
    });

    child.once('exit', (code) => {
      exited = code;
      for (const callback of exitCallbacks) callback(code);
      settle(() => reject(Object.assign(new Error(`服务端进程退出（code=${code}）\n${stderrTail.join('\n')}`), { code, stderrTail })));
    });
    child.once('error', (error) => settle(() => reject(error)));
  });

  return {
    url,
    onExit: (callback) => {
      if (exited !== undefined) callback(exited);
      else exitCallbacks.push(callback);
    },
    stop: async (timeoutMs = 15_000): Promise<void> => {
      if (exited !== undefined) return;
      const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        await fetch(`${url}/api/shutdown`, {
          method: 'POST',
          headers: { 'x-bole-token': input.shutdownToken },
        }).catch(() => undefined);
      } catch {
        // 服务端可能已退出
      }
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      const raced = await Promise.race([done.then(() => 'exited' as const), timeout.then(() => 'timeout' as const)]);
      if (raced === 'timeout') {
        child.kill();
        await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      }
    },
  };
}

function dirLogPath(dir: string): string {
  return pickLogPath(dir, 0, new Date());
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
