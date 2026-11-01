/** BoLe 平台共享类型定义。类型即文档：所有 Agent 的输入输出都必须落在这些结构上。 */

export type ModelTier = 'flash' | 'pro';

export type AgentId =
  | 'coordinator'
  | 'profiler'
  | 'fetcher'
  | 'parser'
  | 'assessor'
  | 'auditor'
  | 'advisor';

export type TaskKind = 'parse' | 'eval' | 'review';

/** 评估阶段：flash 初筛 → pro 深评 → Self-Loop 返工。 */
export type EvalPhase = 'screen' | 'deep' | 'revise';

/** 任务级状态机：pending → running → staged → committed；失败/取消/拒绝为终态（除非显式重试）。 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'staged'
  | 'committed'
  | 'failed'
  | 'aborted'
  | 'refused';

/** 简历生命周期（SRS FR-S5 的可观察视图）。 */
export type ResumeStatus =
  | 'queued'
  | 'parsing'
  | 'parsed'
  | 'evaluating'
  | 'evaluated'
  | 'verifying'
  | 'verified'
  | 'reported'
  | 'quarantine'
  | 'failed'
  | 'duplicate';

/** 结算语义五分类（借鉴 DSH epochStopReason）。失败优先于取消。 */
export type StopReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'refusal';

export type Conclusion = 'strong_yes' | 'yes' | 'maybe' | 'no' | 'strong_no';

export type Verdict = 'pass' | 're_eval' | 'escalate_human';

export type ClaimVerdict = 'supported' | 'unsupported' | 'missing_evidence';

/** 证据 span：结论 → 原文引用 + 字符偏移。偏移由平台用字符串匹配计算，不由模型编造。 */
export interface Span {
  field: string;
  quote: string;
  charStart: number;
  charEnd: number;
}

/** 模型侧只允许提供 field + quote，偏移由平台解析。 */
export interface RawSpan {
  field: string;
  quote: string;
}

export interface ParsedField {
  value: string;
  confidence: number;
  spans: Span[];
}

export interface ParseResult {
  resumeId: string;
  fields: Record<string, ParsedField>;
  anomalies: string[];
  summary: string;
}

export interface DimensionScore {
  key: string;
  name: string;
  weight: number;
  score: number;
  rationale: string;
  spans: Span[];
}

export interface EvalResult {
  resumeId: string;
  dimensions: DimensionScore[];
  totalScore: number;
  conclusion: Conclusion;
  rationale: string[];
  uncertainties: string[];
  redFlags: string[];
  revisionNotes: string[];
}

export interface ClaimCheck {
  claim: string;
  verdict: ClaimVerdict;
  note: string;
  quote?: string;
}

export interface Compliance {
  risk: 'none' | 'low' | 'high';
  findings: string[];
}

export interface ReviewResult {
  resumeId: string;
  verdict: Verdict;
  checks: ClaimCheck[];
  compliance: Compliance;
  requiredFixes: string[];
  escalationReason?: string;
}

export interface ScorecardDimension {
  key: string;
  name: string;
  weight: number;
  anchors: Record<string, string>;
}

export interface Scorecard {
  version: string;
  dimensions: ScorecardDimension[];
}

export interface Jd {
  title: string;
  responsibilities: string[];
  hardRequirements: string[];
  niceToHave: string[];
  exclusions: string[];
  location: string;
  compensation: string;
  teamContext: string;
}

export interface Ambiguity {
  id: string;
  question: string;
  options: string[];
  recommendedOption: string;
  blocking: boolean;
}

export interface FairnessRemoval {
  text: string;
  category: string;
  action: string;
}

export interface JdAnalysis {
  jd: Jd;
  scorecard: Scorecard;
  ambiguities: Ambiguity[];
  fairness: { removed: FairnessRemoval[]; findings: string[] };
}

export interface FetchManifest {
  pulled: number;
  duplicates: string[];
  failed: { messageId: string; reason: string }[];
  resumes: { resumeId: string; label: string; format: string; path: string }[];
}

export interface InterviewQuestion {
  question: string;
  target: string;
  evidenceHint: string;
}

