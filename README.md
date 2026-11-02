# 伯乐 BoLe

**可验证的多 Agent 招聘筛选平台（MVP）**。HR 在对话式控制台上传真实简历、描述岗位需求；伯乐编排 7 个 Agent 完成 JD 结构化、并发解析、匹配评估、证据核查、合规检查与面试建议。所有结论都必须能回到简历原文的字符区间；平台只给建议，不做自动录用/淘汰决定。

> 当前版本只接真实模型 API，不包含 mock 模型、演示 JD、故障注入或预置黄金简历。没有可用的模型提供商时流水线会明确失败，而不是悄悄回退到模拟数据。

## 30 秒启动

```bash
pnpm install
pnpm ocr:download          # 本地 Tesseract 回退语言数据（模型 OCR 失败时使用）
pnpm web                   # http://127.0.0.1:8787
```

首次进入 Web 会自动检查模型提供商；没有可用 Key 时会打开设置并定位到 DeepSeek 密钥。默认带一个 DeepSeek 内置提供商，也可以添加任意 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 网关，并选择当前使用的提供商。自定义提供商支持「获取可用模型」、模型目录、手动添加模型，并分别选择 Flash/Pro 模型。Key 使用 AES-256-GCM 加密持久化在 `data/providers.json`（主密钥 `data/keyring.key`），刷新/重启无需重填；不通过环境变量读取，也不写入台账/报告。

### 页面里能做什么

- 设置：DSH 风格的「模型」页；DeepSeek 为内置提供商（不可删除），自定义模型 API 支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages，填写 Provider ID、显示名称、API 地址与密钥；支持获取可用模型、模型目录、手动添加和 Flash/Pro 选择。
- 知识库：原生 SQLite 本地知识库（`data/knowledge.db`）；默认没有知识库，创建并启用后，画像完成后用 JD + 评分卡生成检索词，评估与面试建议只注入命中的相关片段。支持文档上传、Markdown 智能分块、Ollama/OpenAI 兼容 embedding、可选 rerank、Top K 和上下文预算。
- 主题：默认日间白底黑字；右上角「☾ 暗夜」切换为黑底白字，偏好保存在浏览器 localStorage。
- 新建对话：上传 PDF / DOCX / TXT / MD / HTML / PNG / JPG / WebP / BMP / TIFF 简历，输入招聘需求。
- 实时对话：里程碑消息 + 可折叠工具轨迹 + **token 级流式生成**（服务端用 `partial-json` 把未完成 JSON 转成字段/分数/理由，前端不展示原始 JSON）。
- 文件预览：对话内生成的 DOCX/PDF 可点击卡片，在右侧分栏用 PDF.js 预览；DOCX 先经 LibreOffice Kit 转 PDF，支持拖拽调宽和原文件下载。
- HITL：JD 有歧义、预算/地点冲突、证据不足、核查打回时，在对话内选择推荐项或输入自定义回答。
- 证据审计：每位候选人的解析字段、评估维度、逐条核查 verdict、原文 span 与区间。
- 合规与成本：受保护属性剥离、去重/失败明细、HITL 决策记录、按 Agent/阶段的 token 与成本。
- 报告：完成后直接在对话里汇总 Top 候选人、推荐理由、合规与成本摘要；不提供 Markdown/JSON 下载，后续可通过 MCP 由 Agent 输出。
- 续跑：从批次检查点恢复未完成任务，不重新上传。
- 暂停：运行中点击右上角「⏸ 暂停」，在当前批次/阶段边界安全退出并保留已提交结果；状态变为「已暂停」后可「▶ 续跑」。
- 会话管理：右键会话或点「⋯」打开 DSH 风格菜单；支持置顶、重命名、归档/取消归档、复制会话 ID、删除（删除不可恢复）。「归档」按钮可切换查看归档会话。
- 完成后对话：筛选完成后可以继续追问伯乐；只调用主 Agent，复用同一岗位的稳定前缀与历史，不重新运行筛选项。

## 流水线

```text
HR 上传文件 + 招聘需求
   │
   ▼
画像师（pro）── 结构化 JD / 评分卡 / 受保护属性剥离 ── HITL
   │
   ▼
探马（flash）── 上传 → 去重（sha256 + 身份指纹）→ 归一化（PDF.js / DOCX / OCR / HTML）
   │
   ▼
按批流动（batch=8，最多 2 批在途）
   ├─ 录事（flash）   解析字段 + 证据 span
   ├─ 相马官（flash） 初筛评分
   ├─ Top40% 短名单 → 相马官（pro）深评
   └─ 监军（pro）逐条核查证据；打回重评 ≤2 轮；仍不足转人工
   │
   ▼
报告（Markdown + JSON）+ 成本/收敛数据 + 面试建议（pro）
   │
   ▼
伯乐按需工具（pro）── 仅在 HR 明确要求时调用 export_word / office_export_pdf ── 对话内下载链接
```

