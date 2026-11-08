/**
 * 招聘邮箱的第一层 triage：在导入附件前排除明显不是候选人投递的邮件。
 *
 * 只做确定性规则，不调用模型：
 * - 自动通知 / 退信地址（noreply、mailer-daemon 等）；
 * - 发件人就是当前招聘邮箱自身（自己发给自己的测试邮件）；
 * - 主题命中广告、退订等关键词。
 *
 * 附件格式与大小仍由适配器和导入链路各自校验，这里不重复判断。
 */
export interface MailTriageInput {
  from: string;
  subject?: string;
  mailbox: string;
}

export interface MailTriageResult {
  spam: boolean;
  reason?: string;
}

/** 只匹配本地部分，域名不参与判断（不同厂商的退信域名不统一）。 */
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+._-].*)?$/i;

const SPAM_SUBJECT_HINTS = ['unsubscribe', '退订', '广告', '营销', '促销', '推广', 'newsletter'];

export function isAutomatedSender(address: string): boolean {
  const local = address.trim().toLowerCase().split('@')[0] ?? '';
  return AUTOMATED_SENDER.test(local);
}

export function isLikelySpam(input: MailTriageInput): MailTriageResult {
  const from = input.from.trim().toLowerCase();
  const mailbox = input.mailbox.trim().toLowerCase();
  if (!from) return { spam: true, reason: '发件人为空' };
  if (mailbox && from === mailbox) return { spam: true, reason: '发件人是当前招聘邮箱自身' };
  if (isAutomatedSender(from)) return { spam: true, reason: '自动通知或退信地址' };
  const subject = (input.subject ?? '').toLowerCase();
  const hit = SPAM_SUBJECT_HINTS.find((hint) => subject.includes(hint));
  return hit ? { spam: true, reason: `主题包含「${hit}」` } : { spam: false };
}
