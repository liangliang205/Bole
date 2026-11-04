# 架构

## 1. 设计原则

1. **证据优先**：任何字段、评分、核查结论都必须带原文引用；字符区间由平台计算，模型只负责"引用哪句话"。
2. **模型做判断，代码做纪律**：模型给语义判断；权重、总分、状态迁移、去重、PII、报告由代码确定性执行。
3. **扇出用 flash，判断/否决用 pro**：解析/初筛是高并发扇出，走 `deepseek-flash`（关闭 thinking）；JD 画像、深评、核查、完成后对话走 `deepseek-v4-pro`（thinking enabled + reasoning_effort=high）。面试建议只在完成后对话中按需加载 skill，不属于流水线阶段。
4. **无全局 barrier**：按批流动，批内解析→初筛→深评→核查；批间最多 2 批在途，单批慢不阻塞其他批。
5. **两阶段提交 + 单调守卫**：`running → staged → committed`；committed 后拒绝再写，避免重试覆盖已确认结论。
6. **真实数据**：只接收用户上传的真实简历；没有 mock 模型、演示 JD、故障注入或预置黄金集。

## 2. 组件

```text
┌────────────────────────────────────────────────────────────┐
│ Web（对话式控制台）                                          │
│  会话列表 · 对话/工具轨迹 · token 流 · HITL 卡片 · 证据抽屉   │
│  /api/uploads · /api/run · /api/run/:id/stream (SSE) ...     │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼─────────────────────────────────┐
│ 编排层                                                       │
│  Coordinator：JD → 接入 → 批流动 → 短名单 → 深评 → 核查 → 报告 │
│  CapacityPool：parse=4 / assess=2 / review=1，满则拒绝+退避     │
│  EventLog：append-only 事件；SSE 推送 + 台账回放               │
└───────┬──────────────┬──────────────┬──────────────────────┘
        │              │              │
┌───────▼──────┐ ┌─────▼──────┐ ┌─────▼──────────┐
│ 接入/归一化   │ │ 结构化调用  │ │ 证据/核查       │
│ 上传落盘      │ │ zod schema │ │ quote→span      │
│ PDF/DOCX/OCR  │ │ 同轮重试   │ │ 逐条 verdict    │
│ 去重/PII      │ │ 两阶段提交 │ │ 自环/转人工     │
└───────┬──────┘ └─────┬──────┘ └─────┬──────────┘
        │              │              │
┌───────▼──────────────▼──────────────▼──────────────────────┐
│ 基础设施                                                     │
│ SQLite 台账（jobs/resumes/tasks/evidence/events/usage/decisions） │
│ 模型提供商（DeepSeek 内置 / 自定义网关；Key AES-256-GCM 加密）    │
│ 知识库 SQLite（默认关闭，仅评估阶段召回）                         │
│ MCP 插件服务（仅完成后对话生效，白名单 + 凭据加密）               │
│ 运行目录（raw/norm/artifacts/report.md/report.json/...）      │
└──────────────────────────────────────────────────────────────┘
```

## 3. 流水线

1. **画像师（pro）**：把 HR 原始需求结构化为 `Jd + Scorecard`；剥离性别/年龄/婚育/籍贯/民族/星座/残障/宗教等受保护条件；有歧义时 HITL。
2. **探马（确定性代码）**：读取 `data/uploads/<uploadId>/`，按扩展名归一化：
   - PDF → PDF.js 文本层；
   - DOCX → 解压 `word/document.xml`；
   - 图片 → DeepSeek V4 Flash Vision（JPEG/PNG/GIF/WebP；失败或 BMP/TIFF 回退 Tesseract）；
   - TXT/MD/HTML → 解码/去标签。
   去重：文件 sha256 + 身份指纹；命中标记 `duplicate`，不进入解析。
3. **批流动**：`batch=8`，`maxBatchesInFlight=2`；每批：
   - 录事（flash）解析字段 + span；
   - 相马官（flash）初筛；
   - 取 Top40% 进入相马官（pro）深评；
   - 监军（pro）逐条核查。
