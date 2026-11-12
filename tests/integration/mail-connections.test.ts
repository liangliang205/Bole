import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Ledger } from '../../src/core/ledger.ts';
import { SkillStore } from '../../src/skills/store.ts';
import { MailAdapterStore } from '../../src/mail/adapters.ts';
import { mailConnections, requireMailConnection } from '../../src/web/mail-connections.ts';
import { setupTempEnv } from '../helpers/env.ts';

test('邮箱连接随关联 Skill 的安装、停用和删除更新，独立 CLI 不受影响', async () => {
  const env = await setupTempEnv();
  const ledger = new Ledger(path.join(env.dir, 'connections.db'));
  try {
    const skills = new SkillStore(ledger);
    assert.deepEqual(mailConnections(ledger).adapters, []);
    assert.throws(() => requireMailConnection(ledger), /邮箱连接不可用/);
    const mail = skills.save({ id: 'agently-mail', name: 'Mail', content: 'Mail instructions' });
    assert.deepEqual(mailConnections(ledger).adapters, [], '安装任何 Skill 都不会创建预设的服务商连接');
    assert.throws(() => requireMailConnection(ledger, mail.id), /邮箱连接不可用/);
    skills.save({ id: mail.id, name: mail.name, content: mail.content, enabled: false }, mail.revision);
    assert.deepEqual(mailConnections(ledger).adapters, []);
    assert.throws(() => requireMailConnection(ledger), /邮箱连接不可用/);
    const disabled = skills.list()[0]!;
    skills.save({ id: mail.id, name: mail.name, content: mail.content, enabled: true }, disabled.revision);
    assert.equal(mailConnections(ledger).adapters.length, 0);
    skills.remove(mail.id);
    assert.deepEqual(mailConnections(ledger).adapters, []);
    assert.throws(() => requireMailConnection(ledger, mail.id), /邮箱连接不可用/);

    const other = skills.save({ id: 'other-mail', name: 'Other Mail', content: 'Other instructions' });
    const definition = { id: 'linked', name: 'Linked Mail', skillId: other.id, command: 'unused-cli',
      operations: Object.fromEntries(['identity', 'search', 'read', 'download', 'send'].map((op) => [op, { args: [op] }])),
      fields: { email: 'email', items: 'items', messageId: 'id', sender: 'from', attachments: 'files', attachmentId: 'id', filename: 'name', savedPath: 'path' } };
    const adapters = new MailAdapterStore(ledger);
    adapters.save(definition);
    adapters.save({ ...definition, id: 'standalone', skillId: undefined });
    assert.throws(() => requireMailConnection(ledger), /邮箱连接不可用/, '新任务必须显式选择邮箱，不默认指定服务商');
    assert.equal(requireMailConnection(ledger, 'linked')?.skillId, other.id);
    skills.save({ id: other.id, name: other.name, content: other.content, enabled: false }, other.revision);
    assert.throws(() => requireMailConnection(ledger, 'linked'), /邮箱连接不可用/);
    skills.remove(other.id);
    assert.deepEqual(mailConnections(ledger).adapters.map((a) => a.id), ['standalone']);
    assert.equal(requireMailConnection(ledger, 'standalone')?.id, 'standalone');
    assert.equal(adapters.list().length, 2, '删除 Skill 不销毁邮箱配置');
  } finally { ledger.close(); await env.restore(); }
});
