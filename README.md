# 伯乐 BoLe —— 可验证的多 Agent 招聘筛选编排平台（MVP）

> **每一句推荐都有原文出处，每一个偏差都有量化指标。**
> 用 7 个职责单一的 Agent + 一条"并发扇出、按批流动"的流水线，把一批简历筛成 **Top5 + 证据链 + 面试建议 + 合规报告**；关键节点由 HR 把关，全部决策可回溯到简历原文的字符区间。

- 语言/运行时：TypeScript + Node.js 22+（本仓库在 Node 24 验证）
- 运行依赖：`zod`（唯一运行时依赖）+ Node 内置 `node:sqlite`
- 默认离线 **mock** 模型：无 API Key 也能完整跑通、结果确定、可回归
- 真实模型：DeepSeek（`deepseek-chat` / `deepseek-reasoner`），同一套 schema、prompt 与流水线

---

## 1. 30 秒跑起来

```bash
cd bole
pnpm install
pnpm seed            # 生成 20 份黄金简历（data/inbox/*.eml）
pnpm web             # 打开 http://127.0.0.1:8787，所有操作都在页面完成
```

页面里可以：新建筛选任务、回答 HITL、实时看事件流、查看候选人证据链、合规与成本、续跑、打开报告，以及运行 seed / bench / doctor / agents / 清空台账。

也可以纯 CLI 演示（HITL 自动采纳推荐项，全程可复现）：

```bash
pnpm demo:auto
```

命令结束后会打印运行汇总，并在 `runs/<runId>/` 下生成：

| 文件 | 用途 |
|---|---|
| `report.md` | 人看的终稿：Top5 + 证据链 + 面试建议 + 合规报告 |
| `report.html` | 运行结束后的可视化报告页（多视图：总览/候选人/合规/成本/HITL） |
| `report.json` | 机器可读的完整报告（含字符偏移、成本、池统计） |
| `cost-report.md` | token / 成本 / 缓存前缀对齐对比 / 调度统计 |
| `convergence.svg` | 验真环逐轮通过率收敛曲线 |
| `artifacts/` | 每个子 Agent 的结构化产物（落盘后主流程只消费引用） |

## 2. 它到底做了什么

```
HR 需求（含歧义与歧视性条件）
   │
   ├─ profiler（画像师, pro）─ 结构化 JD + 5 维评分卡 + 疑点反问 ──▶ HITL-1（3 个确认）
   │
   ├─ fetcher（探马, flash）─ MCP 拉取 20 封 .eml → 去重 → 格式归一（docx/txt/md/html）
   │
   ├─ 批流水线（batch=8，最多 2 批同时流动，无全量屏障）
   │    ├─ parser×N（录事, flash, 池=4）→ 字段 + 原文 span（字符偏移由平台计算）
   │    ├─ assessor×M 初筛（相马官, flash, 池=2）→ 全量分维度评分 + 证据引用
   │    ├─ assessor 深评（相马官, pro）→ 批内 Top40% + 异常样本再评一次
   │    └─ auditor（监军, pro, 池=1）→ 逐条举证 + 公平性哨兵
   │          ├─ pass → 进入汇总
   │          ├─ re_eval → Self-Loop（≤2，续用同一个 assessor Worker，沿用被核查档位）
   │          └─ escalate_human → HR 人工队列
   │
   └─ 汇总：Top5 + 证据链 + 面试建议 + 合规报告 ──▶ HITL-2（终稿确认）
```

一次冻结的黄金运行（seed=`demo-2026`）：

| 指标 | 结果 |
|---|---|
| 处理简历 | 20 份（16 人核查通过，2 人转人工，1 份重复去重，1 份格式失败） |
| Top5 | R01 89.0 · R05 87.0 · R11 80.0 · R03 79.5 · R15 79.5 |
| 验真环 | 21 次裁决：16 pass / 3 re_eval / 2 escalate；重评 3 次，全部续用原 Worker |
| 证据链 | 每条维度结论均挂原文引用 + 字符区间，核查后 `verified=1` |
| 模型成本 | 78 次调用，输入 165,287 tokens（缓存命中 40,354），输出 34,068，$0.1136；无缓存基线 $0.1263 |
| 分档 | 扇出初筛全量 flash；12 人进入 pro 深评；监军 21 次全 pro；Top5 全部来自 pro 深评 |
| 调度 | parse 池峰值 4/4、assess 2/2、review 1/1；满载拒绝后由编排层有界重试，不排队 |

陷阱样本是**预置故障注入**（演示用，可用 `--no-faults` 关闭）：
- `R17` 模拟模型把"参与"拔高成"主导"→ 首轮被监军驳回 → 续用原 Worker 修正后通过；
- `R16` 证据稀疏 → 两轮重评仍无法举证 → 转人工；
- `R18` 与 R05 附件哈希/正文指纹一致 → 去重；
- `R19` 旧版 `.doc` 无法解析 → 单份失败、批次继续；
- `R20` 评估理由出现"年龄偏大" → 公平性哨兵拦截并转人工；
- JD 中的"限男性、30 岁以下"被剥离并生成 HITL 确认，不进入评分维度。

