# 评测与验收

> 原则：**只写能复跑的结果**。当前版本已移除 mock 模型与黄金简历集，因此不再声称"Top5 冻结基线"或"模型质量 A/B"；这些需要真实 API Key 与人工标注数据，属于后续工作。

## 1. 评测对象

伯乐当前可被客观验证的是**机制与产物**，不是"筛得准不准"：

| 层级 | 验证内容 | 证据 |
|---|---|---|
| 接入 | 真实上传文件可落盘、去重、格式归一（PDF/DOCX/HTML/TXT/图片 OCR） | `tests/unit/ingest.test.ts` |
| 调度 | 容量池满时拒绝而非排队；批流动无全局 barrier；检查点续跑 | `tests/unit/pool.test.ts`、`tests/integration/*` |
| 状态 | 任务两阶段提交、committed 单调守卫、简历生命周期回退 | `tests/unit/state.test.ts`、`tests/unit/structured.test.ts` |
| 证据 | quote → 字符区间定位；偏移错误能被识别 | `tests/unit/spans.test.ts` |
| 评分 | 总分由代码按权重重算，不采信模型自报总分 | `tests/unit/scorecard.test.ts` |
| 模型接口 | schema 违规同轮重试；流式回调；三种协议（OpenAI Chat/Responses、Anthropic Messages）；成本/缓存记账 | `tests/unit/structured.test.ts`、`tests/unit/deepseek-stream.test.ts`、`tests/integration/pipeline.test.ts` |
| Vision OCR | 图片以 `image_url` 发送；OCR usage 计入 fetcher；本地回退可配置 | `tests/unit/deepseek-stream.test.ts`、`tests/integration/pipeline.test.ts` |
| 成本 | 官方 peak/off-peak 价格与缓存命中 | `tests/unit/cost.test.ts` |
| 流式预览 | 未完成 JSON → 人类可读字段/分数/裁决；不泄露原始 JSON | `tests/unit/stream-preview.test.ts` |
| 报告 | 对话内汇总；内部 JSON；不生成 HTML、不提供下载 | `tests/integration/pipeline.test.ts` |
| 真实上传端到端 | 4 份 TXT（含重复）+ 伪造结论触发验真环 + 报告 | `tests/integration/pipeline.test.ts` |
| 失败隔离 | `.doc` 旧格式失败但批次继续；全失败给出可读错误 | `tests/integration/errors.test.ts` |

## 2. 复跑命令

```bash
pnpm typecheck
pnpm test:all
```

当前结果：**71 个测试通过，0 失败**（2026-11，Node 24 / Windows）。测试使用 `tests/fixtures/fake-provider.ts` 作为**测试替身**，并用本地 SSE 服务器验证 DeepSeek/OpenAI/Anthropic 流式解析、档位参数、暂停/续跑、Qwen thinking 关闭与 max-tokens 扩容、模型目录（含阿里云 MaaS `/api/v1/models`）与 Vision 图片消息；替身只存在于 `tests/`，不进入产品运行时。产品路径没有 mock 分支。

## 3. 真实数据验收（需要 Key）

```bash
pnpm web
# 首次进入在「设置 → 模型」添加/选择模型提供商（服务端加密持久化）
```

建议用 10–30 份真实简历（至少包含 1 份 PDF、1 份 DOCX、1 张图片）走一遍，检查：

1. `/api/run/:id/events` 中 `resume.fetched` 的 `format` 与 `chars` 是否符合预期；
2. `token` 事件是否连续（SSE 未被代理缓冲）；
3. 最终对话消息中 Top 候选人的 `evidenceChain` 是否都有 `quote` 与 `charStart/charEnd`；
4. 被核查打回的候选人是否留下 `review.verdict=re_eval` 与第二轮 `eval` 记录；
5. 成本报表的 `promptTokens/completionTokens` 是否来自 DeepSeek `usage`（流式缺少 usage 时为估算，报告中会体现模型与计价）。

> 真实模型输出具有随机性（温度=0 仍可能 ±1 分），不要用一次运行的结果当"模型质量"结论；需要多次重复与人工评分。

## 4. 成本与缓存

- 成本按 `config/pipeline.json` 中 `deepseek-flash` / `deepseek-v4-pro` 的官方 price 与 token 用量计算，单位为 USD；按 UTC 工作日峰谷时段自动应用 off-peak 五折。
- 缓存命中优先读取 DeepSeek `prompt_cache_hit_tokens`；流式响应若未返回 usage，按 `estimateTokens` 估算并在成本页标注。
- 档位策略：解析/初筛 flash，画像/深评/核查/建议 pro；`eval_tasks.tier/phase` 可在候选人详情与审计中核对。
- 当前没有"降本 X%"的可靠结论：mock 已移除，必须用真实 Key 在相同简历集上对比全 pro 与分档两种配置。

## 5. 未实现/不声称

| 项 | 状态 |
|---|---|
| 字段级 P/R/F1 | 未实现；需要人工标注 |
| NDCG / TopK 质量 | 未实现；需要带相关性标注的岗位-简历对 |
| 双标注一致性 kappa | 未实现 |
| 真实模型 A/B（flash vs pro 质量） | 未实现；需真实 Key 与重复实验 |
| 300 份真实压测 | 未实现；容量池/批流动只做了机制测试 |
| 浏览器级 e2e | 未实现；UI 目前做 HTTP 冒烟与静态检查 |
| HTML 报告 | 已移除，不再作为评测对象 |

## 6. 验收清单（提交前）

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test:all` 71/71 通过
- [ ] `pnpm web` 可打开，无 mock/demo 入口
- [ ] 上传 TXT/DOCX/PDF/图片均可进入 `resume.fetched`
- [ ] 运行中 SSE 有 `token` 事件
- [ ] 对话内出现 Top 推荐与合规摘要；不提供 Markdown/JSON 下载，报告目录无 `report.html`
- [ ] 图片简历默认走 DeepSeek Vision（`resume.ocr` 事件），失败时可回退本地
- [ ] 未配置 Key 时请求返回明确错误，不产生模拟报告
