# Agent Preset 注册表与提示词规范

> 清单元数据：`config/agents.json`；角色提示词：`config/prompts/*.md`；运行时校验：`src/core/registry.ts`。
> 角色 = 配置。换模型档、改工具集、加版本都只改配置，不改编排代码。

## 1. 七个 Agent

| id | 名称 | 档位 | maxDepth | 输出 schema | 工具集 | 提示词 |
|---|---|---|---|---|---|---|
| `coordinator` | 伯乐（唯一编排者） | pro | 1 | `coordinator_plan` | dispatch / send_message / stop / query_workspace / hitl | `coordinator.md` |
| `profiler` | 需求画像师 | pro | 0 | `jd_analysis` | rag_search / fairness_scan / scorecard_validate | `profiler.md` |
| `fetcher` | 探马 | flash | 0 | `fetch_manifest` | mcp:hirebox / dedup / normalize | `fetcher.md` |
| `parser` | 录事 | flash | 0 | `parse_resume` | read_resume / span_locate | `parser.md` |
| `assessor` | 相马官 | flash（初筛）/ pro（深评） | 0 | `evaluate_resume` | rag_search / scorecard_compute / span_locate | `assessor.md` |
| `auditor` | 监军 | pro | 0 | `review_eval` | span_verify / fairness_scan / ledger_query | `auditor.md` |
| `advisor` | 谋士 | pro | 0 | `interview_plan` | rag_search / scorecard_compute | `advisor.md` |

协作硬约束：

1. 只有 `coordinator` 能委派；子 Agent 的 `canDelegate=false`、`maxDepth=0`，运行时 `ExecutionContext.assertMayDelegate()` 直接抛 `DepthExceededError`。
2. 子 Agent 之间不直接通信；一切经台账与主 Agent 裁决。
3. 监军对相马官有否决/打回权；二者 preset 严格分离，禁止同一 preset 既评又核。
4. 子 Agent 结果必须落盘为结构化 JSON；主 Agent 只消费摘要 + 引用。

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
| `interview_plan` | `questions[{question,target,evidenceHint}]` / `risks` / `recommendation` | 4–6 个问题；不得使用受保护属性 |
| `fetch_manifest` | `pulled` / `duplicates` / `failed` / `resumes` | 计数必须来自实际处理 |

schema 用 zod 定义在 `src/schemas.ts`；真实模型调用时由 `z.toJSONSchema` 生成 JSON Schema 附在系统提示词后，并用 JSON mode 约束输出。

## 3. 提示词纪律（从方案 §4 借鉴）

- **任务书自包含**（`src/agents/prompts.ts#taskBook`）：任务、输入路径、参考、schema、完成标准、边界六段缺一不可；缺路径/标准视为"甩锅式委派"。
- **证据纪律**：parser/assessor 的 prompt 明确"quote 必须逐字来自原文，offset 由平台计算"；auditor 明确"逐条举证，禁止只输出整体通过"。
- **公平性红线**：profiler/assessor/auditor 都写明禁止使用受保护属性；但真正的兜底是 `src/tools/fairness.ts` 的规则与运行时的强制覆盖。
- **返工纪律**：assessor 收到驳回意见后逐条修正、保留未驳回部分，并在 `revisionNotes` 写明修改；实测 R17 即此路径。
- **不作决定**：advisor 只给问题/风险/建议；报告不生成 offer/拒信。

## 4. 版本与可审计

- `config/agents.json` 有整体 `version`，每个 preset 也有 `version`；`config/pipeline.json` 也有 `version`。
- 启动时注册表计算 `fingerprint`（agents.json + pipeline.json 的 sha256 前 12 位），写入 `runs/<runId>/run.json` 与 `run.created` 事件。
- 改 prompt 文本不会改变 fingerprint（prompt 未参与哈希）——这是当前实现的已知小缺口；P1 会把 prompt 内容纳入指纹。
- `bole agents` 打印当前版本、指纹与工具集，便于演示"角色=配置"。

## 5. 模型档位与路由

| 档位 | 默认模型 | 用途 | 覆盖方式 |
|---|---|---|---|
| flash | `deepseek-chat` | 接入、解析、评估初筛 | `BOLE_FLASH_MODEL` 或 `config/pipeline.json#models.flash` |
| pro | `deepseek-reasoner` | 画像、评估深评、核查、汇总/面试 | `BOLE_PRO_MODEL` 或配置 |

深评比例与档位在 `config/pipeline.json`：

```json
"deepEval": { "enabled": true, "percent": 40, "tier": "pro" }
```

把它设为 `enabled:false` 即为"全量 flash 评估"（成本最低、质量风险最高）；把 assessor preset 改回 `pro` 且关闭深评即为"全量 pro 评估"（质量优先、成本最高）。两种极端都在配置层可切换，无需改代码。

`LlmRouter` 负责：tier→model 映射、温度 0、JSON mode、错误重试、usage 记账、缓存前缀核算。提供方在 `src/llm/provider.ts` 定义，mock 与 DeepSeek 走同一路由，替换只需改 `bootstrap.ts` 的构造参数。

## 6. 新增一个 Agent 的步骤

1. 在 `config/agents.json` 增加 preset（id/名称/档位/工具/schema/maxDepth/prompt/version）。
2. 在 `config/prompts/` 增加提示词（任务书、完成标准、边界、输出结构）。
3. 在 `src/schemas.ts` 增加 zod schema，并注册到 `SCHEMAS`。
4. 在 `src/agents/` 实现 Worker（复用 `runStructuredTask` 获得两阶段提交、重试、落盘）。
5. 在 `src/core/registry.ts` 的 `AGENT_IDS` 与 `KNOWN_SCHEMAS` 注册。
6. 若参与批流水线，在 `coordinator.ts` 增加 stage，并为它配置容量池与准入参数。
7. 增加单测/集成断言（至少覆盖 schema 失败重试与状态迁移）。
8. 更新本文件与 README 的角色表。

> 新增 Agent 不需要改模型路由、台账 schema 或报告渲染骨架；这也是"preset 注册表"选型的直接收益。