### 档位分工：扇出用 flash，判断与否决用 pro

| 环节 | 档位 | 理由 |
|---|---|---|
| parser（×N 扇出） | flash | 高并发、低难度、schema 固定，错误由 span 门禁与下游兜底 |
| assessor 初筛（×M 扇出） | flash | 全量打分，成本随简历数线性增长；先筛出短名单 |
| assessor 深评（短名单） | pro | 批内 Top40% + 解析异常/不确定项；判断"证据是否支持结论"需要更强模型 |
| auditor（否决） | pro | 独立验证者，永远不跟着扇出降档；否则验真环会形式化 |
| profiler / advisor | pro | 低调用量、高影响：JD 歧义、评分卡设计、面试建议 |
| coordinator | pro（当前为确定性编排） | 只有需要 LLM 做仲裁/叙述时才真正消耗 pro |

配置在 `config/pipeline.json#deepEval`（`enabled/percent/tier`）与 `config/agents.json`；自环返工沿用被核查那次的档位，避免"初筛 flash、返工突然 pro"造成的口径漂移。

## 3. 为什么是"平台"而不是"单 Agent 调用"

| 平台能力 | 本仓库的实现 | 可验证证据 |
|---|---|---|
| 定义 | `config/agents.json` preset 注册表（persona/工具/模型档/schema/深度预算/版本） | `bole agents`、注册表指纹写入台账 |
| 编排 | 自研 `parallel` + `pipeline` 原语；批内并发、批间流动 | 事件流中第 2 批 `batch.started` 早于第 1 批 `batch.completed`（测试断言） |
| 调度 | 容量池 + 满载**拒绝不排队** + 有界准入重试；深度预算 `maxDepth` 运行时断言 | 池统计（peak/refused）写入报告；`depth.ts` 单测 |
| 执行 | 任务台账（SQLite）+ append-only 事件 + 状态机；两阶段提交后单调锁定 | `events` 表禁 UPDATE/DELETE 触发器；提交后写入抛 `AlreadyCommittedError` |
| 验证 | 证据 span 定位 + 确定性评分重算 + 监军逐条 verdict + 公平性规则 | 每条结论可 `bole audit --resume R17` 两步回溯 |
| 反馈 | Self-Loop（≤2，续用同一 Worker）+ 转人工 + HITL 全记录 | `worker.reused`、`selfloop.revise`、`escalate.human` 事件 |

## 4. 常用命令

```bash
pnpm web                       # 启动可交互前端（发起 run / 回答 HITL / 实时事件）
pnpm bole demo                 # 演示（交互 HITL）
pnpm bole demo --yes --fresh   # 演示（自动 HITL + 清空旧台账）
pnpm bole run --jd "招 Java 后端，3-5 年，base 上海" --yes
pnpm bole status --events 40   # 台账 + 事件流（--json 输出机器可读）
pnpm bole audit --resume R17   # 证据链审计：字段 span → 评估 → 核查
pnpm bole resume --job <id>    # 批次级检查点续跑
pnpm bole report               # 最近一次报告路径
pnpm bole cost                 # token / 成本 / 缓存命中
pnpm bole bench                # 调度并发微基准（模拟模型时延）
pnpm bole agents               # preset 注册表
pnpm bole doctor               # 环境自检
pnpm bole seed                 # 重新生成黄金简历集
pnpm bole reset --yes          # 清空台账与运行产物
```

### Web 交互前端（推荐）

```bash
pnpm web
# 打开 http://127.0.0.1:8787
```

- 页面可直接发起 run、实时查看事件流、在页面里回答 HITL 问题，并打开完整报告。
- 左侧任务列表支持历史任务切换、搜索、查看通过/转人工/失败计数；当前运行状态实时刷新。
- 候选人页可查看每个人的解析字段与 span、评估历史（flash 初筛 / pro 深评 / 返工）、核查逐条 verdict 与证据表；点击行打开右侧审计面板（相当于 `bole audit`）。
- 合规页展示受保护条件剥离、重复投递、失败明细、核查否决率与 HITL 决策记录；成本页展示按 Agent/阶段/token/缓存/容量池的实测数据。
- 工具箱提供 Agent 注册表、环境自检、黄金集重建、调度微基准与清空台账；顶栏提供续跑、打开报告与刷新。
- DeepSeek 可二选一接入：①环境变量 `DEEPSEEK_API_KEY`；②在设置中填写（保存在浏览器 localStorage，仅随 run 请求发送，不写入服务端台账/日志）。
- 若未配置 Key，仍可选择 `mock` 并完整跑通（可复现演示链路）。
- 安全边界：默认只监听 `127.0.0.1`，无登录/多租户；不要直接暴露到公网。详见 [已知限制](docs/LIMITATIONS.md)。

