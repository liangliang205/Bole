import path from 'node:path';
import { resolvePaths } from '../config.ts';
import { SecretBox } from '../mcp/secret-box.ts';
import { readJsonSafe, writeJson } from '../util/fsx.ts';

export interface MailAccount {
  id: string;
  vendor: string;
  user: string;
  password: string;
  host?: string;
  port?: number;
}

type AccountsFile = Record<string, string>;

function filePath(): string {
  return path.join(resolvePaths().dataDir, 'mail', 'accounts.json');
}

async function loadSealed(): Promise<AccountsFile> {
  return (await readJsonSafe<AccountsFile>(filePath())) ?? {};
}

/** 列表只返回非敏感字段；密码只在 loadAccount 时解密。 */
export async function listAccounts(): Promise<Array<Omit<MailAccount, 'password'>>> {
  const sealed = await loadSealed();
  const box = new SecretBox(resolvePaths().dataDir);
  const out: Array<Omit<MailAccount, 'password'>> = [];
  for (const id of Object.keys(sealed)) {
    const value = sealed[id];
    if (!value) continue;
    const account = await box.open<MailAccount>(value);
    out.push({
      id,
      vendor: account.vendor,
      user: account.user,
      ...(account.host ? { host: account.host } : {}),
      ...(account.port ? { port: account.port } : {}),
    });
  }
  return out;
}

export async function loadAccount(id: string): Promise<MailAccount> {
  const sealed = await loadSealed();
  const value = sealed[id];
  if (!value) throw new Error(`邮箱账号未配置：${id}（运行 bole mail-account add 创建）`);
  return await new SecretBox(resolvePaths().dataDir).open<MailAccount>(value);
}

export async function saveAccount(account: MailAccount): Promise<void> {
  const sealed = await loadSealed();
  sealed[account.id] = await new SecretBox(resolvePaths().dataDir).seal(account);
  await writeJson(filePath(), sealed);
}

export async function removeAccount(id: string): Promise<void> {
  const sealed = await loadSealed();
  if (!(id in sealed)) throw new Error(`邮箱账号不存在：${id}`);
  delete sealed[id];
  await writeJson(filePath(), sealed);
}