档位在 `config/agents.json` 与 `config/pipeline.json` 中配置：
- `flash` → `deepseek-flash`：解析、初筛等扇出型工作（显式关闭 thinking，优先吞吐）；
- `pro` → `deepseek-v4-pro`：画像、深评、核查、建议等判断/否决型工作（thinking enabled + reasoning_effort=high）；
- 自环重评复用原评估 Worker 与档位，`eval_tasks` 记录 `tier/phase=screen|deep|revise`。

## CLI（自动化/验收）

页面是主路径；CLI 保留用于批处理与排查：

```bash
# 用本地简历目录跑完整流水线（非交互；HITL 自动采纳推荐项）
pnpm bole run --jd "招 Java 后端，3-5 年，base 上海" --files ./resumes --yes

pnpm bole status              # 台账计数 + 最近事件
pnpm bole audit --resume R01  # 证据链
pnpm bole report              # 报告路径（md/json/cost/svg）
pnpm bole cost                # token/成本
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
| GET | `/api/agents` / `/api/doctor` | 注册表 / 自检 |
| POST | `/api/reset` | `{confirm:"RESET"}` |

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
| `BOLE_BATCH_SIZE` | 8 | 批大小 |
| `BOLE_MAX_BATCHES_IN_FLIGHT` | 2 | 在途批上限 |
| `BOLE_DEEP_EVAL_PERCENT` | 40 | 深评短名单比例 |

## 目录

```text
bole/
├─ src/
│  ├─ agents/            # coordinator + profiler/fetcher/parser/assessor/auditor/advisor
│  ├─ core/              # 台账、状态机、容量池、批流动、结构化两阶段提交
│  ├─ ingest/            # 上传、PDF.js/DOCX/HTML 归一化、DeepSeek Vision/Tesseract OCR、去重、PII
│  ├─ llm/               # DeepSeek 提供方（含 streaming）、路由、成本
│  ├─ report/            # Markdown / JSON / cost / convergence 渲染
│  ├─ export/            # Word 报告生成（docx 库）
│  ├─ tools/             # Tools Call 注册表（OpenAI Function Calling）+ 导出/Python 工具
│  ├─ settings/          # 模型提供商、Key 加密持久化（服务端）
│  ├─ knowledge/         # 原生知识库：SQLite、分块、embedding、rerank、检索
│  ├─ web/               # HTTP API + 对话式前端（无构建步骤）
│  └─ cli/               # web / run / audit / report / doctor / reset
├─ config/               # agents.json、pipeline.json、prompts/
├─ data/                 # ledger.db、uploads/、ocr/、knowledge/
├─ runs/                 # 每次运行的原始文件、归一化文本、报告、事件
├─ scripts/download-ocr.ts
└─ tests/                # 单元 + 集成（测试替身只在 tests/）
```

## 测试

```bash
pnpm typecheck
pnpm test:all
```

当前 **79 个测试通过**：容量池拒绝而非排队、状态机单调守卫、span 定位、评分重算、上传/去重、DOCX/HTML/PDF 归一化、DeepSeek SSE 流解析与档位映射、OpenAI Chat/Responses 与 Anthropic Messages 协议、暂停/续跑、Qwen thinking 关闭与 max-tokens 扩容重试、Vision OCR 与本地回退、多提供商 Key 加密与迁移、知识库分块/检索/启用开关/自动召回、完成后主 Agent 多轮对话与稳定前缀、按需工具调用与 Word/PDF 导出、模型目录/获取模型（含阿里云 MaaS）、峰谷成本、流式 JSON 人类可读预览、schema 同轮重试、真实上传端到端、`.doc` 失败不阻塞、检查点续跑、报告不含 HTML。

## 已知边界

- 图片 OCR 默认使用 **DeepSeek V4 Flash Vision**（JPEG/PNG/GIF/WebP，逐字转写，token 计入成本；图片会以 base64 发送给 DeepSeek API）；失败或 BMP/TIFF 自动回退本地 Tesseract。手写体/低分辨率仍可能识别错误，可通过 `BOLE_OCR_MODE=local` 完全避免外发。
- PDF 仅提取文本层；扫描版 PDF 需要先转图片（平台会明确提示）。
- 仅支持单附件简历，不做 IMAP/Exchange 邮箱接入。
- 报告在对话内汇总，不提供 Markdown/JSON 下载；内部仍保留 `report.json` 供 UI 与后续 MCP 使用，不生成 HTML 报告。
- 单机单用户、loopback 默认监听；没有多租户与登录鉴权，公网部署前必须加反向代理与鉴权。各提供商 Key 由服务端加密持久化在 `data/providers.json`，请保护数据目录权限。
- 真实模型质量取决于 DeepSeek；温度=0 仍可能有 ±1 分波动。详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。
