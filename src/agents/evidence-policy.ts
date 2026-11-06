import type { Scorecard, DimensionScore, ClaimCheck } from '../types.ts';

export function experienceOptional(requirements: string): boolean {
  return /(?:工作)?经验\s*(?:不限|不做要求|无要求)/.test(requirements) || /应届/.test(requirements) && !/(不接受|不招|不考虑|拒绝)\s*应届/.test(requirements);
}
export function auditCoverageIssues(dimensions: Pick<DimensionScore, 'key' | 'name' | 'rationale'>[], checks: Pick<ClaimCheck, 'claim'>[]): string[] {
  return dimensions.filter((d) => !checks.some((c) => c.claim.includes(d.key) || c.claim.includes(d.name) || Boolean(d.rationale.trim()) && c.claim.trim() === d.rationale.trim()))
    .map((d) => `核查缺少维度 ${d.key}（${d.name}）的明确裁决，claim 应包含维度名称或完整待核查结论`);
}
export function deploymentEvidenceIssues(text: string, rationales: string[]): string[] {
  const explicit = /(?:项目环境|部署环境)[^\n]{0,100}(?:云服务器|阿里云|AWS|Azure|腾讯云)/i.test(text) && /容器化部署|已上线|投入生产|部署/.test(text);
  if (!explicit) return [];
  return rationales.some((r) => /(?:云|部署).{0,20}(?:仅停留在了解|仅了解|完全缺乏|完全没有)|仅(?:停留在)?了解.{0,12}(?:云|部署)/.test(r))
    ? ['原文包含云平台项目环境和部署实践信息，不能概括为仅了解或完全没有云部署证据；请引用项目证据并单独说明个人负责范围是否待确认'] : [];
}
export function optionalMissingAnomaly(message: string, requirements: string): boolean {
  if (!/缺少|缺失|未提供|未填写|为空/.test(message)) return false;
  if (/expected_salary|期望薪资/.test(message) && !/必须.{0,6}(薪资|工资)|(?:薪资|工资).{0,6}(?:必填|必须填写|必须提供)/.test(requirements)) return true;
  return experienceOptional(requirements) && /work_history|years_experience|工作经历|工作年限/.test(message);
}
/** Require the model to regenerate an incompatible rubric; never silently boost scores. */
export function rubricIssues(requirements: string, scorecard: Scorecard): string[] {
  const issues: string[] = [];
  for (const dim of scorecard.dimensions) {
    if (experienceOptional(requirements) && /工作年限|工作经历|years_experience|work_history/.test(`${dim.key} ${dim.name}`)) issues.push(`经验不限岗位不能以 ${dim.name} 作为评分维度`);
    if (/后端\s*(?:不做要求|不限|无要求|不要求)/.test(requirements) && /backend|后端/.test(`${dim.key} ${dim.name}`)) issues.push(`用户明确后端不要求，不能新增 ${dim.name} 评分维度`);
    if (experienceOptional(requirements)) {
      for (const token of ['Kubernetes', '多云', '大型项目架构', '推动团队技术演进']) {
        if (!requirements.toLowerCase().includes(token.toLowerCase()) && Object.values(dim.anchors).some((a) => a.includes(token))) issues.push(`本岗位未要求 ${token}，请使用岗位所需能力的实践深度设置锚点`);
      }
    }
  }
  return issues;
}
