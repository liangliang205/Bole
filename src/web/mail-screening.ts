import { z } from 'zod';
import type { Ledger } from '../core/ledger.ts';
import { MailAdapterStore, resolveMailAdapter, type MailAdapterDefinition } from '../mail/adapters.ts';
import type { MailboxQuery } from '../mail/service.ts';
import { requireMailConnection } from './mail-connections.ts';

export const mailScreeningSchema = z.object({
  requirements: z.string().trim().min(5).max(4000),
  providerId: z.string().min(1).max(64),
  query: z.string().trim().max(300).default(''),
  after: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  maxMessages: z.number().int().min(1).max(200).default(50),
  searchArgs: z.array(z.string().max(4000)).min(1).max(100).optional(),
}).strict().refine((v) => !v.after || !v.before || Date.parse(v.after) < Date.parse(v.before), '起始时间必须早于截止时间');
export type MailScreeningRequest = z.infer<typeof mailScreeningSchema>;
export const REQUEST_MAIL_PREFIX = 'run-mail-';

function carriesDate(args: string[], query: string, date: string) {
  const accepted = [date, new Date(date).toISOString()];
  if (/T00:00:00(?:\.000)?(?:Z|[+-]\d\d:\d\d)$/.test(date)) accepted.push(date.slice(0, 10));
  return accepted.some((literal) => args.some((arg) => arg.includes(literal) || (arg.includes('{query}') || arg.includes('{input}')) && query.includes(literal)));
}

/** Freeze per-task search arguments without editing a shared mailbox connection. */
export async function prepareMailScreening(ledger: Ledger, jobId: string, raw: unknown,
  identity: (definition: MailAdapterDefinition) => Promise<string> = (definition) => resolveMailAdapter(definition).identity(),
): Promise<{ request: MailScreeningRequest; mailbox: MailboxQuery; address: string }> {
  const request = mailScreeningSchema.parse(raw);
  const original = requireMailConnection(ledger, request.providerId);
  const searchArgs = request.searchArgs ?? original.operations.search.args;
  if (request.searchArgs) {
    const end = original.operations.search.args.findIndex((arg) => arg.startsWith('-') || arg.includes('{'));
    const prefix = original.operations.search.args.slice(0, end < 0 ? undefined : end);
    if (!prefix.length || !prefix.every((arg, index) => searchArgs[index] === arg)) throw new Error('只能调整已配置搜索操作的参数，不能切换为其他邮箱操作');
  }
  if (request.before && !carriesDate(searchArgs, request.query, request.before)) throw new Error('邮箱搜索尚未包含截止时间，请根据插件文档生成支持该时间段的搜索条件，不能扩大收取范围');
  if (request.after && !searchArgs.some((arg) => arg.includes('{after}') || arg.includes('{input}')) && !carriesDate(searchArgs, request.query, request.after)) throw new Error('邮箱搜索尚未包含起始时间，请先适配时间筛选能力');
  const address = z.email().parse(await identity(original));
  const definition = new MailAdapterStore(ledger).save({ ...original, id: REQUEST_MAIL_PREFIX + jobId.replace(/[^a-z0-9_-]/g, '').slice(0, 40), operations: { ...original.operations, search: { ...original.operations.search, args: searchArgs } } });
  const mailbox: MailboxQuery = { providerId: definition.id, query: request.query, after: request.after, maxMessages: request.maxMessages };
  ledger.appendEvent(jobId, 'coordinator', 'mail.screening.requested', { ...request, mailbox: address, sourceProviderId: original.id, frozenProviderId: definition.id });
  return { request, mailbox, address };
}
