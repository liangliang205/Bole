# BoLe 架构与机制设计

> 本文对应 `BoLe_MVP开发方案.md` §2、§4、§5。所有机制在仓库中都有可运行实现与测试，不做"纸面架构"。

## 1. 设计公理

1. **可验证优先于炫技**：任何结论必须能回到简历原文的连续字符区间；回到不了的结论只能降级或转人工。
2. **机制优先于提示词**：schema 门禁、状态机、单调守卫、容量池、深度预算都由代码强制；提示词负责语义质量，不负责纪律。
3. **失败优先于取消**：先结算 `stop_reason` 再清理；已记录的失败不得被"清理成功"改写。
4. **只有主 Agent 能编排**：子 Agent 深度预算为 0，运行时断言而非口头约定。
5. **结果落盘、引用消费**：子 Agent 写结构化产物，主 Agent 只读台账里的摘要与路径，避免上下文爆炸与"凭空补结果"。
6. **能力边界写进文档**：已知限制、失败明细、mock 与真实的差异全部显式呈现。

## 2. 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 人机层   CLI 交互（HITL-1 需求反问 / HITL-2 终稿确认）          │
│          decisions 表全量留痕（node/问题/回答/actor/时间）      │
├──────────────────────────────────────────────────────────────┤
│ 编排层   coordinator（唯一编排者）                              │
│          parallel（批内并发）· pipeline（批间流动，无全量屏障）  │
│          容量池准入 · Self-Loop 决策 · 汇总与 HITL 门控          │
├──────────────────────────────────────────────────────────────┤
│ Agent 层 profiler(pro) → fetcher(flash) → parser×N(flash)     │
│          → assessor×M(pro) ⇄ auditor(pro) → advisor(pro)      │
│          每个 Agent = preset 配置 + prompt 文件 + zod schema    │
├──────────────────────────────────────────────────────────────┤
│ 工具层   hirebox MCP（mock 邮箱）· RAG（TF-IDF/余弦）           │
│          评分卡确定性计算 · 公平性规则 · span 定位/校验 · PII   │
├──────────────────────────────────────────────────────────────┤
│ 数据层   SQLite 台账（jobs/resumes/parse_tasks/eval_tasks/      │
│          review_tasks/evidence/events/decisions/usage）        │
│          append-only 事件流 · 产物文件（JSON 引用传递）          │
├──────────────────────────────────────────────────────────────┤
│ 模型层   LlmRouter：flash=deepseek-chat / pro=deepseek-reasoner│
│          mock 提供方用于离线确定性演示；统一重试/记账/缓存核算    │
└──────────────────────────────────────────────────────────────┘
```

## 3. 端到端数据流

1. `bootstrap` 创建 job、运行目录、模型路由与 RAG 索引，写 `run.created` 事件。
2. **需求理解**：profiler 用 RAG 检索历史 JD/评分卡 → 模型输出 `jd_analysis`（zod 校验、失败同轮重试）→ 权重归一化 → 确定性公平性规则二次剥离受保护属性 → 逐条 HITL 反问 → `decisions` 落账 → `jobs.jd_json/scorecard_json/fairness_json` 更新。
3. **简历接入**：fetcher 经 MCP `inbox.list` / `inbox.get` 拉取邮件 → MIME 解析附件 → `normalizeDocument`（docx/html/txt/md/pdf）→ 附件 sha256 + 身份指纹去重 → 原文与归一化文本落盘 → `resumes` 表记录 `queued/duplicate/failed`。
4. **批流水线**：按 label 顺序切批（默认 8 份/批），`flowBatches` 允许多批同时流动；每批内：
   - parser 逐份解析（容量池 4），字段 quote 由平台 `locateQuote` 计算字符偏移；
   - 批内解析完成后立即可评估，**不等其他批**；
   - assessor 取评分卡全部维度打分（容量池 2），平台按权重重算总分与结论，模型自报总分不采信；
   - auditor 逐条核对引用（容量池 1），LLM 语义复核 + 确定性 span/公平性规则双管齐下；
   - 裁决 `re_eval` 时续用同一个 assessor 实例（`worker.reused`），最多 2 轮；超限或合规高风险 → `escalate_human`。
5. **汇总**：只读取 `status in (verified, reported)` 的评估 → 排序（总分 → 技术栈 → 年限 → 项目复杂度）→ Top5 → advisor 生成面试建议 → 报告（md/html/json/cost/svg）→ HITL-2 确认 → job `completed`，简历 `reported`。

## 4. 任务状态机与结算语义

任务级：`pending → running → staged → committed`，旁路 `failed / aborted / refused`；`committed` 终态，任何后续写入抛 `AlreadyCommittedError`（单调守卫）。失败/取消任务只能经显式重试回到 `pending`。

简历级（可观察视图）：`queued → parsing → parsed → evaluating → evaluated → verifying → verified → reported`，旁路 `quarantine / failed / duplicate`。`verifying → evaluated` 支持 Self-Loop 回退；恢复场景由 `forceResumeStatus` 显式重置并留痕，不绕过正常状态机。

结算五分类：`completed / max-tokens / aborted / error / refusal`。`combineStopReasons` 实现"失败优先于取消、取消优先于完成"：
- 已记录 `error/max-tokens/refusal` 时，后续 `aborted` 不覆盖；
- 已记录 `completed` 后收到 `aborted`，结果为 `aborted`（取消确实发生）；
- 该函数有独立单测，避免"清理成功=工作成功"。

## 5. 容量池：拒绝不排队与防死锁论证

- `CapacityPool.tryAcquire` 在满载时**立即返回 null** 并累加 refusals，不维护任何等待队列。
- 编排层用 `acquire` 做**有界准入重试**（指数退避 + 抖动，上限 200 次 / 30s），超限抛 `PoolFullError`，任务不会被无限悬挂。
- 为什么不会死锁：池内任务只依赖**已经完成**的上游产物（台账里 committed 的 parse/eval），不会等待仍需本池名额的任务；批 i+1 的解析与批 i 的评估互不阻塞。若改成 FIFO 排队，则可能出现"等待中的任务持有上游依赖"的循环等待。
- 池统计（capacity/peak/acquired/refused/timeouts）写入报告，演示"拒绝确实发生且被有界重试吸收"。

## 6. 批流动（无全量屏障）

`flowBatches` 最多允许 `maxBatchesInFlight=2` 个批同时流动。每个批独立走"解析 → 评估 → 核查"链路；批 2 在第一份简历解析时就开始，而批 1 可能仍在评估。端到端测试通过事件序号断言：

```
event(batch.started, batchId=2).seq < event(batch.completed, batchId=1).seq
```

这样做的收益：首份结果时延从"全部解析完"降为"首批解析完"；代价：台账与报告需要处理"部分候选人有评估、部分没有"的中间态（本实现通过状态机与批次事件解决）。

## 7. 结构化输出两阶段提交

`runStructuredTask` 的固定流程：

```
task: pending → running
  → 模型调用（JSON mode）
  → JSON 解析 → zod schema 校验 → 领域后置校验（引文必须可在原文定位）
  → 失败：把错误列表回喂模型，同轮重试（≤ maxAttempts=2），attempt+1
  → 成功：产物写入 runs/<run>/artifacts/<kind>/<taskId>.json
  → task: staged（result_path 已落盘）
  → persist()：写业务字段/证据行（仍在 staged，可审计）
  → task: committed（committed_ts，之后禁止任何写入）
