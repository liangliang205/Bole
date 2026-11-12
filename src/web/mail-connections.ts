import type { Ledger } from '../core/ledger.ts';
import { MailAdapterStore } from '../mail/adapters.ts';
import { SkillStore } from '../skills/store.ts';

/** Available connections for new tasks; historical task snapshots remain intact. */
export function mailConnections(ledger: Ledger) {
  const skills = new SkillStore(ledger).list().filter((skill) => skill.enabled);
  const enabled = new Set(skills.map((skill) => skill.id));
  const adapters = new MailAdapterStore(ledger).list().filter((adapter) => !adapter.id.startsWith('run-mail-') && (!adapter.skillId || enabled.has(adapter.skillId)));
  return {
    adapters,
    skills: skills.map(({ id, name }) => ({ id, name })),
  };
}

export function requireMailConnection(ledger: Ledger, id?: string) {
  const connection = mailConnections(ledger).adapters.find((adapter) => adapter.id === id);
  if (!connection) throw new Error('邮箱连接不可用：请先安装并启用对应 Skill，或配置独立邮箱适配器');
  return connection;
}
