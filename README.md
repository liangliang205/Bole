# 伯乐 BoLe

[![CI](https://github.com/liangliang205/Bole/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/liangliang205/Bole/actions/workflows/ci.yml)

**可验证的多 Agent 招聘筛选平台（MVP）**。HR 在对话式控制台上传真实简历、描述岗位需求；伯乐编排 **6 个 preset（5 个 LLM 角色 + 1 个确定性接入器）**完成 JD 结构化、并发解析、匹配评估、证据核查与合规检查。多 Agent 扇出只发生在**多简历筛选**（上下文与成本原因，单简历不做无谓派生）；筛选完成后的追问由主 Agent 直接回答或调用工具，并按任务复杂度在 **flash/pro** 间选档；面试建议按需加载 skill，不进入筛选流水线。所有结论都必须能回到简历原文的字符区间；平台只给建议，不做自动录用/淘汰决定。

> 当前版本只接真实模型 API，不包含 mock 模型、演示 JD、故障注入或预置黄金简历。没有可用的模型提供商时流水线会明确失败，而不是悄悄回退到模拟数据。

## 30 秒启动

```bash
pnpm install
pnpm ocr:download          # 本地 Tesseract 回退语言数据（模型 OCR 失败时使用）
pnpm web                   # http://127.0.0.1:8787
```

首次进入 Web 会自动检查模型提供商；没有可用 Key 时会打开设置并定位到 DeepSeek 密钥。默认带一个 DeepSeek 内置提供商，也可以添加任意 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 网关，并选择当前使用的提供商。自定义提供商支持「获取可用模型」、模型目录、手动添加模型，并分别选择 Flash/Pro 模型。Key 使用 AES-256-GCM 加密持久化在 `data/providers.json`（主密钥 `data/keyring.key`），刷新/重启无需重填；不通过环境变量读取，也不写入台账/报告。

### 页面里能做什么

- 设置：侧栏「⚙ 设置」打开，内含「模型 / 插件 / 工具与环境」三个页签。模型页管理提供商与 Key（DeepSeek 为内置提供商，不可删除；自定义模型 API 支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages，填写 Provider ID、显示名称、API 地址与密钥；支持获取可用模型、模型目录、手动添加和 Flash/Pro 选择）；插件页管理 MCP；工具与环境页提供 Agent 注册表查看与环境自检。清空台账只在 CLI 提供。
- 知识库：原生 SQLite 本地知识库（`data/knowledge.db`）；默认没有知识库，创建并启用后，画像完成后用 JD + 评分卡生成检索词，**只有评估阶段**会注入命中的相关片段（面试建议走对话 skill，不查知识库）。支持文档上传、Markdown 智能分块、Ollama/OpenAI 兼容 embedding、可选 rerank、Top K 和上下文预算。
- 主题：默认日间白底黑字；右上角「☾ 暗夜」切换为黑底白字，偏好保存在浏览器 localStorage。
- 新建对话：上传 PDF / DOCX / TXT / MD / HTML / PNG / JPG / WebP / BMP / TIFF 简历，输入招聘需求。
- 实时对话：里程碑消息 + 可折叠工具轨迹 + **token 级流式生成**（服务端用 `partial-json` 把未完成 JSON 转成字段/分数/理由，前端不展示原始 JSON）。
- 文件预览：对话内生成的 DOCX/PDF 可点击卡片，在右侧分栏用 PDF.js 预览；DOCX 先经 LibreOffice Kit 转 PDF，支持拖拽调宽和原文件下载。
- 对话附件：输入区左侧「＋」可上传图片、PDF、Word（DOCX）、Markdown/TXT/HTML；服务端抽取文本注入主 Agent，界面只显示附件名，不上传原文。
- HITL：JD 有歧义、预算/地点冲突、证据不足、核查打回时，在对话内选择推荐项或输入自定义回答。
- 证据审计：每位候选人的解析字段、评估维度、逐条核查 verdict、原文 span 与区间。
- 合规与成本：受保护属性剥离、去重/失败明细、HITL 决策记录、按 Agent/阶段的 token 与成本。
- 报告：完成后直接在对话里汇总 Top 候选人、推荐理由、合规与成本摘要；不提供 Markdown/JSON 下载；需要文件时可在完成后对话中按需导出 Word/PDF。
- 续跑：从批次检查点恢复未完成任务，不重新上传。
- 暂停：运行中点击右上角「⏸ 暂停」，在当前批次/阶段边界安全退出并保留已提交结果；状态变为「已暂停」后可「▶ 续跑」。
- 会话管理：右键会话或点「⋯」打开 DSH 风格菜单；支持置顶、重命名、归档/取消归档、复制会话 ID、删除（删除不可恢复）。「归档」按钮可切换查看归档会话。
- 完成后对话：筛选完成后可以继续追问伯乐；主 Agent 直接回答或调用导出/MCP 工具，**按问题复杂度自动选择 flash 或 pro**（寒暄/短问答走 flash，比较与复盘走 pro），复用同一岗位的稳定前缀与历史，不重新运行筛选项。

## 流水线

```text
HR 上传文件 + 招聘需求
   │
   ▼
画像师（pro）── 结构化 JD / 评分卡 / 受保护属性剥离 ── HITL
   │
   ▼
探马（确定性代码）── 上传 → 去重（sha256 + 身份指纹）→ 归一化（PDF.js / DOCX / OCR / HTML）
   │
   ▼
按批流动（batch=8，最多 2 批在途）
   ├─ 录事（flash）   解析字段 + 证据 span
   ├─ 相马官（flash） 初筛评分
   ├─ Top40% 短名单 → 相马官（pro）深评
   └─ 监军（pro）逐条核查证据；打回重评 ≤2 轮；仍不足转人工
   │
   ▼
报告（Markdown + JSON，内部落盘）+ 成本/收敛数据
   │
   ▼
伯乐按需工具（pro）── 仅在 HR 明确要求时调用 export_word / office_export_pdf ── 对话内下载链接
```

档位在 `config/agents.json` 与 `config/pipeline.json` 中配置：
- `flash` → `deepseek-flash`：解析、初筛等扇出型工作（显式关闭 thinking，优先吞吐）；
- `pro` → `deepseek-v4-pro`：画像、深评、核查、建议等判断/否决型工作（thinking enabled + reasoning_effort=high）；
- 自环重评复用原评估 Worker 与档位，`eval_tasks` 记录 `tier/phase=screen|deep|revise`。

## 外接 MCP（插件化）

外接 MCP 服务在伯乐里是**插件**：`设置 → 插件` 里安装、启停、编辑、删除，改完即时生效。插件暴露的工具会自动进入「完成后对话」主 Agent 的工具池（`mcp__<插件>__<工具>`），并受 `config/agents.json` 的 `mcp` 白名单约束。没装插件时一切照旧，只用内置工具。

**状态即文件**：插件库在 `data/mcp/plugins.json`（插件定义 + `enabled` 开关）；凭据（环境变量 / 请求头）用 AES-256-GCM 加密后内嵌在该文件里，主密钥是 `data/mcp/keyring.key`（0600）。API 只回键名（`envKeys`），永不回值。旧的 `config/mcp.json`（可用 `BOLE_MCP_CONFIG` 指定）在首次启动时自动导入为 `imported` 插件，之后以插件库为准。

单个插件坏掉（启动失败、凭据解不开）只标记它自己，其它插件与筛选主流程不受影响。插件由用户自己添加：stdio 填启动命令与参数，http 填端点与请求头；凭据加密保存。

### 安装与编辑

入口：「设置 → 插件」。

| 操作 | 入口 |
|---|---|
| 安装 | 「＋ 添加插件」填写 MCP 服务（stdio 命令 / HTTP 端点） |
| 启停 | 插件行左侧开关；停用立即断开该服务，不影响其它插件 |
| 测试 | 行内「测试」/ 编辑器「测试连接」：临时连一次、列工具、立刻关闭 |
| 编辑 | 行内「编辑」；保存后自动重建连接 |
| 删除 | 行内「删除」，凭据一并删除 |

编辑器里的凭据写成每行 `KEY=VALUE`：已有值显示为 `***`，保持 `***` 或留空 = 不修改，写新值 = 覆盖（提交的是整份映射，没列出的键会被删掉）。stdio 插件用「环境变量」，http 插件用「请求头」。

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 由名称生成 | `[a-z0-9_-]{1,32}`，安装后不可改 |
| `transport` | 有 `command` 则 `stdio`，否则 `http` | `command` 与 `url` 只能二选一 |
| `command` / `args` / `cwd` / `quiet` | — | stdio 的启动方式；`quiet` 静默子进程 stderr |
| `url` / `headers` | — | Streamable HTTP 端点与请求头（加密保存） |
| `allowTools` / `denyTools` | `["*"]` / `[]` | `*`、`server`、`server:tool`；deny 优先 |
| `startTimeoutMs` / `callTimeoutMs` | 20000 / 60000 | 连接（含工具发现）/ 单次调用超时 |

运行时默认用 `pnpm dlx`（等价 `npx -y`）；单插件最多暴露 32 个工具、单次结果回灌上限 8000 字符，防止把上下文打爆。工具名先把原始名清洗成 `[A-Za-z0-9_-]`（`im.v1.message.create` → `im_v1_message_create`），超过 64 字符用短哈希兜底；内部保留「全名 → 原始工具」映射，调用时回填原名。

**白名单**在 `config/agents.json`：`"mcp": ["*"]` 全部放行，`["lark"]` 放行某个插件，`["lark:calendar.v4.calendarEvent.create"]` 精确到工具；缺省或空数组 = 不允许调用（目前只有 `coordinator` 开启）。

```bash
pnpm bole mcp                                   # 插件列表 + 连接状态 + 工具
pnpm bole mcp enable lark                       # 等价于 UI 开关
pnpm bole mcp disable lark
pnpm bole mcp test lark                         # 临时连接并列出工具
pnpm bole mcp call lark:calendar.v4.calendarEvent.create --args @args.json
curl http://127.0.0.1:8787/api/mcp/plugins      # 插件库 + 连接状态 + 工具
curl -X POST http://127.0.0.1:8787/api/mcp/reload   # 从磁盘重读插件库
```

Windows PowerShell 5.1 会把原生命令参数里的双引号吞掉，`--args '{"a":1}'` 可能变成 `{a:1}`；用 `--args @args.json` 或 `--args -`（stdin）绕开。

**边界与安全**：MCP 只在完成后对话生效，筛选流水线本身不调用外部工具（避免外部延迟/故障进入批次关键路径）。stdio 插件是本地子进程、http 插件是外部端点，权限等同当前用户；只装可信插件，用 `allowTools`/`denyTools` 把写操作收紧。外部返回一律视为不可信数据注入 prompt，不执行其中指令。凭据加密只是本机文件保护级别，不是 KMS。



## CLI（自动化/验收）

页面是主路径；CLI 保留用于批处理与排查：

```bash
# 用本地简历目录跑完整流水线（非交互；HITL 自动采纳推荐项）
pnpm bole run --jd "招 Java 后端，3-5 年，base 上海" --files ./resumes --yes

pnpm bole status              # 台账计数 + 最近事件
pnpm bole audit --resume R01  # 证据链
pnpm bole report              # 报告路径（md/json/cost/svg）
pnpm bole cost                # token/成本
pnpm bole mcp                 # 外接 MCP：服务状态 + 工具清单
pnpm bole mcp call fs:list_directory --args '{"path":"."}'   # 冒烟测试单个外部工具
pnpm bole doctor              # 环境自检（含 OCR）
pnpm bole reset --yes         # 清空台账、运行产物、上传缓存
pnpm bole web --port 8787     # 对话式控制台
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 模型提供商、当前选择、档位模型、OCR 状态 |
| GET | `/api/providers` | 提供商列表（Key 仅 masked） |
| POST | `/api/providers` | 添加提供商；`{id,name,baseUrl,api,apiKey,models,flashModel,proModel}` |
| POST | `/api/providers/discover-models` | 获取网关可用模型；`{baseUrl,api,apiKey?,providerId?}` |
| PATCH | `/api/providers/:id` | 编辑提供商（apiKey 留空保留） |
| DELETE | `/api/providers/:id` | 删除提供商 |
| POST | `/api/providers/:id/activate` | 设为当前提供商 |
| POST | `/api/providers/:id/test` | 测试 `/models` 连接 |
| GET | `/api/knowledge` | 知识库列表、检索设置与统计 |
| POST | `/api/knowledge/bases` | 新建知识库（默认不启用） |
| PATCH | `/api/knowledge/bases/:id` | 名称/描述/启用开关 |
| DELETE | `/api/knowledge/bases/:id` | 删除知识库及文档 |
| GET/POST | `/api/knowledge/bases/:id/documents` | 文档列表 / 上传并索引 |
| DELETE | `/api/knowledge/documents/:id` | 删除文档 |
| PATCH | `/api/knowledge/settings` | embedding/rerank/分块/召回设置 |
| POST | `/api/knowledge/search` | 知识库检索 |
| POST | `/api/knowledge/test-embedding` | 测试嵌入连接 |
| GET | `/api/jobs` | 会话列表与计数 |
| PATCH | `/api/jobs/:id` | `{title?,pinned?,archived?}` 重命名/置顶/归档 |
| DELETE | `/api/jobs/:id` | 删除会话及其台账/运行产物 |
| POST | `/api/uploads` | `{filename, contentBase64}` → `uploadId` |
| POST | `/api/run` | `{requirements, uploadIds[]}` 使用当前提供商创建并启动 |
| GET | `/api/run/:jobId` | run 状态 + 快照 |
| GET | `/api/run/:jobId/stream` | SSE：`status` / `snapshot` / `log` / `token` / `done` |
| GET | `/api/run/:jobId/events` | 增量事件 |
| POST | `/api/run/:jobId/hitl` | `{answer, actor}` |
| GET | `/api/run/:jobId/candidates` | 候选人列表 |
| GET | `/api/run/:jobId/candidates/:id` | 证据详情 |
| GET | `/api/run/:jobId/cost` | 成本与缓存 |
| GET | `/api/run/:jobId/report` | 报告 JSON（仅对话内汇总/后续 MCP 使用，不提供下载） |
| GET | `/api/run/:jobId/files/:name` | 下载对话内生成的 DOCX/PDF |
| GET | `/api/run/:jobId/files/:name/preview` | DOCX（转为 PDF 后）或 PDF 的内联预览；前端用 PDF.js 在右侧分栏渲染 |
| POST | `/api/run/:jobId/pause` | 请求在批次/阶段边界暂停 |
| GET/POST | `/api/run/:jobId/chat` | 读取 / 追加筛选完成后的主 Agent 对话 |
| POST | `/api/run/:jobId/resume` | 从检查点续跑 |
| POST | `/api/agents` / `/api/doctor` | 注册表 / 自检 |
| GET | `/api/mcp` | 外接 MCP 概览（连接状态 + 工具数，兼容旧调用） |
| GET | `/api/mcp/plugins` | 插件库 + 连接状态 + 工具 |
| POST | `/api/mcp/plugins` | 安装插件；`{id,name,transport,command,args,env,url,headers,allowTools,...}` |
| PATCH | `/api/mcp/plugins/:id` | 编辑插件（凭据传 `***` 表示保留原值） |
| DELETE | `/api/mcp/plugins/:id` | 删除插件及其凭据 |
| POST | `/api/mcp/plugins/:id/enabled` | 启停插件；`{enabled:true|false}`，即时重连 |
| POST | `/api/mcp/plugins/:id/test` | 临时连接该插件并列出工具 |
| POST | `/api/mcp/reload` | 从磁盘重读插件库并重建连接 |
| POST | `/api/reset` | `{confirm:"RESET"}`；UI 已移除清空入口，仅供脚本/自动化使用 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOLE_FLASH_MODEL` | `deepseek-flash` | 覆盖当前提供商的 Flash 模型 |
| `BOLE_PRO_MODEL` | `deepseek-v4-pro` | 覆盖当前提供商的 Pro 模型 |
| `BOLE_DATA_DIR` | `data` | 台账/上传/索引根目录 |
| `BOLE_DB` | `data/ledger.db` | SQLite 台账 |
| `BOLE_KNOWLEDGE_DB` | `data/knowledge.db` | 知识库 SQLite |
| `BOLE_UPLOADS` | `data/uploads` | 上传缓存 |
| `BOLE_RUNS` | `runs` | 运行产物 |
| `BOLE_OCR_MODE` | `deepseek` | `deepseek`（Vision）/ `local`（Tesseract）/ `url`（外部服务） |
| `BOLE_OCR_MODEL` | `deepseek-flash` | Vision OCR 模型（仅 Flash 支持图片） |
| `BOLE_OCR_FALLBACK` | `true` | Vision 失败/格式不支持时回退本地 Tesseract |
| `BOLE_OCR_DIR` | `data/ocr` | Tesseract `.traineddata.gz` 目录 |
| `BOLE_OCR_URL` | 空 | 外部 OCR HTTP 服务（`url` 模式或本地回退时） |
| `BOLE_OCR_KEY` | 空 | 外部 OCR Bearer token |
| `BOLE_OCR_LANG` | `chi_sim+eng` | Tesseract 语言 |
| `BOLE_MCP_CONFIG` | `config/mcp.json` | 旧式 MCP 配置文件（仅在首次导入插件库时读取；插件库优先） |
| `BOLE_BATCH_SIZE` | 8 | 批大小 |
| `BOLE_MAX_BATCHES_IN_FLIGHT` | 2 | 在途批上限 |
| `BOLE_DEEP_EVAL_PERCENT` | 40 | 深评短名单比例 |

## 目录

```text
bole/
├─ src/
│  ├─ agents/            # coordinator + profiler/fetcher/parser/assessor/auditor
│  ├─ chat/              # 完成后对话、按需面试建议 skill
│  ├─ core/              # 台账、状态机、容量池、批流动、结构化两阶段提交
│  ├─ ingest/            # 上传、PDF.js/DOCX/HTML 归一化、DeepSeek Vision/Tesseract OCR、去重、PII
│  ├─ llm/               # DeepSeek 提供方（含 streaming）、路由、成本
│  ├─ report/            # Markdown / JSON / cost / convergence 渲染
│  ├─ export/            # Word 报告生成（docx 库）
│  ├─ tools/             # Tools Call 注册表（OpenAI Function Calling）+ 导出/Python 工具
│  ├─ settings/          # 模型提供商、Key 加密持久化（服务端）
│  ├─ knowledge/         # 原生知识库：SQLite、分块、embedding、rerank、检索
│  ├─ mcp/               # 外接 MCP 客户端：配置校验、连接、工具适配、白名单路由
│  ├─ web/               # HTTP API + 对话式前端（无构建步骤）
│  └─ cli/               # web / run / audit / report / doctor / reset
├─ config/               # agents.json、pipeline.json、prompts/
├─ data/                 # ledger.db、uploads/、ocr/、knowledge/
├─ runs/                 # 每次运行的原始文件、归一化文本、报告、事件
├─ scripts/download-ocr.ts
└─ tests/                # 单元 + 集成（测试替身只在 tests/）
```

## 测试与静态检查

```bash
pnpm typecheck   # tsc --noEmit（strict）
pnpm lint        # ESLint 9 flat config + typescript-eslint（零 warning）
pnpm test:all    # 114 个测试
pnpm check       # 以上三项串行跑一遍
```

ESLint 规则见 [`eslint.config.js`](eslint.config.js)：除基础正确性规则外，启用了三条类型感知规则（`no-floating-promises`、`no-misused-promises`、`await-thenable`），并把「零 `any`、零 `ts-ignore`」写成可执行约束；不做格式化，避免代码风格改动掩盖真实变更。

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：每次 push / PR 到 `master`、`dev` 都在 Node 24 上跑 `typecheck → lint → test:all`，测试不需要任何 API Key（用 `tests/fixtures/fake-provider.ts` 作为测试替身，LibreOffice 缺失时 PDF 测试自动 skip）。

当前 **114 个测试通过**：容量池拒绝而非排队、状态机单调守卫、span 定位、评分重算、上传/去重、DOCX/HTML/PDF 归一化、DeepSeek SSE 流解析与档位映射、OpenAI Chat/Responses 与 Anthropic Messages 协议、暂停/续跑、Qwen thinking 关闭与 max-tokens 扩容重试、Vision OCR 与本地回退、多提供商 Key 加密与迁移、知识库分块/检索/启用开关/自动召回、完成后主 Agent 多轮对话与稳定前缀、**对话档位选择（flash/pro）、注册表工具声明一致性**、对话附件文本注入与客户端脱敏、按需面试建议 skill、按需工具调用与 Word/PDF 导出、模型目录/获取模型（含阿里云 MaaS）、峰谷成本、流式 JSON 人类可读预览、schema 同轮重试、真实上传端到端、`.doc` 失败不阻塞、检查点续跑、报告不含 HTML、外接 MCP（工具名清洗/白名单/stdio 连接/失败降级/结果截断/路由桥接）、MCP 插件库（凭据加密与 `***` 保留语义、主密钥丢失降级、旧配置导入、损坏不炸、启停与删除即时生效）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 设计原则、组件、流水线、状态与失败处理 |
| [docs/MODULES.md](docs/MODULES.md) | 逐模块实现说明（编排/接入/解析/评估/核查/报告/Web/知识库/MCP） |
| [docs/AGENT_PRESETS.md](docs/AGENT_PRESETS.md) | 6 个 preset、schema、提示词纪律、档位与能力标签 |
| [docs/EVALUATION.md](docs/EVALUATION.md) | 可复跑的验证项与验收清单 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 当前真实限制与已知失败模式 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 本机/Docker 部署、OCR、环境变量、排障 |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | 8–10 分钟演示流程 |

> 需求规格与 MVP 方案在工作区根目录（`伯乐BoLe-需求文档.md`、`BoLe_MVP开发方案.md`、`BoLe_记忆管理设计.md`），已同步为 v1.1/实现对齐版；本仓库 `docs/` 是实现的权威说明。

## 已知边界

- 图片 OCR 默认使用 **DeepSeek V4 Flash Vision**（JPEG/PNG/GIF/WebP，逐字转写，token 计入成本；图片会以 base64 发送给 DeepSeek API）；失败或 BMP/TIFF 自动回退本地 Tesseract。手写体/低分辨率仍可能识别错误，可通过 `BOLE_OCR_MODE=local` 完全避免外发。
- PDF 仅提取文本层；扫描版 PDF 需要先转图片（平台会明确提示）。
- 仅支持单附件简历，不做 IMAP/Exchange 邮箱接入。
- 报告在对话内汇总，不提供 Markdown/JSON 下载；内部仍保留 `report.json` 供 UI 与后续 MCP 使用，不生成 HTML 报告。
- 外接 MCP 只在「完成后对话」生效；筛选流水线不调用外部工具，避免第三方延迟/故障进入批次关键路径。MCP 服务的权限等同当前用户，接入前需自行评估。
- 单机单用户、loopback 默认监听；没有多租户与登录鉴权，公网部署前必须加反向代理与鉴权。各提供商 Key 由服务端加密持久化在 `data/providers.json`，请保护数据目录权限。
- 真实模型质量取决于 DeepSeek；温度=0 仍可能有 ±1 分波动。详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。
