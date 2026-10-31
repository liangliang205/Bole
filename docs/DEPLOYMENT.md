# 部署与运行手册

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 22.6（本仓库在 24.11.1 验证；依赖 Node 内置 TypeScript 类型擦除与 `node:sqlite`） |
| pnpm | ≥ 10（`corepack enable` 可获得） |
| 操作系统 | Windows / macOS / Linux 均可；无原生编译依赖 |
| 磁盘 | 首次安装约 30 MB（含依赖）；运行产物每轮约 1–2 MB |
| 网络 | 离线可运行 mock 模式；真实模型模式需要访问 DeepSeek/OpenAI 兼容网关 |

> `node:sqlite` 在 Node 24 仍是 experimental，启动时会出现一条 `ExperimentalWarning`。不影响功能。

## 2. 本地安装

```bash
cd bole
pnpm install
pnpm seed        # 生成 data/inbox/*.eml 与 data/golden/manifest.json
pnpm doctor      # 环境自检：Node、配置、邮箱数量、台账可写、模型档位
```

## 3. 运行演示

```bash
# 非交互（推荐用于验收/CI）：HITL 自动采纳推荐项，actor 记录为 HR(auto-demo)
pnpm demo:auto

# 交互式：3 个 JD 疑点 + 1 次终稿确认，用键盘选编号
pnpm demo

# 从零开始，清空旧台账与 runs
pnpm bole demo --yes --fresh

# 只用干净台账（历史保留，但新建 job）
pnpm bole demo --yes
```

演示会实时打印事件流，最后输出 Top5、容量池统计、成本与报告路径。

## 3.1 Web 交互前端

```bash
pnpm web
# 打开 http://127.0.0.1:8787
pnpm bole web --host 127.0.0.1 --port 8787   # 等价
```

- 页面可发起 run、实时查看事件流、回答 HITL、查看多视图报告（总览/候选人/合规/成本/HITL）。
- 任务切换、候选人审计（解析 span / 评估档位 / 核查逐条 verdict / 证据表）、续跑、报告、工具箱（Agent 注册表、自检、seed、bench、清空台账）都在页面完成，不需要再开终端。
- 模型可选 mock 或 deepseek；DeepSeek Key 可用 `DEEPSEEK_API_KEY`，也可在页面输入（保存在浏览器 localStorage，仅随请求发送）。
- **安全边界**：单用户、无登录/权限、默认只监听 loopback；不要直接暴露公网。多租户/鉴权在 P1。

## 4. 自定义岗位

```bash
pnpm bole run --jd "招聘高级 Java 后端，5 年以上，熟悉 Spring Cloud 与 Kafka，base 深圳" --yes
```

可配置项在 `config/pipeline.json`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `batchSize` | 8 | 每批简历数（流水线最小流动单位） |
| `maxBatchesInFlight` | 2 | 同时在途的批数（无全量屏障） |
| `pools.parse / assess / review` | 4 / 2 / 1 | 各阶段容量池上限；满载拒绝不排队 |
| `admission.maxRefusalRetries` | 200 | 有界准入重试次数 |
| `selfLoop.maxLoops` | 2 | 验真环上限，超限转人工 |
| `deepEval.enabled / percent / tier` | true / 40 / pro | 短名单深评开关、比例与档位；关闭即"全量 flash 评估" |
| `structuredOutput.maxAttempts` | 2 | 同轮 schema 校验重试次数 |
| `topN` | 5 | 推荐人数 |
| `models.flash / pro` | deepseek-chat / deepseek-reasoner | 模型档位；只改配置不改代码 |
| `pricing` | DeepSeek 公开价（占位） | 成本核算单价，可按实际账单调整 |
| `bench` | 60 项 / 1,4,8 并发 | 调度微基准参数 |

Agent 角色、工具、schema、深度预算在 `config/agents.json`；提示词在 `config/prompts/*.md`。改动后 `bole agents` 会显示新的版本与指纹，指纹写入 `run.json`，便于审计"这次用的是哪版 prompt/配置"。

