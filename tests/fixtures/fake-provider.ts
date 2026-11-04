import type { ChatRequest } from '../../src/types.ts';
import type { LlmProvider, ProviderResult } from '../../src/llm/provider.ts';
import { estimateTokens, locateQuote, normalizeText, splitSentences, tokenOverlap, truncate } from '../../src/util/text.ts';
import { sleep } from '../../src/util/time.ts';
import { scanProtected } from '../../src/tools/fairness.ts';

export interface FakeOptions {
  latencyMs?: number;
  /** 故障注入：指定 key（meta.key）的第一次调用返回非法 schema，用于验证同轮重试。 */
  invalidSchemaOnce?: string[];
  /** 演示用故障注入：对这些 label 的候选人模拟"幻觉结论"或"偏见理由"。 */
  faults?: {
    fabricate?: string[];
    bias?: string[];
  };
}

type Meta = Record<string, unknown>;

interface ParsedFields {
  [key: string]: { value?: string; confidence?: number } | undefined;
}

interface ScorecardDim {
  key: string;
  name: string;
  weight: number;
}

const TECH_SKILLS = [
  'Java', 'Spring Boot', 'Spring Cloud', 'MySQL', 'Redis', 'Kafka', '微服务', '高并发',
  '分布式', 'Docker', 'Kubernetes', 'Elasticsearch', 'JVM', 'JUC', 'Netty', 'MyBatis',
  'Go', 'Python', 'React', 'Vue', 'TypeScript', 'Node.js',
];

const STRONG_VERBS = ['主导', '负责', '精通', '独立', '架构设计', '从0到1', '牵头'];


