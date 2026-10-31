# 伯乐 BoLe

**可验证的多 Agent 招聘筛选平台（MVP）**。HR 在对话式控制台上传真实简历、描述岗位需求；伯乐编排 7 个 Agent 完成 JD 结构化、并发解析、匹配评估、证据核查、合规检查与面试建议。所有结论都必须能回到简历原文的字符区间；平台只给建议，不做自动录用/淘汰决定。

> 当前版本只接真实 DeepSeek API，不包含 mock 模型、演示 JD、故障注入或预置黄金简历。没有 API Key 时流水线会明确失败，而不是悄悄回退到模拟数据。

## 30 秒启动

```bash
pnpm install
pnpm ocr:download          # 下载 Tesseract 中英文语言数据（图片简历需要）
pnpm web                   # http://127.0.0.1:8787
```

首次进入 Web 会自动检查绑定状态；未绑定会弹出窗口要求输入 DeepSeek API Key。绑定后服务端加密持久化到 `data/keyring.json`（主密钥 `data/keyring.key`），刷新或重启都不需要再次输入；可在「设置与模型」中清除绑定。Key 不通过环境变量读取，也不写入台账/报告。

### 页面里能做什么

- 新建对话：上传 PDF / DOCX / TXT / MD / HTML / PNG / JPG / WebP / BMP / TIFF 简历，输入招聘需求。
- 实时对话：里程碑消息 + 可折叠工具轨迹 + **token 级流式生成**（服务端用 `partial-json` 把未完成 JSON 转成字段/分数/理由，前端不展示原始 JSON）。
- HITL：JD 有歧义、预算/地点冲突、证据不足、核查打回时，在对话内选择推荐项或输入自定义回答。
- 证据审计：每位候选人的解析字段、评估维度、逐条核查 verdict、原文 span 与区间。
- 合规与成本：受保护属性剥离、去重/失败明细、HITL 决策记录、按 Agent/阶段的 token 与成本。
- 报告：完成后直接在对话里汇总 Top 候选人、合规与成本摘要；不提供 Markdown/JSON 下载，后续可通过 MCP 由 Agent 输出。
- 续跑：从批次检查点恢复未完成任务，不重新上传。

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
```

档位在 `config/agents.json` 与 `config/pipeline.json` 中配置：
- `flash` → `deepseek-chat`：解析、初筛等扇出型工作；
- `pro` → `deepseek-reasoner`：画像、深评、核查、建议等判断/否决型工作；
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
| GET | `/api/config` | 模型档位、OCR 状态、Key 绑定状态（masked） |
| POST | `/api/key` | `{apiKey}` 绑定并持久化；返回绑定状态 |
| DELETE | `/api/key` | 清除 Key 绑定 |
| GET | `/api/jobs` | 会话列表与计数 |
| POST | `/api/uploads` | `{filename, contentBase64}` → `uploadId` |
| POST | `/api/run` | `{requirements, uploadIds[], deepseekApiKey?}` 创建并启动 |
| GET | `/api/run/:jobId` | run 状态 + 快照 |
| GET | `/api/run/:jobId/stream` | SSE：`status` / `snapshot` / `log` / `token` / `done` |
| GET | `/api/run/:jobId/events` | 增量事件 |
| POST | `/api/run/:jobId/hitl` | `{answer, actor}` |
| GET | `/api/run/:jobId/candidates` | 候选人列表 |
| GET | `/api/run/:jobId/candidates/:id` | 证据详情 |
| GET | `/api/run/:jobId/cost` | 成本与缓存 |
| GET | `/api/run/:jobId/report` | 报告 JSON（仅对话内汇总/后续 MCP 使用，不提供下载） |
| POST | `/api/run/:jobId/resume` | 从检查点续跑 |
| GET | `/api/agents` / `/api/doctor` | 注册表 / 自检 |
| POST | `/api/reset` | `{confirm:"RESET"}` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOLE_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容网关 |
| `BOLE_FLASH_MODEL` | `deepseek-chat` | flash 模型名 |
| `BOLE_PRO_MODEL` | `deepseek-reasoner` | pro 模型名 |
| `BOLE_DATA_DIR` | `data` | 台账/上传/索引根目录 |
| `BOLE_DB` | `data/ledger.db` | SQLite 台账 |
| `BOLE_UPLOADS` | `data/uploads` | 上传缓存 |
| `BOLE_RUNS` | `runs` | 运行产物 |
| `BOLE_OCR_DIR` | `data/ocr` | Tesseract `.traineddata.gz` 目录 |
| `BOLE_OCR_URL` | 空 | 外部 OCR HTTP 服务（优先于本地 OCR） |
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
│  ├─ ingest/            # 上传、PDF.js/DOCX/HTML 归一化、Tesseract OCR、去重、PII
│  ├─ llm/               # DeepSeek 提供方（含 streaming）、路由、成本
│  ├─ report/            # Markdown / JSON / cost / convergence 渲染
│  ├─ settings/          # DeepSeek Key 加密持久化（服务端）
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

当前 **56 个测试通过**：容量池拒绝而非排队、状态机单调守卫、span 定位、评分重算、上传/去重、DOCX/HTML/PDF 归一化、DeepSeek SSE 流解析、流式 JSON 人类可读预览、Key 加密持久化、schema 同轮重试、真实上传端到端、`.doc` 失败不阻塞、检查点续跑、报告不含 HTML。

## 已知边界

- 图片 OCR 使用本地 Tesseract `chi_sim+eng`，手写体/低分辨率扫描件准确率有限；可设置 `BOLE_OCR_URL` 接更强的 OCR 服务。
- PDF 仅提取文本层；扫描版 PDF 需要先转图片（平台会明确提示）。
- 仅支持单附件简历，不做 IMAP/Exchange 邮箱接入。
- 报告在对话内汇总，不提供 Markdown/JSON 下载；内部仍保留 `report.json` 供 UI 与后续 MCP 使用，不生成 HTML 报告。
- 单机单用户、loopback 默认监听；没有多租户与登录鉴权，公网部署前必须加反向代理与鉴权。DeepSeek Key 由服务端加密持久化在 `data/keyring.*`，请保护数据目录权限。
- 真实模型质量取决于 DeepSeek；温度=0 仍可能有 ±1 分波动。详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。
