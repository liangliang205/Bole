# Agent Preset 注册表与提示词规范

> 清单元数据：`config/agents.json`；角色提示词：`config/prompts/*.md`；运行时校验：`src/core/registry.ts`。
> 角色 = 配置。换模型档、改工具集、加版本都只改配置，不改编排代码。

## 1. 六个 preset（5 个 LLM 角色 + 1 个确定性接入器）

| id | 名称 | 档位 | maxDepth | 输出 schema | 可执行工具 | 能力标签 | 提示词 |
|---|---|---|---|---|---|---|---|
| `coordinator` | 伯乐（主 Agent / 编排者） | pro（对话按复杂度覆盖为 flash/pro） | 1 | `coordinator_plan` | export_word / office_export_pdf / load_workspace_dependencies / python_exec | pipeline_orchestration / screening_plan / dispatch / hitl / aggregate / chat_tiering | `coordinator.md` |
| `profiler` | 需求画像师 | pro | 0 | `jd_analysis` | — | rag_search / fairness_scan / scorecard_validate | `profiler.md` |
| `fetcher` | 探马 | flash | 0 | `fetch_manifest` | — | upload_read / dedup / normalize / ocr | `fetcher.md` |
| `parser` | 录事 | flash | 0 | `parse_resume` | — | read_resume / span_locate | `parser.md` |
| `assessor` | 相马官 | flash（初筛）/ pro（深评） | 0 | `evaluate_resume` | — | rag_search / scorecard_compute / span_locate | `assessor.md` |
| `auditor` | 监军 | pro | 0 | `review_eval` | — | span_verify / fairness_scan / ledger_query | `auditor.md` |

> **`tools` 与 `capabilities` 是两件事。** `tools` 必须是真实可执行的 Function Calling 工具：注册表用 `KNOWN_TOOLS` 校验，声明未实现的名字会**启动失败**（测试见 `tests/unit/registry.test.ts`）。`capabilities` 只是声明式能力标签，说明代码在该角色里实际调用了什么；流水线里的 span 定位、评分重算、去重、检索都由代码直接调用，不经过模型选择工具。

### 上传后的筛选计划（Agent 决策，不硬编码）

接入完成、解析开始前，主 Agent 会读 `config/skills/screening-plan.md`，输出 `screening_plan`：

| 字段 | 含义 |
|---|---|
| `mode` | `single`（单批串行，不扇出）/ `batch`（按批并发） |
| `batchSize` / `maxBatchesInFlight` | 批大小与在途批数 |
| `pools.parse` / `assess` / `review` | 各阶段并发 |
| `deepEval` | 是否深评及比例 |
| `reason` | 必须结合可用/重复/失败/格式，不能套固定值 |

代码只做边界钳制（batch 1–16、在途 1–4、池 1–8/1–4）并执行；失败时回退配置默认值。计划写入 `screening.plan` 事件与 `artifacts/plan/screening_plan.json`，可审计。单份简历不会为了“看起来多 Agent”而强行扇出。

### 多 Agent 扇出与档位

- **扇出由上面的 `screening_plan` 决定**：多简历通常 `batch`，单简历 `single`（跳过深评）；不再是固定按 8 切批。
- **完成后对话不派生额外 Agent**：由 `coordinator`（主 Agent）直接回答或调用导出/MCP 工具；对话档位由 `src/chat/tier.ts` 按任务复杂度选择（寒暄/短问答 flash，比较/复盘/长问题 pro）。
- 控制台/配置里的 `tier` 是默认值；实际使用档位记录在 `usage.tier` 与 `eval_tasks.tier`，可审计。

协作硬约束：

1. 只有 `coordinator` 允许委派（`canDelegate=true`）；注册表在加载时校验子角色 `canDelegate=false`、`maxDepth=0`，配置违规直接启动失败。
2. 子角色之间不直接通信；一切经台账与编排代码，对话链路只由主 Agent 访问工具。
3. 监军对相马官有否决/打回权；二者 preset 严格分离，禁止同一 preset 既评又核。
4. 子任务结果必须落盘为结构化 JSON；汇总只消费摘要 + 引用。

### 档位覆盖：assessor 的双阶段

`assessor` 的 preset 档位是 `flash`（全量初筛）。短名单深评由编排层显式覆盖为 `pro`：

| 阶段 | 触发 | 档位 | 台账标记 |
|---|---|---|---|
| 初筛 | 全部解析成功的候选人 | flash | `eval_tasks.phase='screen'` |
| 深评 | 批内 Top40% + 解析异常/不确定项 | pro（`pipeline.json#deepEval.tier`） | `phase='deep'` |
| 返工 | 监军 `re_eval` 后 | 沿用被核查那次的档位 | `phase='revise'` |

这属于"平台按任务难度分配档位"，不是新增 Agent：同一 preset、同一 prompt、同一 schema，只有 `tier` 参数不同；`eval_tasks.tier` 记录实际使用的档位，报告与 `bole audit` 可见。

## 2. 输出 schema