function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundHalf(value: number): number {
  return Math.round(Math.min(5, Math.max(0, value)) * 2) / 2;
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

function bestSentence(text: string, keywords: string[], requireNumber = false): string | null {
  const sentences = splitSentences(text);
  let best: { score: number; sentence: string } | null = null;
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (clean.length < 2) continue;
    if (requireNumber && !/\d/.test(clean)) continue;
    let score = 0;
    for (const keyword of keywords) {
      if (clean.toLowerCase().includes(keyword.toLowerCase())) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { score, sentence: clean };
  }
  return best?.sentence ?? null;
}

function grabLine(text: string, re: RegExp): { value: string; quote: string } | null {
  const match = re.exec(text);
  if (!match) return null;
  const lineStart = text.lastIndexOf('\n', match.index) + 1;
  const lineEndRaw = text.indexOf('\n', match.index);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const quote = text.slice(lineStart, lineEnd).trim();
  return { value: (match[1] ?? '').trim(), quote };
}

function grabSection(text: string, startRe: RegExp, endRes: RegExp[], maxChars = 320): string | null {
  const match = startRe.exec(text);
  if (!match) return null;
  const start = match.index;
  let end = text.length;
  for (const endRe of endRes) {
    const tail = text.slice(start + match[0].length);
    const found = endRe.exec(tail);
    if (found) {
      end = Math.min(end, start + match[0].length + found.index);
    }
  }
  let section = text.slice(start, end).trim();
  if (section.length > maxChars) section = section.slice(0, maxChars).trim();
  return section.length >= 4 ? section : null;
}

function splitClauses(text: string): string[] {
  return text
    .split(/[。；;\n，,]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

function guessTitle(text: string): string {
  if (/java/i.test(text)) return 'Java 后端工程师';
  if (/前端|react|vue/i.test(text)) return '前端工程师';
  if (/算法|机器学习|大模型|nlp/i.test(text)) return '算法工程师';
  if (/测试/i.test(text)) return '测试工程师';
  if (/数据/i.test(text)) return '数据工程师';
  if (/产品/i.test(text)) return '产品经理';
  return '目标岗位';
}

function fixedScorecard(): {
  version: string;
  dimensions: {
    key: string;
    name: string;
    weight: number;
    anchors: Record<string, string>;
  }[];
} {
  return {
    version: '1.0.0',
    dimensions: [
      {
        key: 'tech_stack',
        name: '技术栈匹配',
        weight: 35,
        anchors: {
          '1': '仅掌握基础语法，无法独立开发',
          '3': '能独立完成业务模块开发，熟悉常用框架',
          '5': '精通核心语言与框架，有架构级实践与性能优化证据',
        },
      },
      {
        key: 'years_experience',
        name: '年限经验',
        weight: 25,
        anchors: {
          '1': '不足 1 年相关经验',
          '3': '接近岗位最低年限要求',
          '5': '年限完全落在目标区间，且经历连续',
        },
      },
      {
        key: 'project_complexity',
        name: '项目复杂度',
        weight: 20,
        anchors: {
          '1': '仅参与简单业务开发',
          '3': '参与过中等规模系统的模块开发',
          '5': '主导高并发/大规模系统设计，有量化结果',
        },
      },
      {
        key: 'leadership',
        name: '团队与协作',
        weight: 10,
        anchors: {
          '1': '无团队协作或带人证据',
          '3': '有跨团队协作经验',
          '5': '带领团队完成核心项目，有明确规模',
        },
      },
      {
        key: 'industry_fit',
        name: '行业匹配',
        weight: 10,
        anchors: {
          '1': '行业完全无关',
          '3': '有相关业务域经验',
          '5': '金融科技/支付/风控等目标行业深度经验',
        },
      },
    ],
  };
}

function mockJdAnalysis(meta: Meta): unknown {
  const requirements = asString(meta.requirements);
  const title = guessTitle(requirements);
  const hard: string[] = [];
  const nice: string[] = [];
  const removed: { text: string; category: string; action: string }[] = [];
  const findings: string[] = [];

  for (const clause of splitClauses(requirements)) {
    const protectedHits = scanProtected(clause);
    if (protectedHits.length > 0) {
      for (const hit of protectedHits) {
        removed.push({
          text: clause,
          category: hit.category,
          action: '从 JD 与评分卡中移除，转为 HITL 反问确认',
        });
      }
      findings.push(`需求含受保护属性条件「${clause}」（${protectedHits.map((h) => h.category).join('/')}），已剥离，不参与评分。`);
      continue;
    }
    if (/优先|加分|最好|更佳/.test(clause)) nice.push(clause);
    else if (/年|学历|本科|硕士|熟悉|掌握|精通|经验|微服务|并发/.test(clause)) hard.push(clause);
  }

  const location = /上海|北京|深圳|杭州|广州|成都|南京|武汉/.exec(requirements)?.[0] ?? '';
  const compensation = /(\d+\s*[-~]\s*\d+\s*[kK]|面议)/.exec(requirements)?.[0] ?? '';
  const ambiguities: {
    id: string;
    question: string;
    options: string[];
    recommendedOption: string;
    blocking: boolean;
  }[] = [];

  if (/面议|薪资不详/.test(requirements)) {
    ambiguities.push({
      id: 'salary',
      question: '薪资为"面议"。平台是否需要按固定区间筛选候选人？',
      options: ['不限薪资，仅作参考（推荐）', '按 40-60K 区间筛选', '按 HR 另行提供的区间筛选'],
      recommendedOption: '不限薪资，仅作参考（推荐）',
      blocking: true,
    });
  }
  if (/带团队|团队管理/.test(requirements) && !/\d+\s*人/.test(requirements)) {
    ambiguities.push({
      id: 'team_scope',
      question: '"带团队经验优先"没有说明团队规模。面试建议是否按"≥3 人团队负责人"口径生成？',
      options: ['按 ≥3 人团队负责人（推荐）', '只要有带人经验即可', '不要求带团队'],
      recommendedOption: '按 ≥3 人团队负责人（推荐）',
      blocking: true,
    });
  }
  if (removed.length > 0) {
    ambiguities.push({
      id: 'protected_attr',
      question: `需求中包含受保护属性条件（${removed.map((r) => r.text).join('；')}），平台已从评分条件中移除。请确认最终不将性别/年龄纳入筛选。`,
      options: ['确认移除，不纳入筛选（推荐）', '保留原文但仅作人工参考（平台不用于评分）'],
      recommendedOption: '确认移除，不纳入筛选（推荐）',
      blocking: true,
    });
  }

  return {
    jd: {
      title,
      responsibilities: ['负责核心业务服务的设计、开发与性能优化'],
      hardRequirements: hard,
      niceToHave: nice,
      exclusions: [],
      location,
      compensation: compensation || '面议',
      teamContext: /带团队|团队管理/.test(requirements) ? '团队规模待 HR 确认' : '',
    },
    scorecard: fixedScorecard(),
    ambiguities,
    fairness: { removed, findings },
  };
}

function extractFields(text: string): Record<string, { value: string; confidence: number; spans: { field: string; quote: string }[] }> {
  const fields: Record<string, { value: string; confidence: number; spans: { field: string; quote: string }[] }> = {};
  const put = (key: string, value: string, quote: string, confidence = 0.9): void => {
    if (!value || !quote) return;
    fields[key] = { value, confidence, spans: [{ field: key, quote }] };
  };

  const name = grabLine(text, /姓名\s*[:：]\s*(.+)/);
  if (name) put('name', name.value, name.quote, 0.95);

  const phone = grabLine(text, /手机\s*[:：]\s*([0-9\-+ ]{7,20})/);
  const email = grabLine(text, /邮箱\s*[:：]\s*(\S+@\S+)/);
  if (phone || email) {
    const contactValue = [phone?.value, email?.value].filter(Boolean).join(' / ');
    const contactQuote = [phone?.quote, email?.quote].filter(Boolean).join('\n');
    put('contact', contactValue, contactQuote, 0.95);
  }

  const education = grabLine(text, /教育背景\s*[:：]\s*(.+)/);
  if (education) {
    put('education', education.value, education.quote, 0.9);
    const majorMatch = /([\u4e00-\u9fa5]{2,12}(?:工程|科学与技术|技术|科学|管理))\s*(?:本科|硕士|博士|大专|学士)?/.exec(education.value);
    if (majorMatch) put('major', majorMatch[1], education.quote, 0.8);
  }

  const years = grabLine(text, /工作年限\s*[:：]\s*(\d+(?:\.\d+)?)\s*年/) ??
    (/经验\s*[:：]?\s*(\d+)\s*年/.exec(text) ? { value: /经验\s*[:：]?\s*(\d+)\s*年/.exec(text)![1], quote: (/.*经验\s*[:：]?\s*\d+\s*年.*/.exec(text)?.[0] ?? '').trim() } : null);
  if (years && years.quote) put('years_experience', years.value, years.quote, 0.9);

  const skills = grabLine(text, /技能(?:标签|清单|特长)?\s*[:：]\s*(.+)/);
  if (skills) put('skills', skills.value, skills.quote, 0.9);

  const work = grabSection(text, /工作经历\s*[:：]/, [/项目经历\s*[:：]/, /教育背景\s*[:：]/, /期望薪资\s*[:：]/]);
  if (work) put('work_history', work.replace(/\n+/g, ' '), work, 0.85);

  const projects = grabSection(text, /项目经历\s*[:：]/, [/工作经历\s*[:：]/, /期望薪资\s*[:：]/, /技能(?:标签)?\s*[:：]/]);
  if (projects) put('projects', projects.replace(/\n+/g, ' '), projects, 0.85);

  const salary = grabLine(text, /期望薪资\s*[:：]\s*(.+)/);
  if (salary) put('expected_salary', salary.value, salary.quote, 0.85);

  return fields;
}

function mockParse(meta: Meta): unknown {
  const text = normalizeText(asString(meta.text));
  const resumeId = asString(meta.resumeId, 'unknown');
  const fields = extractFields(text);
  const anomalies: string[] = [];
  if (text.length < 250) anomalies.push('证据稀疏：简历正文过短（<250 字符）');
  if (!fields.work_history) anomalies.push('缺少可识别的工作经历段落');
  if (!fields.projects) anomalies.push('缺少可识别的项目经历段落');
  const summarySource = fields.projects?.value ?? fields.work_history?.value ?? firstLine(text);
  return {
    resumeId,
    fields,
    anomalies,
    summary: summarySource.slice(0, 120),
  };
}

function evidenceFor(text: string, key: string): { quote: string; scale: number } {
  const techQuote = bestSentence(text, TECH_SKILLS);
  const projectQuote = bestSentence(text, ['主导', '负责', '重构', '架构', 'QPS', '亿', '万', '倍', '高并发', '微服务'], true);
  const leadQuote = bestSentence(text, ['带领', '负责人', '团队', '管理', '协作']);
  const industryQuote = bestSentence(text, ['金融', '支付', '风控', '银行', '保险', '证券', '交易']);
  const yearsQuote = grabLine(text, /工作年限\s*[:：]\s*(\d+(?:\.\d+)?)\s*年/)?.quote ?? null;

  let quote: string | null = null;
  switch (key) {
    case 'tech_stack':
      quote = techQuote;
      break;
    case 'years_experience':
      quote = yearsQuote ?? bestSentence(text, ['年', '经验']);
      break;
    case 'project_complexity':
      quote = projectQuote;
      break;
    case 'leadership':
      quote = leadQuote;
      break;
    case 'industry_fit':
      quote = industryQuote;
      break;
    default:
      quote = bestSentence(text, [key]);
  }
  if (!quote) quote = techQuote ?? firstLine(text);
  if (!quote) quote = text.slice(0, Math.min(40, text.length));
  const scale = (quote.match(/\d+(?:\.\d+)?\s*(?:亿|万|倍|人|QPS|qps|服务|业务方)/g) ?? []).length;
  return { quote, scale };
}

function mockEvaluate(meta: Meta): unknown {
  const text = normalizeText(asString(meta.text));
  const resumeId = asString(meta.resumeId, 'unknown');
  const label = asString(meta.label);
  const parsed = (meta.parsed ?? {}) as { fields?: ParsedFields; anomalies?: string[] };
  const fields = parsed.fields ?? {};
  const jd = (meta.jd ?? {}) as { hardRequirements?: string[]; niceToHave?: string[]; title?: string };
  const jdText = [jd.title ?? '', ...(jd.hardRequirements ?? []), ...(jd.niceToHave ?? [])].join(' ');
  const scorecardDims = ((meta.scorecard as { dimensions?: ScorecardDim[] } | undefined)?.dimensions ?? []) as ScorecardDim[];
  const loopIndex = asNumber(meta.loopIndex);
  const feedback = (meta.feedback ?? null) as { checks?: { claim: string; verdict: string }[] } | null;
  const faults = (meta.faults ?? {}) as { fabricate?: string[]; bias?: string[] };
  const anomalyText = (parsed.anomalies ?? []).join('；');
  const sparse = anomalyText.includes('证据稀疏') && !fields.projects?.value;

  const yearsValue = fields.years_experience?.value ?? '';
  const years = Number(/(\d+(?:\.\d+)?)/.exec(yearsValue)?.[1] ?? 0);
  const jdSkills = TECH_SKILLS.filter((skill) => jdText.toLowerCase().includes(skill.toLowerCase()));
  const matchedSkills = jdSkills.filter((skill) => text.toLowerCase().includes(skill.toLowerCase()));
  const industryHits = ['金融', '支付', '风控', '银行', '保险', '证券'].filter((k) => text.includes(k));
  const scaleMarkers = (text.match(/\d+(?:\.\d+)?\s*(?:亿|万|倍|人|QPS|qps|服务|业务方)/g) ?? []).length;
  const strongVerbHits = STRONG_VERBS.filter((v) => text.includes(v)).length;

  const dims = scorecardDims.length > 0
    ? scorecardDims
    : fixedScorecard().dimensions.map((d) => ({ key: d.key, name: d.name, weight: d.weight }));

  const unsupportedClaims = new Set(
    (feedback?.checks ?? []).filter((c) => c.verdict !== 'supported').map((c) => c.claim),
  );

  const dimensions = dims.map((dim) => {
    const evidence = evidenceFor(text, dim.key);
    let score = 3;
    let rationale = '';
    let revisionNote = '';

    if (dim.key === 'tech_stack') {
      const ratio = jdSkills.length ? matchedSkills.length / jdSkills.length : 0.6;
      score = roundHalf(1 + ratio * 4);
      rationale = jdSkills.length
        ? `技术栈匹配：命中 JD 技能 ${matchedSkills.slice(0, 6).join('、')}（${matchedSkills.length}/${jdSkills.length}），${ratio >= 0.6 ? '覆盖岗位主要技术方向' : '技术覆盖仍有缺口'}。`
        : `技术栈匹配：简历体现 ${matchedSkills.slice(0, 5).join('、') || '通用开发'} 能力。`;
      if ((faults.bias ?? []).includes(label)) {
        rationale += '考虑到候选人年龄偏大，稳定性存疑，适当下调。';
        score = roundHalf(score - 1);
      }
    } else if (dim.key === 'years_experience') {
      const range = /(\d+)\s*[-~至]\s*(\d+)\s*年/.exec(jdText);
      const min = range ? Number(range[1]) : 3;
      const max = range ? Number(range[2]) : 5;
      if (years >= min && years <= max) score = 5;
      else if (years > max && years <= max + 2) score = 4.5;
      else if (years <= 0) score = 1.5;
      else if (years < min && years >= min - 1) score = 3.5;
      else if (years < min) score = roundHalf(Math.max(1, 5 - (min - years)));
      else score = roundHalf(Math.max(2, 5 - (years - max - 2) * 0.5));
      rationale = `年限经验：约 ${years || '未知'} 年，岗位目标区间 ${min}-${max} 年，${years >= min && years <= max ? '落在区间内' : years > max ? '略高于目标区间' : '低于目标区间'}。`;
    } else if (dim.key === 'project_complexity') {
      score = roundHalf(1.5 + scaleMarkers * 0.5 + strongVerbHits * 0.4);
      rationale = `项目复杂度：${scaleMarkers > 0 ? `有 ${scaleMarkers} 处量化规模证据` : '缺少量化规模证据'}。`;
      if (sparse) {
        score = 4;
        rationale = '项目复杂度：候选人主导过大型高并发系统。';
      }
      if ((faults.fabricate ?? []).includes(label)) {
        score = 4.5;
        rationale = '项目复杂度：候选人主导过千万级日活系统架构设计。';
      }
    } else if (dim.key === 'leadership') {
      if (/带领\s*\d+\s*人/.test(text)) score = 5;
      else if (/技术负责人|负责人|leader|Lead/i.test(text)) score = 4.5;
      else if (/负责/.test(text)) score = 3.5;
      else if (/团队|协作/.test(text)) score = 3;
      else score = 2;
      rationale = `团队与协作：${score >= 4.5 ? '有明确带团队证据' : score >= 3 ? '有协作或模块 owner 证据' : '缺少带人证据'}。`;
    } else if (dim.key === 'industry_fit') {
      score = roundHalf(Math.min(5, 2 + industryHits.length * 0.75));
      rationale = `行业匹配：${industryHits.length ? `命中 ${industryHits.join('、')} 业务域` : '未见目标行业经历'}。`;
    } else {
      score = 3;
      rationale = `${dim.name}：根据简历原文综合判断。`;
    }

    const injected =
      (dim.key === 'project_complexity' && (sparse || (faults.fabricate ?? []).includes(label))) ||
      (dim.key === 'tech_stack' && (faults.bias ?? []).includes(label));
    if (!injected) {
      rationale += `（依据：${truncate(evidence.quote, 28)}）`;
    }

    // 返工：按监军驳回意见逐条修正，保留未被驳回内容
    const hadUnsupported = [...unsupportedClaims].some((claim) => claim.includes(rationale.slice(0, 12)));
    if (loopIndex > 0 && hadUnsupported) {
      const before = rationale;
      rationale = rationale
        .replace(/主导/g, '参与')
        .replace(/负责/g, '参与')
        .replace(/精通/g, '熟悉')
        .replace(/架构设计/g, '模块开发');
      if (dim.key === 'project_complexity') {
        rationale = sparse
          ? '项目复杂度：证据不足，无法判断项目规模。'
          : `项目复杂度：${evidence.quote.slice(0, 36)}，以参与为主。`;
      }
      score = roundHalf(Math.max(1, score - 1));
      revisionNote = `按驳回意见修正：${before.slice(0, 30)}… → ${rationale.slice(0, 30)}…`;
    }

    return {
      key: dim.key,
      name: dim.name,
      weight: dim.weight,
      score,
      rationale,
      evidence: [{ field: dim.key, quote: evidence.quote }],
      revisionNote,
    };
  });

  const total = dimensions.reduce((sum, d) => {
    const weight = d.weight > 0 ? d.weight : 20;
    return sum + weight * (d.score / 5);
  }, 0);
  const weightSum = dimensions.reduce((sum, d) => sum + (d.weight > 0 ? d.weight : 20), 0);
  const normalized = weightSum > 0 ? (total / weightSum) * 100 : 0;
  const conclusion =
    normalized >= 85 ? 'strong_yes' : normalized >= 72 ? 'yes' : normalized >= 60 ? 'maybe' : normalized >= 45 ? 'no' : 'strong_no';

  const revisionNotes = dimensions.map((d) => d.revisionNote).filter((n) => n.length > 0);

  return {
    resumeId,
    dimensions: dimensions.map((d) => ({
      key: d.key,
      name: d.name,
      weight: d.weight,
      score: d.score,
      rationale: d.rationale,
      evidence: d.evidence,
    })),
    totalScore: Number(normalized.toFixed(1)),
    conclusion,
    rationale: [
      `总分 ${normalized.toFixed(1)}，技术栈与年限是主要得分来源。`,
      years && years >= 3 ? '年限满足岗位要求。' : '年限与岗位要求存在偏差。',
    ],
    uncertainties: sparse ? ['简历证据稀疏，项目与团队信息无法核实'] : [],
    redFlags: [],
    revisionNotes,
  };
}

function mockReview(meta: Meta): unknown {
  const text = normalizeText(asString(meta.text));
  const resumeId = asString(meta.resumeId, 'unknown');
  const evaluation = (meta.evaluation ?? {}) as {
    dimensions?: { name?: string; key: string; rationale: string; score: number; spans?: { quote: string }[] }[];
  };
  const loopCount = asNumber(meta.loopCount);
  const maxLoops = asNumber(meta.maxLoops, 2);
  const checks: { claim: string; verdict: string; note: string; quote?: string }[] = [];
  const requiredFixes: string[] = [];
  const complianceFindings: string[] = [];
  let highRisk = false;

  const dimensions = evaluation.dimensions ?? [];
  for (const dim of dimensions) {
    const claim = dim.rationale;
    if (!dim.spans || dim.spans.length === 0) {
      checks.push({ claim, verdict: 'missing_evidence', note: '该维度没有挂任何原文引用' });
      requiredFixes.push(`为「${dim.name ?? dim.key}」补充原文证据，或下调分数并标注不确定`);
      continue;
    }
    for (const span of dim.spans) {
      const located = locateQuote(text, span.quote);
      if (!located) {
        checks.push({ claim, verdict: 'unsupported', note: `引用不在原文中：「${span.quote.slice(0, 30)}」` });
        requiredFixes.push(`删除原文中不存在的引用：「${span.quote.slice(0, 30)}」`);
        continue;
      }
      const strongInClaim = STRONG_VERBS.filter((v) => dim.rationale.includes(v));
      const strongInQuote = STRONG_VERBS.filter((v) => span.quote.includes(v));
      const missingStrength = strongInClaim.filter((v) => !strongInQuote.includes(v));
      if (missingStrength.length > 0) {
        checks.push({
          claim,
          verdict: 'unsupported',
          note: `结论使用「${missingStrength.join('、')}」，但引用原文没有对应表述，属于拔高`,
          quote: span.quote,
        });
        requiredFixes.push(`删除/改写「${dim.name ?? dim.key}」中无依据的「${missingStrength.join('、')}」表述，并下调分数`);
        continue;
      }
      const overlap = tokenOverlap(`${dim.name ?? ''}${dim.rationale}`, span.quote);
      if (overlap < 0.1) {
        checks.push({
          claim,
          verdict: 'unsupported',
          note: `引用与结论关联过弱（关键词重合度 ${(overlap * 100).toFixed(0)}%）`,
          quote: span.quote,
        });
        requiredFixes.push(`为「${dim.name ?? dim.key}」更换能直接支持结论的原文引用`);
        continue;
      }
      checks.push({ claim, verdict: 'supported', note: '引用真实存在且能支持该结论', quote: span.quote });
    }
  }

  for (const dim of dimensions) {
    const hits = scanProtected(dim.rationale);
    if (hits.length > 0) {
      highRisk = true;
      complianceFindings.push(
        `评估理由使用了受保护属性词「${hits.map((h) => h.term).join('、')}」，不得作为评分依据`,
      );
    }
  }

  const failed = checks.filter((c) => c.verdict !== 'supported');
  let verdict: 'pass' | 're_eval' | 'escalate_human';
  let escalationReason: string | undefined;
  if (highRisk) {
    verdict = 'escalate_human';
    escalationReason = '公平性哨兵：评估理由使用了受保护属性，需人工复核并重新评估';
  } else if (failed.length === 0) {
    verdict = 'pass';
  } else if (loopCount >= maxLoops) {
    verdict = 'escalate_human';
    escalationReason = `验真环已达上限（${loopCount}/${maxLoops}），仍有 ${failed.length} 条结论无法通过证据核对`;
  } else {
    verdict = 're_eval';
  }

  return {
    resumeId,
    verdict,
    checks,
    compliance: {
      risk: highRisk ? 'high' : complianceFindings.length > 0 ? 'low' : 'none',
      findings: complianceFindings.length > 0 ? complianceFindings : ['未发现评估过程使用受保护属性'],
    },
    requiredFixes: verdict === 'pass' ? [] : [...new Set(requiredFixes)],
    ...(escalationReason ? { escalationReason } : {}),
  };
}

function mockInterview(meta: Meta): unknown {
  const resumeId = asString(meta.resumeId, 'unknown');
  const evaluation = (meta.evaluation ?? {}) as {
    dimensions?: { key: string; name?: string; score: number; rationale: string; spans?: { quote: string }[] }[];
  };
  const dims = evaluation.dimensions ?? [];
  const questions: { question: string; target: string; evidenceHint: string }[] = [];

  const questionFor = (dim: (typeof dims)[number]): { question: string; target: string; evidenceHint: string } => {
    const quote = dim.spans?.[0]?.quote ?? '';
    const short = truncate(quote, 42);
    const target = dim.name ?? dim.key;
    if (dim.key === 'tech_stack') {
      return {
        question: `简历列出「${short}」。请说明这些技术你实际用在哪个系统、解决过什么具体问题，并给出一个可量化的结果。`,
        target,
        evidenceHint: quote.slice(0, 80),
      };
    }
    if (dim.key === 'years_experience') {
      return {
        question: `简历显示「${short}」。请梳理最近三年的职责变化：你从执行者到负责人分别做了哪些决策？`,
        target,
        evidenceHint: quote.slice(0, 80),
      };
    }
    if (dim.key === 'project_complexity') {
      return {
        question: `简历提到「${short}」。请说明你在这个项目中的个人职责边界、量化结果的测量口径，以及哪些部分不是你负责的。`,
        target,
        evidenceHint: quote.slice(0, 80),
      };
    }
    if (dim.key === 'leadership') {
      return {
        question: `简历提到「${short}」。你如何做团队分工、技术方案评审与上线保障？遇到成员交付不达标时怎么处理？`,
        target,
        evidenceHint: quote.slice(0, 80),
      };
    }
    if (dim.key === 'industry_fit') {
      return {
        question: `你在「${short}」相关业务中遇到过哪些合规或数据一致性约束？当时如何落地与验证？`,
        target,
        evidenceHint: quote.slice(0, 80),
      };
    }
    return {
      question: `请结合「${short}」说明你在该维度的具体做法与结果。`,
      target,
      evidenceHint: quote.slice(0, 80),
    };
  };

  for (const dim of dims.slice(0, 4)) {
    if (dim.spans?.[0]?.quote) questions.push(questionFor(dim));
  }
  if (questions.length === 0) {
    questions.push({
      question: '请介绍一个最能体现你技术判断力的项目，并说明你如何验证效果。',
      target: '综合',
      evidenceHint: '',
    });
  }
  const weak = dims.find((d) => d.score < 3.5);
  return {
    resumeId,
    questions: questions.slice(0, 5),
    risks: weak ? [`${weak.name ?? weak.key}维度证据偏弱（${weak.score} 分），建议面试重点验证`] : [],
    recommendation: weak
      ? `建议进入技术面，重点验证${weak.name ?? weak.key}相关经历的真实边界`
      : '建议进入技术面，简历证据与岗位要求匹配度较高',
  };
}

function mockScreeningPlan(meta: Meta): unknown {
  const inventory = (meta.inventory ?? {}) as { usable?: number };
  const usable = Number(inventory.usable ?? 0);
  if (usable <= 1) {
    return {
      mode: 'single',
      batchSize: 1,
      maxBatchesInFlight: 1,
      maxActiveAgents: 1,
      deepEval: { enabled: false, percent: 0 },
      pools: { parse: 1, assess: 1, review: 1 },
      reason: '只有 1 份可用简历，串行处理并跳过深评',
    };
  }
  return {
    mode: 'batch',
    batchSize: 8,
    maxBatchesInFlight: 2,
    maxActiveAgents: 8,
    deepEval: { enabled: true, percent: 40 },
    pools: { parse: 4, assess: 2, review: 1 },
    reason: `${usable} 份可用简历，按批扇出`,
  };
}

function handlerFor(schemaName: string | undefined): ((meta: Meta) => unknown) | null {
  switch (schemaName) {
    case 'jd_analysis':
      return mockJdAnalysis;
    case 'parse_resume':
      return mockParse;
    case 'evaluate_resume':
      return mockEvaluate;
    case 'review_eval':
      return mockReview;
    case 'interview_plan':
      return mockInterview;
    case 'screening_plan':
      return mockScreeningPlan;
    default:
      return null;
  }
}

/** 离线确定性 Mock：用规则模拟模型行为，保证无 API Key 时 Demo 可复现。 */
export class FakeProvider implements LlmProvider {
  readonly name = 'mock';
  readonly kind = 'mock' as const;
  private latencyMs: number;
  private invalidSchemaOnce: Set<string>;
  private invalidSeen = new Set<string>();
  private faults: { fabricate: string[]; bias: string[] };

  constructor(opts: FakeOptions = {}) {
    this.latencyMs = opts.latencyMs ?? Number(process.env.BOLE_MOCK_LATENCY_MS ?? 0);
    this.invalidSchemaOnce = new Set(opts.invalidSchemaOnce ?? []);
    this.faults = {
      fabricate: opts.faults?.fabricate ?? [],
      bias: opts.faults?.bias ?? [],
    };
  }

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const started = performance.now();
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const meta: Meta = { ...(req.meta ?? {}) };
    meta.faults = this.faults;
    if (req.images?.length && !req.schemaName) {
      const text = `姓名：李娜
手机：13800000002
邮箱：lina@example.com
求职意向：Java 后端工程师
工作年限：6 年
技能标签：Java、Spring Boot、MySQL、Redis
工作经历：
2020.07-2024.06 某某支付公司 后端工程师
负责清结算服务。
项目经历：
1. 清结算平台重构：日处理 300 万笔。`;
      if (req.onToken) {
        for (let offset = 0; offset < text.length; offset += 32) req.onToken(text.slice(offset, offset + 32));
      }
      const promptTokens = estimateTokens(`${req.system}\n${req.user}`) + req.images.length * 1024;
      return {
        text,
        usage: { promptTokens, completionTokens: estimateTokens(text), cachedPromptTokens: 0 },
        stopReason: 'completed',
        model: req.model ?? 'mock-vision',
        latencyMs: Math.round(performance.now() - started),
        cacheHit: false,
      };
    }
    if (req.tools?.length) {
      const turns = req.messages ?? [];
      const toolResults = turns.filter((turn) => turn.role === 'tool');
      const exported = toolResults.some((turn) => String(turn.content || '').includes('已生成 Word'));
      const text = exported ? '已按需求导出 Word 报告。' : '';
      const toolCalls = exported
        ? undefined
        : [{ id: `call_${toolResults.length + 1}`, type: 'function' as const, function: { name: 'export_word', arguments: '{}' } }];
      const promptText = `${req.system}\n${JSON.stringify(turns)}`;
      const promptTokens = estimateTokens(promptText);
      const cachedPromptTokens = req.sharedPrefix ? Math.min(promptTokens, estimateTokens(req.sharedPrefix)) : 0;
      return {
        text,
        toolCalls,
        usage: { promptTokens, completionTokens: estimateTokens(text), cachedPromptTokens },
        stopReason: 'completed',
        model: req.model ?? `mock-${req.tier}`,
        latencyMs: Math.round(performance.now() - started),
        cacheHit: cachedPromptTokens > 0,
      };
    }

    const handler = handlerFor(req.schemaName);
    let json: unknown = handler ? handler(meta) : { ok: true };

    const key = asString(meta.key);
    const shouldCorrupt =
      key && (this.invalidSchemaOnce.has(key) || this.invalidSchemaOnce.has('*')) && !this.invalidSeen.has(key);
    if (shouldCorrupt) {
      this.invalidSeen.add(key);
      json = { error: 'schema_violation', note: '模拟模型首次输出不符合 schema' };
    }

    const text = JSON.stringify(json);
    if (req.onToken) {
      for (let offset = 0; offset < text.length; offset += 24) {
        req.onToken(text.slice(offset, offset + 24));
      }
    }
    const promptText = `${req.system}\n${req.user}`;
    const promptTokens = estimateTokens(promptText) + (req.jsonSchema ? estimateTokens(JSON.stringify(req.jsonSchema)) : 0);
    const cachedPromptTokens = req.sharedPrefix
      ? Math.min(promptTokens, estimateTokens(req.sharedPrefix))
      : 0;
    return {
      text,
      json,
      usage: {
        promptTokens,
        completionTokens: estimateTokens(text),
        cachedPromptTokens,
      },
      stopReason: 'completed',
      model: req.model ?? `mock-${req.tier}`,
      latencyMs: Math.round(performance.now() - started),
      cacheHit: cachedPromptTokens > 0,
    };
  }
}
