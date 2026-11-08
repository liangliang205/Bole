import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveMailAdapter } from '../../src/mail/adapters.ts';
import { saveAccount } from '../../src/mail/accounts.ts';
import { setupTempEnv } from '../helpers/env.ts';

const fixture = fileURLToPath(new URL('../fixtures/mcp/mail-server.mjs', import.meta.url));

test('MCP 邮箱适配器：只读工具、主题与缓存路径校验、close', async () => {
  const env = await setupTempEnv();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-mcp-mail-'));
  try {
    await saveAccount({ id: 'fake', vendor: 'qq', user: 'hr@example.com', password: 'secret' });
    const adapter = resolveMailAdapter({
      kind: 'mcp',
      id: 'fake-mail',
      name: '测试邮箱',
      accountRef: 'fake',
      command: process.execPath,
      args: [fixture],
      callTimeoutMs: 30_000,
    });
    try {
      assert.equal(await adapter.identity(), 'hr@example.com');
      const page = (await adapter.search({ query: '' })) as { data: Array<{ message_id: string }> };
      assert.equal(page.data[0]?.message_id, '1726132069:125');
      const message = (await adapter.read('1726132069:125')) as {
        subject: string;
        from: { email: string };
        attachments: Array<{ attachment_id: string; filename: string }>;
      };
      assert.equal(message.from.email, 'candidate@example.com');
      assert.equal(message.subject, '应聘前端开发工程师');
      assert.equal(message.attachments[0]?.filename, 'resume.pdf');
      const saved = (await adapter.download('1726132069:125', '2', dir)) as { saved_to: string };
      assert.equal(saved.saved_to, 'resume.pdf');
      assert.match(await readFile(path.join(dir, 'resume.pdf'), 'utf8'), /^%PDF-1\.7/);
      await assert.rejects(adapter.send({ to: 'candidate@example.com', subject: 'x', body: 'x' }), /只读/);
    } finally {
      await adapter.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await env.restore();
  }
});
