import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const versionSchema = z.string().max(32).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).refine((v) => v.split('.').every((p) => Number.isSafeInteger(Number(p))), '版本数字超出安全范围');
export const slotNames = ['coordinator', 'profiler', 'fetcher', 'parser', 'assessor', 'auditor'] as const;
export const templateCatalog = {
  'builtin.coordinator.v1': { slot: 'coordinator', input: 'recruitment.job@1', output: 'recruitment.plan@1', capability: 'recruitment.coordinate@1', schema: 'coordinator_plan' },
  'builtin.profiler.v1': { slot: 'profiler', input: 'recruitment.requirements@1', output: 'recruitment.profile@1', capability: 'recruitment.profile@1', schema: 'jd_analysis' },
  'builtin.ingest.v1': { slot: 'fetcher', input: 'recruitment.files@1', output: 'recruitment.manifest@1', capability: 'recruitment.ingest@1', schema: 'fetch_manifest' },
  'builtin.parser.v1': { slot: 'parser', input: 'recruitment.resume@1', output: 'recruitment.parsed@1', capability: 'resume.parse@1', schema: 'parse_resume' },
  'builtin.assessor.v1': { slot: 'assessor', input: 'recruitment.assess-input@1', output: 'recruitment.evaluate@1', capability: 'resume.assess@1', schema: 'evaluate_resume' },
  'builtin.auditor.v1': { slot: 'auditor', input: 'recruitment.audit-input@1', output: 'recruitment.audit@1', capability: 'resume.audit@1', schema: 'review_eval' },
  'structured-llm.v1': { slot: 'specialist', input: 'recruitment.specialist-input@1', output: 'recruitment.findings@1', capability: 'resume.specialist-check@1', schema: 'specialist_findings' },
  'tool-agent.v1': { slot: 'coordinator', input: 'recruitment.job@1', output: 'recruitment.plan@1', capability: 'recruitment.coordinate@1', schema: 'coordinator_plan' },
} as const;
export type TemplateId = keyof typeof templateCatalog;
export const definitionSchema = z.object({
  schemaVersion: z.literal(1).default(1), id, version: versionSchema,
  name: z.string().min(1).max(100), description: z.string().max(4000).default(''), roleTags: z.array(id).max(20).default([]),
  templateId: z.enum(Object.keys(templateCatalog) as [TemplateId, ...TemplateId[]]),
  inputContract: z.string(), outputContract: z.string(), capabilities: z.array(z.string()).min(1).max(20),
  prompt: z.string().min(1).max(64000),
  skills: z.array(z.object({ id, version: versionSchema, content: z.string().min(1).max(16000) })).max(10).default([]),
  tier: z.enum(['flash', 'pro']).default('flash'),
  tools: z.array(z.enum(['export_word', 'office_export_pdf', 'load_workspace_dependencies', 'python_exec'])).max(4).default([]),
  mcp: z.array(z.string().max(160)).max(32).default([]),
  knowledge: z.object({ accessRoles: z.array(z.enum(['coordinator', 'profiler', 'parser', 'assessor', 'auditor'])).max(5).default([]),
    maxContextChars: z.number().int().min(0).max(16000).default(4000) }).default({ accessRoles: [], maxContextChars: 4000 }),
  memory: z.object({ read: z.array(z.enum(['job-profile', 'job-decisions', 'job-chat', 'candidate-evidence', 'approved-policies'])).default([]),
    write: z.array(z.enum(['task-result', 'policy-proposal-draft'])).default([]), scope: z.enum(['job', 'candidate']).default('candidate') }).default({ read: [], write: [], scope: 'candidate' }),
  limits: z.object({ maxConcurrency: z.number().int().min(1).max(12).default(4), timeoutMs: z.number().int().min(1000).max(600000).default(180000),
    maxToolSteps: z.number().int().min(1).max(10).default(5) }).default({ maxConcurrency: 4, timeoutMs: 180000, maxToolSteps: 5 }),
}).strict();
export type AgentDefinition = z.infer<typeof definitionSchema>;
export const bindingSchema = z.union([
  z.object({ activeAgentId: id }).strict(),
  z.object({ agentId: id, version: versionSchema }).strict(),
  z.object({ candidates: z.array(z.object({ agentId: id, version: versionSchema }).strict()).min(1).max(12), capability: z.string().min(1) }).strict(),
]);
export const teamSchema = z.object({ id, version: versionSchema,
  slots: z.object({ coordinator: bindingSchema, profiler: bindingSchema, fetcher: bindingSchema, parser: bindingSchema,
    assessor: bindingSchema, auditor: bindingSchema, specialist: bindingSchema.optional() }).strict(),
}).strict();
export type AgentTeam = z.infer<typeof teamSchema>;
export interface AgentVersion { version_key: string; agent_id: string; version: string; definition_json: string; content_hash: string; status: 'registered' | 'retired'; registered_at: string }
export interface AgentManifest {
  teamKey: string; migration: boolean; providerName: string; providerIdentity?: string; models: { flash: string; pro: string };
  bindings: Record<string, { key: string; hash: string; definition: AgentDefinition; reason: string }>;
}
export const findingsSchema = z.object({ findings: z.array(z.object({ code: z.string().min(1).max(100),
  severity: z.enum(['info', 'warning']), note: z.string().min(1).max(2000),
  evidence: z.array(z.object({ quote: z.string().min(2), field: z.string().min(1) })).min(1).max(8),
})).max(20) });

export function validateDefinition(input: unknown): AgentDefinition {
  const d = definitionSchema.parse(input);
  const template = templateCatalog[d.templateId];
  if (d.inputContract !== template.input || d.outputContract !== template.output) throw new Error('输入输出语义契约与模板不兼容');
  if (d.capabilities.some((capability) => capability !== template.capability)) throw new Error('能力必须由执行模板支持，领域说明请使用角色标签');
  if (template.slot !== 'coordinator' && (d.tools.length || d.mcp.length)) throw new Error('此执行模板不运行工具循环');
  if (template.slot !== 'coordinator' && d.memory.read.includes('job-chat')) throw new Error('候选人处理角色不能读取全岗位对话');
  if (d.memory.write.includes('policy-proposal-draft')) throw new Error('第一版长期规则提案仅由人工入口提交');
  if (d.mcp.some((pattern) => !/^(\*|[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_.:*-]+)?)$/.test(pattern))) throw new Error('MCP 工具授权格式无效');
  return d;
}
