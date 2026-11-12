import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

export type MailCommand = (args: string[], cwd?: string) => Promise<unknown>;
const envelope = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ message: z.string() }).passthrough().optional() }).passthrough();

/** OAuth credentials are workspace-scoped. Do not let the server's launcher select another account store. */
export function mailEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const workspace = env.BOLE_MAIL_WORKSPACE?.trim() || env.AGENTLY_WORKSPACE?.trim() || 'codex';
  return { ...env, AGENTLY_WORKSPACE: workspace };
}

/** Run the packaged native binary directly: no shell, command interpolation or credential copying. */
let mailQueue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
export const mailCommand: MailCommand = (args, cwd) => {
  const pending = mailQueue.catch(() => undefined).then(async () => {
    // The current account permits 10 requests/minute. Share admission across jobs.
    await delay(Math.max(0, 6500 - (Date.now() - lastCallAt)));
    lastCallAt = Date.now();
    return runCommand(args, cwd);
  });
  mailQueue = pending;
  return pending;
};

function runCommand(args: string[], cwd?: string): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const launcher = require('@tencent-qqmail/agently-cli/scripts/run.js') as { getBinaryPath(): string };
  return new Promise((resolve, reject) => {
    execFile(launcher.getBinaryPath(), args, { cwd, env: mailEnvironment(), windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      try {
        const result = envelope.parse(JSON.parse(stdout));
        if (error || !result.ok) {
          const message = result.error?.message ?? `Agent Mail CLI 失败（${error?.code ?? 'unknown'}）`;
          reject(new Error(error?.code === 3 || /authorization required|not logged in/i.test(message)
            ? `${message}：邮箱授权工作区为 ${mailEnvironment().AGENTLY_WORKSPACE}。请在相同工作区完成 agently-cli auth login 后重试；启用 Skill 不等于邮箱已授权。`
            : message)); return;
        }
        resolve(result.data);
      } catch { reject(new Error(error ? `Agent Mail CLI 未完成（${error.code ?? '进程中断'}），请检查授权与连接；发送结果需核对已发送邮箱` : 'Agent Mail CLI 返回了无效数据')); }
    });
  });
}

export async function mailboxIdentity(command: MailCommand = mailCommand): Promise<string> {
  const me = z.object({ aliases: z.array(z.object({ email: z.email(), is_primary: z.boolean().optional() })) }).parse(await command(['+me']));
  const alias = me.aliases.find((a) => a.is_primary) ?? me.aliases[0];
  if (!alias) throw new Error('招聘邮箱没有可用地址，请先完成 agently-cli auth login');
  return alias.email;
}
