# 模块说明

## 1. 编排（`src/agents/coordinator.ts`）

- `runPipeline(deps, { requirements, hitl, uploadFiles?, resumeOnly? })`：
  - 非续跑：要求至少一个 `uploadFiles`，调用 `runFetcher`；全部失败则抛错。
  - 续跑：`recoverIncomplete` 从批次检查点恢复。
  - JD 画像 → 批流动 → 短名单深评 → 核查/自环 → 建议 → 报告。
- 批流动：`chunk` + `flowBatches`，`maxBatchesInFlight` 限制在途批；批间无全局 barrier。
- 容量池：`CapacityPool` + `withSlot`，满时 `PoolFullError` 退避重试，不排队。
- 报告：`buildReport` + `selectTopCandidates` + `writeReports`。

## 2. 接入（`src/agents/fetcher.ts` + `src/ingest/*`）

- `runFetcher(deps, { files })`：上传文件 → `normalizeDocument` → 去重 → 落盘 → `resumes` 行。
- `uploads.ts`：保存/读取上传，白名单扩展名，单文件 ≤25MB，ID 校验，meta.json。
- `normalize.ts`：PDF.js、DOCX 解压、HTML 去标签、TXT/MD 解码；图片走 OCR；旧版 `.doc` 明确拒绝。
- `ocr.ts`：本地 Tesseract（`chi_sim+eng`）串行队列；或 `BOLE_OCR_URL` 外部服务。
- `vision-ocr.ts`：DeepSeek V4 Flash Vision OCR；通过 `LlmRouter` 记录 token/成本；默认用于 JPEG/PNG/GIF/WebP，失败可回退本地。
- `dedup.ts`：sha256 + 身份指纹。
- `pii.ts`：报告/日志掩码工具。
- 事件：`fetch.started` / `resume.fetched` / `resume.duplicate` / `resume.fetch_failed` / `fetch.completed`。

## 3. 画像（`src/agents/profiler.ts`）

- 输入 HR 需求；`callAgentJson` 生成 `jd_analysis`（JD + Scorecard + fairness）。
- `scanProtected` 做确定性兜底：识别受保护条件并写入 `fairness.removed/findings`。
- 歧义/权重不合理时通过 HITL 反问；结果写 `jobs.jd_json/scorecard_json/fairness_json`。

## 4. 解析（`src/agents/parser.ts`）

- 输入归一化文本；`runStructuredTask('parse')` 生成 `parse_resume`。
- 每个字段必须有 `spans`；平台定位 quote → `charStart/charEnd`；失败进入 postValidate 重试。
- 最小字段数校验；成功后写 `parse_tasks`，提交简历到 `parsed`。

## 5. 评估（`src/agents/assessor.ts`）

- `AssessorWorker` 有容量池与自环重评能力；`tier/phase` 由 coordinator 指定（screen/deep/revise）。
- 评分维度必须引用原文；`scorecard` 代码按权重重算总分，不采信模型自报总分。
- 输出 `EvaluateResult`；写 `eval_tasks`（tier/phase/loop/attempt）。
- 深评短名单：批次内按初筛分排序，取 `deepEval.percent`（默认 40%）。

## 6. 核查（`src/agents/auditor.ts`）

- `review_eval`：逐条检查评估引用的 claim 是否能被原文支持；输出 `pass/re_eval/escalate_human`。
- 不通过 → `requiredFixes`；coordinator 打回评估，`loop+1`，复用原 Worker 与档位。
- 超过 `selfLoop.maxLoops` → `quarantine` 转人工，写 `escalation_reason`。

## 7. 建议（`src/agents/advisor.ts`）

- 对通过核查的候选人生成 `interview_plan`：问题、追问、风险。
- 失败不阻塞主流程；报告里标注"建议缺失"。

## 8. 结构化调用（`src/core/structured.ts`、`src/agents/structured-call.ts`）

- `runStructuredTask`：任务台账 + 两阶段提交 + schema 校验 + 同轮重试 + postValidate/persist。
- `callAgentJson`：无台账任务（画像/建议）的 schema 重试。
- 两者都支持 `stream` 回调；token 进入 SSE，最终仍以完整 JSON 校验为准。

## 9. 台账与状态（`src/core/*`）

- `ledger.ts`：jobs/resumes/parse_tasks/eval_tasks/review_tasks/events/llm_calls/decisions/batches。
- `state.ts`：任务状态机、简历生命周期、五类 stop reason、单调守卫。
- `events.ts`：append-only 事件；Web/CLI 轮询或 SSE。
- `db.ts`：SQLite schema + `migrate()`（`tier/phase` 等列）。

## 10. 模型（`src/llm/*`）

- `deepseek.ts`：OpenAI 兼容请求；`stream:true` 解析 SSE；usage/cache；429/5xx 退避；无 Key 明确报错。
- `router.ts`：tier→model、JSON schema 提示、成本、缓存前缀、调用记录。
- `cost.ts`：按 token 与单价计算 USD。

## 11. 报告（`src/report/*`）

- `builder.ts`：装配 `ReportData`（job/run/top/escalations/others/compliance/hitl/cost/pools/convergence）。
- `render.ts`：内部生成 `report.md`、`report.json`、`cost-report.md`、`convergence.svg`；HTTP 不暴露下载，对话内只汇总 JSON；**没有 HTML**。
- 报告中 PII 掩码；证据链带 quote 与字符区间。

## 12. Web（`src/web/*`）

- `server.ts`：HTTP + 静态资源 + SSE；上传、run、HITL、candidates、cost、report、resume、agents/doctor/reset、Key 绑定。
- `stream-preview.ts`：用 `partial-json` 解析未完成 JSON，按 agent/phase 转成字段、维度分数、核查裁决；token 事件带 `preview`，前端不展示原始 JSON。
- `data.ts`：jobs/snapshot/candidates/events/cost 查询。
- `ops.ts`：agents/doctor/reset。
- `public/`：无框架对话式 UI；会话列表、对话/工具轨迹、token 卡、HITL、证据抽屉、设置/工具、首次绑定弹窗。

## 13. Key 持久化（`src/settings/key-store.ts`）

- `POST /api/key` 绑定：校验 Key（`/models`，仅 401/403 判无效），AES-256-GCM 加密后写 `data/keyring.json`；主密钥 `data/keyring.key`。
- `GET /api/config` 返回 `{bound, masked, updatedAt}`，前端进入时若未绑定则强制弹窗。
- `DELETE /api/key` 清除绑定；Key 不从环境变量读取，也不回传浏览器。
- CLI 可用 `--key` 临时传入；否则读取服务端已绑定 Key。

## 14. 测试（`tests/*`）

- `unit/`：pool、state、spans、scorecard、ingest、structured、dedup-rag。
- `integration/`：真实上传端到端、失败隔离、检查点续跑、无 Key 失败。
- `fixtures/fake-provider.ts`：只用于测试的确定性提供方；产品路径不引用。
- `fixtures/documents.ts`：生成 DOCX/PDF 测试文件。
