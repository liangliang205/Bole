# 部署与运行

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22.6**（推荐 24；项目直接运行 `.ts`，依赖 type stripping） |
| 包管理 | pnpm 10 |
| 网络 | 真实 DeepSeek API；默认图片 OCR 也走 DeepSeek Vision |
| 磁盘 | 运行产物 + 上传缓存；本地回退 OCR 语言数据约 31MB |
| 浏览器 | Chromium / Edge / Firefox 现代版本（EventSource、FileReader） |

## 2. 本机启动

```bash
pnpm install
pnpm ocr:download
pnpm web
# http://127.0.0.1:8787
```

首次进入页面会自动检查模型提供商；没有可用 Key 时打开设置并定位到 DeepSeek 密钥。DeepSeek 是内置提供商（不可删除）；自定义模型 API 支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages，填写 Provider ID、显示名称、API 地址与密钥；可「获取可用模型」、维护模型目录并选择 Flash/Pro 模型。Key 使用 AES-256-GCM 加密写入 `data/providers.json`（主密钥 `data/keyring.key`），刷新/重启无需重复输入。CLI 不会读取环境变量；需要时用 `--key` 临时覆盖当前提供商的 Key。

知识库默认没有数据，入口在左侧「知识库」。创建知识库并勾选「启用自动检索」后，画像完成后会用 JD + 评分卡生成检索词，评估与面试建议只注入命中的相关片段；未启用时不召回。知识库存放在 `data/knowledge.db`，可配置 Ollama/OpenAI 兼容 embedding 与可选 rerank。

### OCR 说明

- **默认 `BOLE_OCR_MODE=deepseek`**：图片以 `image_url` + base64 发给 `deepseek-flash`，逐字转写为文本；图片 token（每张最多约 1024）计入成本。
- Vision 支持 JPEG/PNG/GIF/WebP；BMP/TIFF 或 Vision 失败时，默认回退本地 Tesseract（`BOLE_OCR_FALLBACK=true`）。
- `BOLE_OCR_MODE=local` 强制 Tesseract；`url` 使用外部 `BOLE_OCR_URL`。
- 本地 Tesseract 需要 `data/ocr/eng.traineddata.gz` 与 `data/ocr/chi_sim.traineddata.gz`；`pnpm ocr:download` 会下载。
- 扫描版 PDF 仍不渲染页面 OCR：请导出为 PNG/JPG 上传。

## 3. 页面操作

1. 打开「设置与模型 → 模型」：DeepSeek 内置（不可删除，首次使用会定位到密钥）；添加自定义模型 API（三种协议），获取/维护模型目录并选择 Flash/Pro，选择当前使用项。
2. 新建会话 → 上传一份或多份简历（支持 PDF / DOCX / TXT / MD / HTML / PNG / JPG / WebP / GIF / BMP / TIFF，单文件 ≤25MB）。
3. 填写招聘需求 → 开始筛选。
4. 对话区实时展示里程碑、工具轨迹、token 流；遇到 HITL 在卡片里选推荐项或输入自定义回答。
5. 完成后在对话中查看 Top 推荐与合规摘要；点「查看证据链」或右侧「任务面板」查看候选人证据链、合规与成本。不提供 Markdown/JSON 下载。
6. 中断后可点「续跑」从批次检查点恢复；不会重复上传。
7. 筛选完成后底部输入框可继续追问伯乐；只调用主 Agent，多轮消息保存在任务内并复用稳定上下文前缀。

## 4. CLI

```bash
pnpm bole run --jd "招 Java 后端，3-5 年，base 上海" --files ./resumes --yes
pnpm bole status
pnpm bole audit --resume R01
pnpm bole report
pnpm bole cost
pnpm bole doctor
pnpm bole reset --yes
```

- `run` 的 `--files` 直接读取本地目录，不经过 HTTP 上传；这是自动化/验收路径。
- 不带 `--yes` 时在终端交互回答 HITL；非 TTY 自动采纳推荐项。
- `reset` 删除台账、`runs/`、`data/uploads/`，不删除知识库与 OCR 数据。

