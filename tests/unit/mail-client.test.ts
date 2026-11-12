import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mailEnvironment } from '../../src/mail/client.ts';

test('邮箱 OAuth 使用 BoLe 独立工作区，不随 Codex 或终端启动环境漂移', () => {
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_') && !key.startsWith('AGENTLY_') && key !== 'BOLE_MAIL_WORKSPACE'));
  const inspect = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.AGENTLY_WORKSPACE || "default")'], { env: mailEnvironment(env), windowsHide: true, encoding: 'utf8' });
  assert.equal(inspect(isolated), 'bole');
  assert.equal(inspect({ ...isolated, CODEX_THREAD_ID: 'test-thread' }), 'bole');
  assert.equal(inspect({ ...isolated, BOLE_MAIL_WORKSPACE: 'custom', AGENTLY_WORKSPACE: 'other' }), 'custom');
  assert.match(String(mailEnvironment({ ...isolated }).AGENTLY_CLI_CONFIG_DIR), /[\\/]data[\\/]mail-auth$/);
  assert.equal(mailEnvironment({ ...isolated, BOLE_MAIL_AUTH_DIR: 'D:\\private-mail' }).AGENTLY_CLI_CONFIG_DIR, 'D:\\private-mail');
});