```

关键点：
- **落盘在提交之前**：崩溃时不会出现"台账说成功、产物不存在"。
- **校验即重试**：错误信息回喂，而不是重新起任务；失败原因记录在 `error_json`。
- **模型不自算偏移**：模型只给 `field + quote`，平台用 `locateQuote` 计算 `charStart/charEnd`，定位失败即视为 schema 违规。
- **总分不自算**：`applyScorecard` 用权重重算总分与结论，模型自报总分只作参考。

## 8. 证据链与核查

- `evidence` 表以 `(resume_id, field, char_start, char_end)` 唯一，重复插入被忽略。
- **偏移基准**：字符区间以归一化文本（`resumes.norm_path`）为基准；原始附件另存于 `resumes.raw_path`，归一化只做换行/空白整理，不改变正文语义。报告与 `bole audit` 显示的区间都可直接用归一化文本复核。
- 解析阶段挂字段级 span；评估阶段挂维度级 span；核查阶段给每条结论一个 `supported / unsupported / missing_evidence` 裁决，并整体标记证据 `verified`。
- 监军与相马官严格分离：不同 preset、不同 prompt、不同调用；监军拥有否决权，但**不能修改评估**，只能打回。
- 双重机制防"橡皮图章"：
  1. 机制层：每条维度必须有证据行；引用需能在原文定位；评估理由出现受保护属性词 → 直接 `escalate_human`；LLM 判 pass 但机制层发现未通过项 → 强制 `re_eval`；
  2. 文化层：prompt 明确"逐条举证，禁止只输出整体通过"，`review_eval` schema 要求 checks 数组且 pass 时不得含非 supported 项。

## 9. 框架取舍：为什么没有直接依赖 Mastra

`开发方案 §5` 选择 Mastra，并在 §11 给出退路："若其 Workflow 语义与批流动需求冲突，退路是仅用其 Agent/模型层，编排层切回自研"。

本 MVP 的实际取舍：

| 维度 | Mastra 方案 | 本仓库 | 结论 |
|---|---|---|---|
| 离线可复现 | 需安装大量依赖、Playground/存储栈较重 | 仅 `zod` + Node 内置能力，`pnpm install` 秒级，无 API Key 可跑 | 参赛演示优先 |
| 评分核心机制 | 需在框架语义内实现容量池/两阶段提交/批流动 | 机制层全部自研，代码即证据 | 评分点必须能讲清实现 |
| 模型接缝 | model router | `src/llm/provider.ts` + `LlmRouter`，真实/ mock 同一路由 | 可替换 |
| 编排接缝 | Workflow suspend/resume | `src/core/pipeline.ts` + `Ledger` 事件溯源 | 可替换 |
| 风险 | 框架快速演进、Workflow 语义可能不匹配批流动 | 无外部编排锁 | 降低演示风险 |

因此本仓库把"可直接复用 Mastra"的部分限定为：模型调用/重试、结构化输出 schema、检索工具封装；编排与验证机制保持自研。这是**有意识的取舍**，不是遗漏：`config/agents.json` 的 preset 结构与 Mastra Agent 定义可一一映射，`runStructuredTask` 与 `flowBatches` 是清晰的替换点。若决赛需要 Playground 演示，可在不改动机制层的前提下加一个只读的 Mastra/HTTP 面板。

## 10. 可观测性与审计

- `events` 表 append-only（数据库触发器禁止 UPDATE/DELETE），字段：`seq/ts/job_id/actor/type/payload_json`。CLI `status` 与 `audit` 都只读事件与台账重建视图。
- 任务台账记录 `worker_id/attempt/result_path/stop_reason/committed_ts`，可回答"谁做的、试了几次、产物在哪、为什么停"。
- `decisions` 表记录每次 HITL：问题、选项、回答、操作者（区分 `HR(console)` 与 `HR(auto-demo)`）、时间。
- `usage` 表按 agent/model/tier 记账；`cost-report.md` 输出按阶段、按模型、缓存对齐三张表。
- 报告中的"核查否决率"与"失败明细"直接来自台账，不由模型撰写。

## 11. 错误处理矩阵

| 故障 | 处理 | 台账表现 |
|---|---|---|
| schema 不符 | 同轮回喂错误重试（≤2） | `attempt` 递增；仍失败 → `failed` |
| 单份解析失败 | 该份 `failed`，批次继续 | `resumes.status=failed`，失败明细进报告 |
| 模型超时/限流 | 提供方指数退避（≤3）；路由层记录 | `stop_reason=error`，任务 `failed` |
| 核查驳回 | Self-Loop ≤2，续用原 Worker | `worker_id` 不变，`revision_of` 指向上一版评估 |
| Self-Loop 超限 | 转人工 | `review_tasks.verdict=escalate_human`，简历 `quarantine` |
| 证据缺失 | 一票否决该结论 | `evidence.verified=0`，`missing_evidence` |
| MCP 故障 | 拉取失败如实上报，不伪造简历 | `manifest.failed` + `fetch.failed` 事件 |
| 进程中断 | P0 批次粒度重跑：未提交任务 `aborted`，简历重置 | `recovery.*` 事件；已提交产物复用 |
| 全部简历不可用 | 终止流水线并给出失败明细 | CLI 非零退出，错误信息含原因 |

## 12. 代码地图

| 关注点 | 文件 |
|---|---|
| preset 注册表与校验 | `src/core/registry.ts`、`config/agents.json` |
| 事件与台账 | `src/core/events.ts`、`src/core/ledger.ts`、`src/core/db.ts` |
| 状态机/结算 | `src/core/state.ts` |
| 容量池/批流动 | `src/core/pool.ts`、`src/core/pipeline.ts` |
| 两阶段提交 | `src/core/structured.ts` |
| 模型路由/成本/缓存 | `src/llm/router.ts`、`src/llm/mock.ts`、`src/llm/deepseek.ts` |
| MCP | `src/mcp/server.ts`、`src/mcp/client.ts` |
| 归一化/去重/PII | `src/ingest/*` |
| 评分卡/公平性/RAG | `src/tools/*` |
| 各 Agent | `src/agents/*.ts` + `config/prompts/*.md` |
| 编排 | `src/agents/coordinator.ts` |
| 报告 | `src/report/builder.ts`、`src/report/render.ts` |
| 演示与 CLI | `src/cli/index.ts`、`src/cli/demo-data.ts` |