4. **验真环**：核查不通过 → 打回重评（复用原评估 Worker 与档位），最多 2 轮；仍不足 → `quarantine` 转人工。
5. **完成后对话（主 Agent 直答 + 档位路由）**：筛选完成后 `coordinator` 作为主 Agent 直接回答，或按需调用导出/MCP 工具；对话档位由 `src/chat/tier.ts` 按任务复杂度在 flash/pro 间选择（寒暄/短问答 flash，比较/复盘/长问题 pro）。**对话链路不派生额外子 Agent**；多 Agent 扇出只发生在多简历筛选批次。面试建议 skill 只在相关提问时加载，不进入筛选流水线。
6. **按需导出**：报告落盘后不会自动生成文件。筛选完成后的主 Agent 对话中，只有 HR 明确要求生成/导出 Word、PDF 或其他文件时，模型才通过 OpenAI Function Calling 调用 `src/tools/tools-call.ts` 注册的工具（`load_workspace_dependencies` 来自 DeepSeek 官方 DSH 包；`export_word` 基于 docx 库；`office_export_pdf` 基于官方 `@deepseek-ai/libreoffice-kit`；`python_exec` 在子进程执行 Python）。产物写入运行目录，对话中返回下载链接。
7. **报告**：Markdown + JSON + 成本报表 + 收敛 SVG；不生成 HTML，不提供下载。
8. **知识库（可选）**：原生 SQLite；创建并启用后才生效。画像完成后用 JD + 评分卡生成检索词，**只有相马官评估阶段**会召回 Top-K 片段并注入上下文；未配置 embedding 时退化为关键词检索。
9. **外接 MCP（插件化）**：插件库存 `data/mcp/plugins.json`（凭据加密），支持 stdio/HTTP、启停、allow/deny 工具；**只在筛选完成后的主 Agent 对话中生效**，不进入批次关键路径。单个插件失败只标记自身。

## 4. 档位与路由

- 配置：`config/agents.json` 每个 preset 的 `tier`；`config/pipeline.json` 的 `models`、`deepEval`。
- `LlmRouter` 负责 tier→model、温度 0、token 记账、成本、缓存前缀；`DeepSeekProvider` 负责 HTTP/streaming（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）。`ProviderStore` 管理多个提供商，当前使用项在设置页切换。
- `eval_tasks` 记录 `tier`（flash/pro）与 `phase`（screen/deep/revise），报告按 `${schema}@${tier}` 聚合成本。
- 深评短名单：批次内按初筛分排序取前 `deepEval.percent`（默认 40%），异常/边界样本可进入深评。

## 5. 证据与审计

- 模型输出 `quote`；平台用 `locateQuote` 在归一化文本中定位 `charStart/charEnd`，支持空白差异与省略号片段。
- 解析任务的每个字段必须有 span；评估维度必须有引用；核查逐条给出 `supported/unsupported`。
- 监军不通过时写 `requiredFixes`，评估任务回到 `re_eval`；第二轮记录 `revisionOf`。
- 报告中的 `evidenceChain` 与候选人详情都来自已 committed 的任务，不重新让模型"回忆"。

## 6. 状态与台账

- 任务状态：`queued → running → staged → committed`；失败/取消为终态；committed 单调守卫。
- 简历状态：`queued → parsing → parsed → evaluating → evaluated → verifying → verified → reported`；可回退到 `evaluating` 重评；`quarantine/failed/duplicate` 为旁路终态。
- 事件 append-only；`seq` 单调递增，SSE 按 `sinceSeq` 增量推送。
- 批检查点：`batches` 表记录每批阶段；`resume` 从检查点续跑，不重复已完成任务。
- `usage` 记录每次调用（agent/model/tier/tokens/cost/cache），成本页与报告由此聚合。

## 7. 流式与前端