| schema | 关键字段 | 校验要点 |
|---|---|---|
| `jd_analysis` | `jd` / `scorecard` / `ambiguities` / `fairness` | 3–8 个维度、权重为正；疑点必须有选项；受保护条件不得进入评分卡 |
| `parse_resume` | `fields[{value,confidence,spans[{field,quote}]}]` / `anomalies` / `summary` | 字段值非空则至少一条 quote；quote 必须能在原文定位 |
| `evaluate_resume` | `dimensions[{key,score,rationale,evidence[]}]` / `uncertainties` / `redFlags` | 必须覆盖评分卡全部维度且不得新增；每维度至少一条 quote 可定位 |
| `review_eval` | `verdict` / `checks[{claim,verdict,note,quote?}]` / `compliance` / `requiredFixes` | 逐条 verdict 非空；pass 不得含非 supported；re_eval 必须有可执行 fixes |
| `fetch_manifest` | `pulled` / `duplicates` / `failed` / `resumes` | 计数必须来自实际处理 |

schema 用 zod 定义在 `src/schemas.ts`；真实模型调用时由 `z.toJSONSchema` 生成 JSON Schema 附在系统提示词后，并用 JSON mode 约束输出。

## 3. 提示词纪律（从方案 §4 借鉴）

- **任务书自包含**（`src/agents/prompts.ts#taskBook`）：任务、输入路径、参考、schema、完成标准、边界六段缺一不可；缺路径/标准视为"甩锅式委派"。
- **证据纪律**：parser/assessor 的 prompt 明确"quote 必须逐字来自原文，offset 由平台计算"；auditor 明确"逐条举证，禁止只输出整体通过"。
- **公平性红线**：profiler/assessor/auditor 都写明禁止使用受保护属性；但真正的兜底是 `src/tools/fairness.ts` 的规则与运行时的强制覆盖。
- **返工纪律**：assessor 收到驳回意见后逐条修正、保留未驳回部分，并在 `revisionNotes` 写明修改。
- **不作决定**：平台只给筛选建议；面试问题/风险提示改为完成后对话中的按需 skill，不自动生成。
- **面试建议 skill**：`src/chat/interview-skill.ts`；只有 HR 明确询问“面试怎么问/追问/注意什么”时才加载，不注册 Agent，不进入流水线。

## 4. 版本与可审计

- `config/agents.json` 有整体 `version`，每个 preset 也有 `version`；`config/pipeline.json` 也有 `version`。
- 启动时注册表计算 `fingerprint`（agents.json + pipeline.json 的 sha256 前 12 位），写入 `runs/<runId>/run.json` 与 `run.created` 事件。
- 改 prompt 文本不会改变 fingerprint（prompt 未参与哈希）——这是当前实现的已知小缺口；P1 会把 prompt 内容纳入指纹。
- `bole agents` 打印当前版本、指纹、可执行工具与能力标签，便于演示"角色=配置"。

## 5. 模型档位与路由

| 档位 | 默认模型 | 用途 | 覆盖方式 |
|---|---|---|---|
| flash | `deepseek-flash` | 接入、解析、评估初筛（thinking disabled） | `BOLE_FLASH_MODEL` 或 `config/pipeline.json#models.flash` |
| pro | `deepseek-v4-pro` | 画像、评估深评、核查、完成后对话中的复杂问题（thinking high） | `BOLE_PRO_MODEL` 或配置 |

完成后对话由 `src/chat/tier.ts` 做**启发式档位路由**：寒暄/短问答走 flash；比较、复盘、面试、长问题、附件或文件操作走 pro。选择结果写入 `usage.tier`，成本页可审计。

深评比例与档位在 `config/pipeline.json`：

```json
"deepEval": { "enabled": true, "percent": 40, "tier": "pro" }
```

把它设为 `enabled:false` 即为"全量 flash 评估"（成本最低、质量风险最高）；把 assessor preset 改回 `pro` 且关闭深评即为"全量 pro 评估"（质量优先、成本最高）。两种极端都在配置层可切换，无需改代码。

`LlmRouter` 负责：tier→model 映射、温度 0、JSON mode、错误重试、usage 记账、缓存前缀核算。模型提供商由 `ProviderStore` 管理，支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages；统一走 `DeepSeekProvider`（`protocol` 与 `deepseekStyle` 区分请求参数）；测试替身仅存在于 `tests/fixtures/`，不会进入 `bootstrap` 的生产分支。

## 6. 新增一个 Agent 的步骤

1. 在 `config/agents.json` 增加 preset（id/名称/档位/工具/schema/maxDepth/prompt/version）。
2. 在 `config/prompts/` 增加提示词（任务书、完成标准、边界、输出结构）。
3. 在 `src/schemas.ts` 增加 zod schema，并注册到 `SCHEMAS`。
4. 在 `src/agents/` 实现 Worker（复用 `runStructuredTask` 获得两阶段提交、重试、落盘）。
5. 在 `src/core/registry.ts` 的 `AGENT_IDS` 与 `KNOWN_SCHEMAS` 注册。
6. 若参与批流水线，在 `coordinator.ts` 增加 stage，并为它配置容量池与准入参数。
7. 增加单测/集成断言（至少覆盖 schema 失败重试与状态迁移），并跑 `pnpm typecheck && pnpm lint && pnpm test:all`。
8. 更新本文件与 README 的角色表。

> 新增 Agent 不需要改模型路由、台账 schema 或报告渲染骨架；这也是"preset 注册表"选型的直接收益。
