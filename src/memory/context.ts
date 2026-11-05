import { randomUUID } from 'node:crypto';
import type { Ledger } from '../core/ledger.ts';
import type { ChatTurn } from '../types.ts';
import { estimateTokens, maskPII } from '../util/text.ts';
import { MemoryService, memoryHash } from './service.ts';

interface MessageSource { seq: number; id: string; role: 'user' | 'assistant'; content: string; attachments_json: string | null }
interface SummaryRow { summary_json: string; source_hash: string; through_seq: number; created_at: string; references_json: string }

/** 提取式摘要不产生新事实。权威决策始终直接从台账读取。 */
export function buildMemoryContext(ledger: Ledger, jobId: string, budget = 12000, reads?: string[]): { turns: ChatTurn[]; projection: string; summarized: boolean } {
  const view = new MemoryService(ledger).getJobView(jobId, 'coordinator');
  if (reads && !reads.includes('job-decisions')) view.decisions = [];
  if (reads && !reads.includes('job-profile')) view.binding = null;
  const rows = ledger.db.prepare(`SELECT o.seq,c.id,c.role,c.content,c.attachments_json
    FROM chat_messages c JOIN chat_message_order o ON o.message_id=c.id
    WHERE c.job_id=? AND o.job_id=? ORDER BY o.seq`).all(jobId, jobId) as unknown as MessageSource[];
  const render = (r: MessageSource): ChatTurn => ({ role: r.role, content: r.content + (r.attachments_json
    ? '\n' + (JSON.parse(r.attachments_json) as { name: string; text: string }[]).map((a) => `【附件：${a.name}】\n${a.text}`).join('\n') : '') });
  const projection = `【任务记忆：权威确认条件与固定规则，不由摘要覆盖】\n${JSON.stringify(view)}`;
  const full = (reads && !reads.includes('job-chat') ? rows.slice(-1) : rows).map(render);
  if (reads && !reads.includes('job-chat')) return { turns: full, projection, summarized: false };
  if (estimateTokens(JSON.stringify(full)) <= budget || rows.length < 6) return { turns: full, projection, summarized: false };
  // 只截取完整的历史 user/assistant 轮次；工具执行轨迹不存于该表，不压缩在途 continuation。
  let cut = Math.max(0, rows.length - 8);
  if (rows[cut]?.role === 'assistant') cut -= 1;
  while (cut < rows.length - 2 && estimateTokens(JSON.stringify(rows.slice(cut).map(render))) > budget * 0.6) {
    cut += 1;
    while (cut < rows.length - 1 && rows[cut].role !== 'user') cut += 1;
  }
  const old = rows.slice(0, cut);
  if (!old.length) return { turns: full, projection, summarized: false };
  const sourceHash = memoryHash(old);
  let summary = ledger.db.prepare('SELECT * FROM memory_summaries WHERE job_id=? AND source_hash=? ORDER BY rowid DESC LIMIT 1')
    .get(jobId, sourceHash) as unknown as SummaryRow | undefined;
  if (!summary) {
    const notes = old.map((r) => ({ seq: r.seq, messageId: r.id, role: r.role, excerpt: maskPII(r.content).slice(0, 220), truncated: r.content.length > 220 }));
    const references = old.map((r) => ({ messageId: r.id, seq: r.seq, hash: memoryHash(r) }));
    const data = {
      '岗位画像与评分卡': '见权威任务投影',
      '候选人要点': '以当前报告和候选人证据为准，不从历史对话推断事实',
      '核查与 Self-Loop': '见任务台账',
      'HR 已确认决策': '见权威决策记录',
      '历史对话与待办线索': notes.slice(-20),
      note: '提取式摘要，仅保留历史片段；可能不完整。需要完整原文时调用 read_job_memory。',
    };
    const created = new Date().toISOString();
    ledger.db.prepare(`INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), jobId,
      old[0].seq, old.at(-1)!.seq, sourceHash, JSON.stringify(data), JSON.stringify(references), 'extractive', '1', created);
    summary = { summary_json: JSON.stringify(data), source_hash: sourceHash, through_seq: old.at(-1)!.seq, created_at: created, references_json: JSON.stringify(references) };
  }
  return { projection, summarized: true, turns: [{ role: 'user', content: `【非权威历史摘要，生成于 ${summary.created_at}，覆盖至消息 ${summary.through_seq}】\n${summary.summary_json}` }, ...rows.slice(cut).map(render)] };
}

export function readJobMemory(ledger: Ledger, jobId: string, afterSeq = 0, limit = 10) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq 无效');
  if (!Number.isFinite(limit)) throw new Error('limit 无效');
  return ledger.db.prepare(`SELECT o.seq,c.id,c.role,c.content,c.attachments_json FROM chat_messages c
    JOIN chat_message_order o ON o.message_id=c.id WHERE c.job_id=? AND o.job_id=? AND o.seq>? ORDER BY o.seq LIMIT ?`)
    .all(jobId, jobId, afterSeq, Math.max(1, Math.min(20, Math.trunc(limit))));
}
