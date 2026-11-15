/**
 * 导入前的模型二次识别：只判断“这段文本/这张图片是不是候选人简历”。
 *
 * 设计取舍：
 * - 用 flash 档、文本只看前 1500 字，控制成本；
 * - 图片直接走视觉模型一次判定（detail=low），不做 OCR 转写；
 * - 拿不准时返回 unknown，由调用方放行，避免模型故障或扫描件导致漏简历；
 * - 只有明确判定为非简历才拦截。
 */
import type { LlmRouter } from '../llm/router.ts';
import { supportsVision } from '../ingest/vision-ocr.ts';

export type ResumeVerdict =
  | { verdict: 'resume'; reason: string }
  | { verdict: 'not_resume'; reason: string }
  | { verdict: 'unknown'; reason: string };

const TEXT_SYSTEM = `你是招聘邮箱的简历分类器。判断用户给出的文本是否来自求职者的个人简历。
只输出 JSON：{"is_resume": boolean, "reason": "一句话依据"}。
判定标准：包含姓名、联系方式、教育或工作经历、技能等候选人信息，即为简历；
发票、合同、通知、广告、群发邮件正文、空白页或仅有邮件签名，不算简历。
拿不准时 is_resume 取 true，宁可放行也不要误杀。`;

const IMAGE_SYSTEM = `你是招聘邮箱的简历分类器。判断用户提供的图片是否是一份个人简历（含简历截图、拍照的纸质简历）。
只输出 JSON：{"is_resume": boolean, "reason": "一句话依据"}。
判定标准：图片中出现姓名、联系方式、教育或工作经历、技能等候选人信息，即为简历；
发票、合同、广告、聊天截图、空白图片，不算简历。
拿不准时 is_resume 取 true，宁可放行也不要误杀。`;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_resume: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['is_resume', 'reason'],
  additionalProperties: false,
};

function parseVerdict(json: unknown): ResumeVerdict {
  const value = json as { is_resume?: unknown; reason?: unknown } | undefined;
  if (typeof value?.is_resume !== 'boolean') return { verdict: 'unknown', reason: '模型未返回布尔判定' };
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 200) : '';
  return value.is_resume ? { verdict: 'resume', reason } : { verdict: 'not_resume', reason };
}

export async function classifyResume(llm: LlmRouter, text: string): Promise<ResumeVerdict> {
  const excerpt = text.trim().slice(0, 1500);
  if (excerpt.length < 20) return { verdict: 'unknown', reason: '文本过短，无法判断' };
  try {
    const result = await llm.chat({
      agent: 'fetcher',
      tier: 'flash',
      system: TEXT_SYSTEM,
      user: excerpt,
      temperature: 0,
      maxTokens: 120,
      jsonSchema: JSON_SCHEMA,
      meta: { kind: 'mail-triage' },
    });
    return parseVerdict(result.json);
  } catch (error) {
    return { verdict: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function classifyImageResume(
  llm: LlmRouter,
  image: { mimeType: string; base64: string },
): Promise<ResumeVerdict> {
  if (!supportsVision(image.mimeType)) return { verdict: 'unknown', reason: `视觉模型不支持 ${image.mimeType}` };
  try {
    const result = await llm.chat({
      agent: 'fetcher',
      tier: 'flash',
      model: process.env.BOLE_OCR_MODEL || undefined,
      system: IMAGE_SYSTEM,
      user: '请判断这张图片是否是一份求职简历。',
      images: [{ mimeType: image.mimeType, base64: image.base64, detail: 'low' }],
      temperature: 0,
      maxTokens: 120,
      jsonSchema: JSON_SCHEMA,
      meta: { kind: 'mail-triage', image: true },
    });
    return parseVerdict(result.json);
  } catch (error) {
    return { verdict: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}
