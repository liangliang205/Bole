import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mailEnvironment } from '../../src/mail/client.ts';

test('邮箱 OAuth 工作区不随 Codex 或终端启动环境漂移，子进程收到固定工作区', () => {
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_') && !key.startsWith('AGENTLY_') && key !== 'BOLE_MAIL_WORKSPACE'));
  const inspect = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.AGENTLY_WORKSPACE || "default")'], { env: mailEnvironment(env), windowsHide: true, encoding: 'utf8' });
  assert.equal(inspect(isolated), 'codex');
  assert.equal(inspect({ ...isolated, CODEX_THREAD_ID: 'test-thread' }), 'codex');
  assert.equal(inspect({ ...isolated, BOLE_MAIL_WORKSPACE: 'custom', AGENTLY_WORKSPACE: 'other' }), 'custom');
});