## 5. 接入真实模型

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm bole demo --llm deepseek
```

- 温度 0；结构化输出使用 JSON mode + zod 校验；不符合 schema 时**同一轮内**把错误回喂模型重试（≤2 次）。
- 模型调用失败按指数退避重试（429/5xx），最终失败记录 `stop_reason=error`，不静默丢弃。
- 真实模型的证据引文由平台做字符串定位并计算字符偏移——模型**不允许编造 offset**。
- 若没有 Key，`--llm deepseek` 会明确报错并提示使用 mock。

## 6. 测试与可复现

```bash
pnpm test          # 单元 + 集成（含错误注入）
pnpm test:golden   # 黄金集回归（Top5 / 陷阱样本 / 自环统计）
pnpm test:all
pnpm typecheck
```

当前结果：**42 个测试全部通过**（38 单元 + 1 端到端 + 2 错误注入 + 1 黄金回归）。测试覆盖：

- 容量池拒绝不排队 / 重复释放 / 准入超时；
- 状态机非法迁移、失败优先于取消、committed 单调守卫；
- 引用定位（精确 / 空白 / 全半角标点 / 省略号拼接）、PII 脱敏；
- 评分卡确定性重算、排序 tie-break；
- schema 违规同轮重试后两阶段提交、持续违规标记失败；
- MIME/docx/html 归一化、旧版 doc 明确报错；
- 去重指纹、RAG 检索确定性、公平性规则；
- 端到端：批流动、Self-Loop、转人工、报告产物、检查点恢复；
- 黄金集：Top5、分数容差、状态计数、转人工/重复/失败明细、R17 驳回后通过。

## 7. 目录结构

```
bole/
├─ config/                 # 唯一配置源：agent preset / 流水线参数 / 7 份角色提示词
├─ data/
│  ├─ inbox/               # 20 份黄金简历（.eml，可 pnpm seed 重建）
│  ├─ golden/              # manifest + 冻结的回归基线 expectations.json
│  └─ knowledge/           # RAG 语料：JD 画像库 / 评分卡锚点 / 人才样本 / 面试题库
├─ src/
│  ├─ core/                # 台账、事件、状态机、容量池、批流动、两阶段提交、preset 注册表
│  ├─ llm/                 # 模型路由（mock / DeepSeek）、成本核算、缓存前缀
│  ├─ mcp/                 # hirebox-mock MCP server + 客户端（in-process / stdio）
│  ├─ ingest/              # EML / MIME、docx、html、pdf、去重、PII
│  ├─ tools/               # RAG、评分卡、公平性、span 校验
│  ├─ agents/              # 7 个 Agent 与编排器
│  ├─ report/              # 报告数据装配 + Markdown/HTML/JSON/SVG 渲染
│  └─ cli/                 # 命令行入口
├─ tests/                  # unit / integration / golden
├─ docs/                   # 架构、模块三段式、部署、评测、演示脚本、已知限制
└─ Dockerfile / docker-compose.yml
```

## 8. 文档索引

- [架构与机制](docs/ARCHITECTURE.md)：分层、数据流、12 项机制落地、框架取舍
- [模块设计（三段式）](docs/MODULES.md)：每个模块的"设计理念 / 模型与 Token 影响 / 已知限制"
- [部署手册](docs/DEPLOYMENT.md)：本机 / Docker / 真实模型 / 故障排查
- [评测与回归](docs/EVALUATION.md)：BoLe-Bench 指标、测试矩阵、调度与成本实验
- [8 分钟演示脚本](docs/DEMO_SCRIPT.md)：逐段话术与预期输出
- [Agent preset 说明](docs/AGENT_PRESETS.md)：角色、工具、schema、深度预算、版本管理
- [已知限制](docs/LIMITATIONS.md)：兑现"无夸大"，逐条列出 P0 边界与 P1 路线

## 9. 明确不做 / 已知边界（摘要）

- 只给建议，不生成 offer/拒信，不做不可逆决定；终稿必须 HR 确认。
- 邮箱为本地 mock MCP（`inbox/*.eml`）；真实 IMAP/Exchange 在 P1，客户端接口已按 MCP 抽象。
- 检查点恢复为**批次粒度**（P0），事务级恢复在 P1。
- PDF 仅做文本层尽力提取；扫描件与 CID 字体中文 PDF 可能失败，会如实进入失败明细。
- 反歧视合规为规则 + LLM 双检，**不构成法律意见**。
- 默认 mock 模型是确定性规则模拟（用于离线复现与机制验证），不代表真实 LLM 效果；真实效果需配置 API Key 后用黄金集重跑。
- 本仓库未直接依赖 Mastra：为保证离线可复现与机制层可控，编排/调度/验证/台账均自研，并在 `src/llm/provider.ts`、`src/core/structured.ts` 保留模型与结构化输出接缝。详见 [架构文档](docs/ARCHITECTURE.md#9-框架取舍为什么没有直接依赖-mastra)。

---

*本仓库为竞赛 MVP：所有数字来自可重跑的命令与落盘产物；"已知限制"与失败明细均如实呈现。*
