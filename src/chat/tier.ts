import type { ModelTier } from '../types.ts';

const REASONING_RE =
  /(比较|对比|为什么|原因|分析|建议|面试|追问|风险|复盘|总结|排序|推荐|下一步|如何|怎么|方案|策略|评价|解释|证据|分数|差异|优劣|导出|生成|下载|发送|写入|创建|表格|文档|邮件)/;

const GREETING_RE = /^(你好|您好|hi|hello|在吗|谢谢|好的|收到|明白了?|ok)[!！。.\s]*$/i;

export interface ChatTierInput {
  message: string;
  hasAttachments: boolean;
  hasTools: boolean;
}

export interface ChatTierDecision {
  tier: ModelTier;
  reason: string;
}

/**
 * 对话档位选择：简单问答走 flash，需要推理/比较/复盘或要动工具时走 pro。
 * 这是启发式路由（零额外调用），用于节约成本；命中不确定时默认 pro，保证结论质量。
 */
export function chooseChatTier(input: ChatTierInput): ChatTierDecision {
  const text = input.message.trim();
  if (input.hasAttachments) return { tier: 'pro', reason: 'attachments' };
  if (input.hasTools && /(导出|生成|下载|发送|写入|创建|表格|文档|邮件)/.test(text)) {
    return { tier: 'pro', reason: 'tool_action' };
  }
  if (text.length >= 120) return { tier: 'pro', reason: 'long_question' };
  if (REASONING_RE.test(text)) return { tier: 'pro', reason: 'reasoning' };
  if (GREETING_RE.test(text)) return { tier: 'flash', reason: 'greeting' };
  if (text.length > 0 && text.length <= 40) return { tier: 'flash', reason: 'short' };
  return { tier: 'pro', reason: 'default' };
}
