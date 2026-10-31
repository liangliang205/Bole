export interface ProtectedHit {
  category: string;
  term: string;
}

const PROTECTED_PATTERNS: { category: string; re: RegExp; label: string }[] = [
  { category: 'gender', re: /男性|女性|男士|女士|性别|限男|限女|适合男|适合女|优先男|优先女/, label: '性别' },
  { category: 'age', re: /年龄|年纪|岁数|\d{2}\s*岁|年龄偏大|超过\s*\d+\s*岁|35\s*岁/, label: '年龄' },
  { category: 'marital', re: /已婚|未婚|婚姻/, label: '婚姻状况' },
  { category: 'childbearing', re: /未育|已育|生育|产假|备孕/, label: '生育状况' },
  { category: 'hometown', re: /户籍|籍贯|本地人|外地人|某省/, label: '地域/户籍' },
  { category: 'ethnicity', re: /民族|少数民族|汉族/, label: '民族' },
  { category: 'zodiac', re: /星座|属相|生肖/, label: '星座/属相' },
  { category: 'disability', re: /残疾|残障|身体缺陷/, label: '残障' },
  { category: 'religion', re: /宗教|信仰/, label: '宗教信仰' },
];

export function protectedPatterns(): typeof PROTECTED_PATTERNS {
  return PROTECTED_PATTERNS;
}

export function scanProtected(text: string): ProtectedHit[] {
  if (!text) return [];
  const hits: ProtectedHit[] = [];
  for (const { category, re } of PROTECTED_PATTERNS) {
    const match = re.exec(text);
    if (match) hits.push({ category, term: match[0] });
  }
  return hits;
}

export function categoryLabel(category: string): string {
  return PROTECTED_PATTERNS.find((p) => p.category === category)?.label ?? category;
}

/** 评估理由级公平性审查：仅在受保护属性被用于判断时判 high。 */
export function reviewRationales(rationales: string[]): { risk: 'none' | 'high'; findings: string[] } {
  const findings: string[] = [];
  for (const rationale of rationales) {
    for (const hit of scanProtected(rationale)) {
      findings.push(`评估理由使用了受保护属性「${hit.term}」（${categoryLabel(hit.category)}），不得作为评分依据`);
    }
  }
  return { risk: findings.length > 0 ? 'high' : 'none', findings: [...new Set(findings)] };
}

/** JD 侧审查：命中即应从需求中剥离，并生成 HITL 确认。 */
export function reviewRequirements(requirements: string): {
  removed: { text: string; category: string; action: string }[];
  findings: string[];
} {
  const removed: { text: string; category: string; action: string }[] = [];
  const findings: string[] = [];
  const clauses = requirements.split(/[。；;\n，,]/).map((s) => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    const hits = scanProtected(clause);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      removed.push({
        text: clause,
        category: hit.category,
        action: '从 JD 与评分卡中移除，转为 HITL 反问确认',
      });
    }
    findings.push(
      `需求含受保护属性条件「${clause}」（${hits.map((h) => categoryLabel(h.category)).join('/')}），已剥离，不参与评分。`,
    );
  }
  return { removed, findings };
}