## 5. Docker

```bash
docker compose build
docker compose up
# 打开 http://127.0.0.1:8787，首次进入按提示绑定 Key
```

- Key 绑定持久化在 `bole-data` 卷的 `providers.json`（主密钥 `keyring.key`）；容器重启后仍然有效。不要通过环境变量注入 Key。
- 镜像构建时执行 `pnpm ocr:download`，OCR 数据位于 `/app/ocr`（`BOLE_OCR_DIR`），不会被 `/app/data` 数据卷覆盖。
- `bole-data` 卷保存台账与上传缓存；`bole-runs` 保存运行产物。
- 容器内监听 `0.0.0.0:8787`；生产环境请在前面加反向代理与鉴权，当前应用本身没有登录。

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOLE_FLASH_MODEL` / `BOLE_PRO_MODEL` | `deepseek-flash` / `deepseek-v4-pro` | 临时覆盖当前提供商模型 |
| `BOLE_DATA_DIR` | `data` | 数据根 |
| `BOLE_DB` | `data/ledger.db` | SQLite |
| `BOLE_UPLOADS` | `data/uploads` | 上传缓存 |
| `BOLE_RUNS` | `runs` | 运行产物 |
| `BOLE_OCR_MODE` | `deepseek` | `deepseek`（Vision）/ `local` / `url` |
| `BOLE_OCR_MODEL` | `deepseek-flash` | Vision OCR 模型 |
| `BOLE_OCR_FALLBACK` | `true` | Vision 失败/不支持格式时回退本地 |
| `BOLE_OCR_DIR` | `data/ocr` | 本地回退 OCR 语言数据 |
| `BOLE_OCR_URL` / `BOLE_OCR_KEY` | 空 | 外部 OCR |
| `BOLE_OCR_LANG` | `chi_sim+eng` | Tesseract 语言 |
| `BOLE_BATCH_SIZE` | 8 | 批大小 |
| `BOLE_MAX_BATCHES_IN_FLIGHT` | 2 | 在途批 |
| `BOLE_DEEP_EVAL_PERCENT` | 40 | 深评比例 |

## 7. 验收

```bash
pnpm typecheck
pnpm test:all          # 79 个测试
curl -s http://127.0.0.1:8787/api/doctor
```

手工冒烟：
1. 上传一份 TXT + 一份 DOCX + 一张图片简历，确认均进入批次；
2. 观察 SSE `/api/run/:id/stream` 的 `token` 事件；
3. 完成后确认对话内出现 Top 推荐与合规摘要；内部的 `report.json` 存在但不再对外提供下载；没有 `report.html`；
4. 打开候选人详情，确认每个维度都有原文 quote 与字符区间。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 页面提示没有可用提供商 | 在「设置 → 模型」添加/编辑提供商并绑定 Key；持久化到 `data/providers.json` |
| 绑定失败 401/403 | Key 无效或已撤销；重新生成后绑定 |
| 绑定提示网络 warning | Key 已保存，但 `/models` 校验未成功；检查该提供商的 Base URL 与网络后运行 |
| 图片简历失败，提示缺 OCR 语言数据 | 仅本地回退需要：`pnpm ocr:download`；或设置 `BOLE_OCR_MODE=deepseek` 使用 Vision |
| PDF 失败，提示无文本层 | 扫描件导出为 PNG/JPG 后上传 |
| SSE 不显示 token | 检查反向代理是否缓冲 SSE（关闭 `proxy_buffering`）；本机直连正常 |
| 端口被占用 | `pnpm bole web --port 8788` |
| 台账需要清空 | `pnpm bole reset --yes` 或页面「工具与环境 → 清空台账」 |
| 旧运行报告仍存在 | 报告按 `jobId` 关联；reset 会删 `runs/`，或手工删除对应目录 |