## 5. 真实模型模式

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm bole demo --llm deepseek
# 或
BOLE_LLM=deepseek pnpm bole run --jd "..." --yes
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 真实模式必填；缺失时启动即报错并提示用 mock |
| `BOLE_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容网关地址 |
| `BOLE_FLASH_MODEL` | `deepseek-chat` | 覆盖 flash 档模型 |
| `BOLE_PRO_MODEL` | `deepseek-reasoner` | 覆盖 pro 档模型 |
| `BOLE_LLM` | `mock` | 默认提供方 |
| `BOLE_MOCK_LATENCY_MS` | 0（demo 默认 8） | mock 模拟时延，用于观察批流动 |
| `BOLE_DEEP_EVAL_PERCENT` | 40 | 覆盖短名单深评比例 |
| `BOLE_DB` / `BOLE_RUNS` / `BOLE_INBOX` / `BOLE_DATA_DIR` | 见 `.env.example` | 数据与运行目录 |

真实模式的成本/缓存数据来自 API 返回的 `usage.prompt_tokens / completion_tokens / prompt_cache_hit_tokens`；mock 模式为确定性估算（CJK 0.7 token/字 + 拉丁按词），两者在报告中都会标注 provider。

## 6. Docker

```bash
docker build -t bole-mvp .
docker run --rm -it -v bole-runs:/app/runs bole-mvp
# 或
docker compose up --build
```

镜像内已执行 `pnpm seed`；容器启动即跑 `demo --yes`。若使用真实模型：

```bash
DEEPSEEK_API_KEY=sk-... BOLE_LLM=deepseek docker compose up --build
```

> 入口镜像不包含 Chroma/Qdrant：P0 的 RAG 是零依赖 TF-IDF 索引（见 `src/tools/rag.ts`），数据在 `data/knowledge/`。P1 换向量库时只需替换 `RagIndex` 的实现。

> 注意：在受限沙箱/容器内运行时，Docker CLI 可能无法访问 daemon 的命名管道（`docker build` 被拒绝）。`docker compose config` 可通过；实际构建请在普通开发机或 CI 上执行，并据此调整基础镜像与代理设置。

## 7. 数据与产物

```
data/ledger.db          # 任务台账（SQLite，可删）
data/inbox/*.eml        # mock 邮箱
data/knowledge/*.md     # RAG 语料
data/index/rag.json     # 检索索引缓存（可删，自动重建）
runs/<runId>/           # 每轮产物：report.*、cost-report.md、convergence.svg、artifacts/、resumes/
```

- `pnpm bole reset --yes` 清空台账与 `runs/`（不动 inbox 与知识库）。
- `pnpm seed` 可随时重建黄金集（固定内容、固定 Message-ID，幂等）。
- 台账为单文件 SQLite；复制 `data/ledger.db` 即可迁移到另一台机器（需同版本 schema）。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `node:sqlite` ExperimentalWarning | Node 24 的正常提示，可忽略；或用 `NODE_NO_WARNINGS=1` 抑制 |
| `ExperimentalWarning: Type Stripping` | 直接用 `tsx`/`ts-node` 也可以，但本仓库默认用 Node 原生类型擦除 |
| `CommandNotFoundException: npm/npx` | 本环境未把 npm 加入 PATH；用 `pnpm exec tsc`、`pnpm test` 等脚本 |
| `spawn EPERM`（MCP stdio / 测试子进程） | 运行在受限沙箱时，Node 子进程管道被禁止。默认 `--mcp in-process` 不受影响；测试脚本已加 `--test-isolation=none`。若需验证 stdio server，可在普通终端或容器内运行 |
| `SQLITE_BUSY` | 同一台账被多个进程同时写；关闭其他 `bole` 进程，或为不同运行设置 `BOLE_DB` |
| 终端中文乱码 | Windows 控制台编码问题，报告文件本身是 UTF-8；用编辑器或浏览器打开 `report.md/html` |
| 报告 Top5 为空 | 检查 `bole status`：可能所有简历都 `failed/quarantine`；报告会如实列出原因 |
| `--llm deepseek` 立即失败 | 未配置 `DEEPSEEK_API_KEY`；或网络不可达（错误信息含 HTTP 状态与响应片段） |
| `pnpm web` 端口被占用 | `EADDRINUSE`：换端口 `pnpm bole web --port 8788`，或关闭占用进程 |

## 9. 验收复现清单

```bash
pnpm install
pnpm seed
pnpm typecheck
pnpm test:all
pnpm bole demo --yes --fresh
pnpm bole status --events 40
pnpm bole audit --resume R17
pnpm bole report
pnpm bole cost
pnpm web          # 可选：浏览器验证 HITL 与多视图报告
```

预期：42 个测试通过；demo 终稿 Top5 为 R01/R05/R11/R03/R15；状态计数 reported=16、quarantine=2、duplicate=1、failed=1；`audit R17` 能看到"首轮 unsupported → 续用同一 Worker → 第二轮 pass"的完整记录；报告/`status` 中可见评估阶段 `screen/deep/revise` 与实际档位 `flash/pro`。
