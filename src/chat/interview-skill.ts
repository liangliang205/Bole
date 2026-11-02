/** 按需加载的面试建议 skill；不注册 Agent，也不进入筛选流水线。 */
export const INTERVIEW_SKILL_CATALOG =
  'interview-advice：HR 明确询问某位候选人“面试怎么问、追问什么、注意什么”时使用；不主动提供，也不重新评分。';

export function wantsInterviewAdvice(message: string): boolean {
  return /面试|怎么问|追问|注意什么|注意事项|考察什么|问什么/.test(message);
}

export const INTERVIEW_SKILL_BODY = `【技能 interview-advice】
适用：HR 明确询问某位候选人的面试问题、追问方式或注意事项。
输入：已有候选人结论、评分维度、证据与风险；不要重新运行筛选，不要改变相马官结论。
输出：
1. 先确认要讨论的候选人；未指名时先问是哪一位，不要凭空选择。
2. 给出 4–6 个针对该候选人的问题，每个问题写清：问题、要验证的维度、听到什么算合格、建议的追问。
3. 单独列出面试注意事项：证据缺口、简历中的不一致、需要现场验证的能力；不要做人身评价，不要使用受保护属性。
4. 如果信息不足以设计问题，直接说明缺什么。
边界：只有 HR 明确要求时才输出面试建议；普通问答、总结或导出文件请求不要加载或展示本技能。`;