export interface InterviewPlan {
  resumeId: string;
  questions: InterviewQuestion[];
  risks: string[];
  recommendation: string;
}

export interface JobRow {
  id: string;
  title: string;
  requirements: string;
  jd_json: string | null;
  scorecard_json: string | null;
  fairness_json: string | null;
  status: string;
  seed: string | null;
  archived?: number;
  pinned?: number;
  created_ts: string;
  updated_ts: string;
}

export interface ResumeRow {
  id: string;
  job_id: string;
  label: string;
  sha256: string | null;
  dedup_key: string | null;
  source_msg_id: string | null;
  source_path: string | null;
  raw_path: string | null;
  norm_path: string | null;
  format: string | null;
  status: ResumeStatus;
  reasons_json: string;
  batch_id: number | null;
  created_ts: string;
  updated_ts: string;
}

export interface TaskRow {
  id: string;
  job_id: string;
  resume_id: string;
  batch_id: number;
  status: TaskStatus;
  stop_reason: StopReason | null;
  attempt: number;
  worker_id: string | null;
  result_path: string | null;
  error_json: string | null;
  created_ts: string;
  updated_ts: string;
  committed_ts: string | null;
  [key: string]: unknown;
}

export interface EvidenceRow {
  id: string;
  job_id: string;
  resume_id: string;
  parse_task_id: string | null;
  field: string;
  quote: string;
  char_start: number;
  char_end: number;
  verified: number;
  verdict: string | null;
  note: string | null;
  created_ts: string;
}

export interface EventRow {
  seq: number;
  ts: string;
  job_id: string | null;
  actor: string;
  type: string;
  payload_json: string;
}

export interface DecisionRow {
  id: string;
  job_id: string;
  node: string;
  question: string;
  answer: string;
  actor: string;
  ts: string;
}

export interface UsageRow {
  id: string;
  job_id: string;
  agent: string;
  model: string;
  tier: ModelTier;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  latency_ms: number;
  ts: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
}

export interface ChatImage {
  mimeType: string;
  base64: string;
  /** DeepSeek Vision: low 会先缩到 512×512；简历文字建议 high/original。 */
  detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface ChatRequest {
  agent: string;
  tier: ModelTier;
  model?: string;
  system: string;
  user: string;
  /** 图片输入（仅 user 消息支持；当前用于 DeepSeek Vision OCR）。 */
  images?: ChatImage[];
  schemaName?: string;
  jsonSchema?: unknown;
  temperature?: number;
  maxTokens?: number;
  /** 共享前缀（系统提示词+工具池+评分卡），用于缓存对齐与成本核算。 */
  sharedPrefix?: string;
  /** 流式 token 回调；存在时提供方应使用 streaming 请求。 */
  onToken?: (delta: string) => void;
  /** 真实提供方不读取该字段，保留给测试替身。 */
  meta?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  json?: unknown;
  usage: LlmUsage;
  stopReason: StopReason;
  model: string;
  latencyMs: number;
  cacheHit: boolean;
}

export interface PoolStats {
  name: string;
  capacity: number;
  active: number;
  peak: number;
  acquired: number;
  refused: number;
  released: number;
  timeouts: number;
}

export interface RunMeta {
  runId: string;
  runDir: string;
  jobId: string;
  seed: string;
  startedTs: string;
  llmProvider: string;
}

/** 前端/SSE 的 token 流：一次结构化调用对应一个 taskId。 */
export interface StreamPreviewLine {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'muted';
}

export interface StreamPreview {
  title: string;
  lines: StreamPreviewLine[];
}

export interface StreamToken {
  type: 'token';
  agent: string;
  taskId?: string;
  phase?: string;
  resumeId?: string;
  label?: string;
  attempt?: number;
  delta: string;
  /** 人类可读的增量预览；由服务端 partial-json 解析生成，前端不展示原始 JSON。 */
  preview?: StreamPreview;
}

export type StreamSink = (chunk: StreamToken) => void;

/** 用户上传并落盘的简历文件。 */
export interface UploadedFile {
  uploadId: string;
  filename: string;
  path: string;
  size: number;
  contentType: string;
}
