import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImapSession } from '../../src/mail-mcp/session.ts';

const PDF_LEAF = { part: '2', type: 'application', subtype: 'pdf', parameters: { name: '简历.pdf' }, disposition: 'attachment', size: 1_000 };
const TEXT_LEAF = { part: '1', type: 'text', subtype: 'plain' };

function fakeClient(uids: number[]) {
  const messages = new Map(
    uids.map((uid) => [uid, {
      uid,
      envelope: { subject: uid % 2 === 0 ? `应聘-${uid}` : `发票-${uid}`, from: [{ address: 'a@example.com' }] },
      bodyStructure: { type: 'multipart', childNodes: uid % 2 === 0 ? [TEXT_LEAF, PDF_LEAF] : [TEXT_LEAF] },
    }]),
  );
  return {
    usable: true,
    mailbox: { uidValidity: 777n },
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [...uids].reverse(),
    // 真实服务器不保证返回顺序，这里故意打乱，验证实现会自己重排
    fetchAll: async (batch: number[]) => [...batch].reverse().map((uid) => messages.get(uid)),
  };
}

test('邮箱 search：先过滤后分页，空页不谎报 has_more，结果保持 UID 降序', async () => {
  const session = new ImapSession({ host: 'example.invalid', port: 993, secure: true, user: 'u', pass: 'p', folder: 'INBOX', sendId: false, cacheDir: '/tmp' });
  (session as unknown as { client: unknown }).client = fakeClient([8, 7, 6, 5, 4, 3, 2, 1]);

  const pages = [];
  let cursor: string | undefined;
  for (let i = 0; i < 6; i += 1) {
    const page = await session.search({ limit: 2, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    if (!page.pagination.has_more) break;
    cursor = page.pagination.next_cursor ?? undefined;
  }

  assert.ok(!pages.some((page) => page.data.length === 0 && page.pagination.has_more), '不应出现空页但 has_more=true');
  assert.ok(pages.every((page) => page.data.length <= 2), '每页不得超过 limit');
  const uids = pages.flatMap((page) => page.data.map((item) => Number(String(item.message_id).split(':').at(-1))));
  assert.deepEqual(uids, [8, 6, 4, 2], '只返回含可投递附件的邮件，且按 UID 降序不重复');
});
