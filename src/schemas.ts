import { z } from 'zod';

/** 模型只提供 field + quote；字符偏移由平台定位计算，杜绝模型编造 offset。 */
export const rawSpanSchema = z.object({
  field: z.string().min(1),
  quote: z.string().min(2),
});

export const parsedFieldSchema = z.object({
  value: z.string(),
  confidence: z.number().min(0).max(1).default(0.6),
  spans: z.array(rawSpanSchema).default([]),
});

export const parseResumeSchema = z.object({
  resumeId: z.string().optional(),
  fields: z.record(z.string(), parsedFieldSchema),
  anomalies: z.array(z.string()).default([]),
  summary: z.string().default(''),
});

export const dimensionSchema = z.object({
  key: z.string().min(1),
  name: z.string().default(''),
  weight: z.number().min(0).max(100).optional(),
  score: z.number().min(0).max(5),
  rationale: z.string().min(1),
  evidence: z.array(rawSpanSchema).min(1, '每个维度至少需要一条证据引用'),
});

export const evaluateResumeSchema = z.object({
  resumeId: z.string().optional(),
  dimensions: z.array(dimensionSchema).min(1),
  totalScore: z.number().min(0).max(100).optional(),
  conclusion: z.enum(['strong_yes', 'yes', 'maybe', 'no', 'strong_no']).optional(),
  rationale: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
  revisionNotes: z.array(z.string()).default([]),
});

export const claimCheckSchema = z.object({
  claim: z.string().min(1),
  verdict: z.enum(['supported', 'unsupported', 'missing_evidence']),
  note: z.string().default(''),
  quote: z.string().optional(),
});

export const reviewEvalSchema = z.object({
  resumeId: z.string().optional(),
  verdict: z.enum(['pass', 're_eval', 'escalate_human']),
  checks: z.array(claimCheckSchema).default([]),
  compliance: z
    .object({
      risk: z.enum(['none', 'low', 'high']).default('none'),
      findings: z.array(z.string()).default([]),
    })
    .default({ risk: 'none', findings: [] }),
  requiredFixes: z.array(z.string()).default([]),
  escalationReason: z.string().optional(),
});

export const scorecardDimensionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().min(1).max(100),
  anchors: z.record(z.string(), z.string()).default({}),
});

export const jdAnalysisSchema = z.object({
  jd: z.object({
    title: z.string().min(1),
    responsibilities: z.array(z.string()).default([]),
    hardRequirements: z.array(z.string()).default([]),
    niceToHave: z.array(z.string()).default([]),
    exclusions: z.array(z.string()).default([]),
    location: z.string().default(''),
    compensation: z.string().default(''),
    teamContext: z.string().default(''),
  }),
  scorecard: z.object({
    version: z.string().default('1.0.0'),
    dimensions: z.array(scorecardDimensionSchema).min(3).max(8),
  }),
  ambiguities: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(4),
        options: z.array(z.string()).min(1),
        recommendedOption: z.string().min(1),
        blocking: z.boolean().default(false),
      }),
    )
    .default([]),
  fairness: z
    .object({
      removed: z
        .array(
          z.object({
            text: z.string(),
            category: z.string(),
            action: z.string(),
          }),
        )
        .default([]),
      findings: z.array(z.string()).default([]),
    })
    .default({ removed: [], findings: [] }),
});

export const interviewPlanSchema = z.object({
  resumeId: z.string().optional(),
  questions: z
    .array(
      z.object({
        question: z.string().min(4),
        target: z.string().default(''),
        evidenceHint: z.string().default(''),
      }),
    )
    .min(1),
  risks: z.array(z.string()).default([]),
  recommendation: z.string().default(''),
});

export const fetchManifestSchema = z.object({
  pulled: z.number().int().min(0),
  duplicates: z.array(z.string()).default([]),
  failed: z.array(z.object({ messageId: z.string(), reason: z.string() })).default([]),
  resumes: z
    .array(
      z.object({
        resumeId: z.string(),
        label: z.string(),
        format: z.string(),
        path: z.string(),
      }),
    )
    .default([]),
});

export type ParseResumeOutput = z.infer<typeof parseResumeSchema>;
export type EvaluateResumeOutput = z.infer<typeof evaluateResumeSchema>;
export type ReviewEvalOutput = z.infer<typeof reviewEvalSchema>;
export type JdAnalysisOutput = z.infer<typeof jdAnalysisSchema>;
export type InterviewPlanOutput = z.infer<typeof interviewPlanSchema>;

export const SCHEMAS = {
  parse_resume: parseResumeSchema,
  evaluate_resume: evaluateResumeSchema,
  review_eval: reviewEvalSchema,
  jd_analysis: jdAnalysisSchema,
  interview_plan: interviewPlanSchema,
  fetch_manifest: fetchManifestSchema,
} as const;

/** 供真实 LLM 使用的 JSON Schema 描述（放进系统提示词）。 */
export function schemaInstruction(name: string): string {
  const schema = (SCHEMAS as Record<string, z.ZodType>)[name];
  if (!schema) return '';
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