- `DeepSeekProvider` 使用 `stream:true` + SSE 解析；`onToken` 回调把 delta 传给 `AgentDeps.stream`。
- `runStructuredTask`/`callAgentJson` 在调用时注入 `onToken`，携带 agent/taskId/phase/resumeId/label/attempt。
- Web 服务用 `StreamPreviewer`（`partial-json`）把未完成 JSON 转成人类可读的字段、维度分数、核查裁决，token 事件同时携带 `preview`；前端只展示 preview，不展示原始 JSON。重试时按 `attempt` 重置缓冲，避免坏 JSON 与重试拼接。
- Web 服务维护每个 job 的 listener 集合；`GET /api/run/:id/stream` 推送：
  - `status`：运行状态、待回答 HITL、报告可用性；
  - `snapshot`：台账计数；
  - `log`：增量事件；
  - `token`：原始生成 token；
  - `done`：结束。
- 前端不构建、无框架：`index.html + app.js + styles.css`；对话区渲染里程碑与工具轨迹，底部显示实时 token 卡片，HITL 卡片固定在输入框上方。
- 报告通过 `/report`（JSON）在对话内汇总，并供后续 MCP 使用；不提供 Markdown/JSON 下载，也没有 HTML 报告路由。

## 8. 失败处理

| 故障 | 行为 |
|---|---|
| 单个上传不支持/OCR 失败 | 该简历 `failed`，批次继续；报告列失败原因 |
| 全部上传失败 | 运行失败，返回可读错误与失败明细 |
| schema 违规 | 同轮重试（≤2），错误回喂；仍失败任务 `failed` |
| 模型 429/5xx | 指数退避重试；已推送 token 后不重试，避免重复内容 |
| 核查不通过 | 自环重评 ≤2 轮；仍不足转人工 |
| 容量池饱和 | 有界退避重试；超过准入超时（30s）该任务失败，计入失败明细 |
| 输出被 max-tokens 截断 | 输出预算翻倍重试一次（上限 32768）；仍失败任务 `failed` |
| 运行中断 | 批次检查点续跑；committed 不重跑 |
| 未配置 Key | `bootstrap` 立即失败；无 mock 回退 |

## 9. 安全与边界

- 默认只监听 `127.0.0.1`；无登录/多租户，公网需反向代理 + 鉴权。Docker 容器内监听 `0.0.0.0:8787` 且 compose 发布端口，直接暴露等于无鉴权裸奔。
- Key 由服务端 AES-256-GCM 加密持久化在 `data/providers.json`，不从环境变量读取；Web 首次进入检查当前提供商，缺失时打开设置。Key 不写台账、不写报告、不回传浏览器。
- 报告/事件/日志做 PII 掩码；台账保存哈希与路径；原始简历在 `runs/` 与 `data/uploads/` 中为明文，依赖文件系统权限。
- 完成后对话的 `python_exec` 在子进程执行任意 Python，**没有沙箱**；简历文本与 MCP 返回都属于不可信输入，存在间接提示注入 → 本地代码执行的风险。MCP 插件权限等同当前用户，只应安装可信插件。
- 图片 OCR 准确率有限；扫描版 PDF 需转图片；这些边界在 UI 与 `docs/LIMITATIONS.md` 中明示。

## 10. 关键文件

| 主题 | 文件 |
|---|---|
| 编排 | `src/agents/coordinator.ts` |
| 接入 | `src/agents/fetcher.ts`、`src/ingest/{uploads,normalize,ocr,dedup,pii}.ts` |
| 解析/评估/核查 | `src/agents/{parser,assessor,auditor}.ts` |
| 结构化提交 | `src/core/structured.ts`、`src/core/state.ts` |
| 容量池/批流动 | `src/core/{pool,pipeline}.ts` |
| 台账/事件 | `src/core/{ledger,events}.ts` |
| 模型 | `src/llm/{deepseek,router,cost}.ts` |
| 提供商与 Key | `src/settings/{provider-store,key-store}.ts` |
| 知识库 | `src/knowledge/service.ts` |
| MCP 插件 | `src/mcp/*` |
| 完成后对话 / 面试 skill | `src/chat/{orchestrator,tier,context,service,interview-skill}.ts`、`src/tools/tools-call.ts` |
| 报告 | `src/report/{builder,render}.ts` |
| Web/SSE | `src/web/{server,data,ops}.ts`、`src/web/public/*` |
| 测试 | `tests/unit/*`、`tests/integration/*`、`tests/fixtures/*` |
