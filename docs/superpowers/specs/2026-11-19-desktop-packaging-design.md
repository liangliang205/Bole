# 伯乐 BoLe Desktop 版：打包与前端 TS/React 迁移设计

- 日期：2026-11-19
- 状态：待批准
- 分支：`dev`（工作树干净，HEAD `6d32e94`）

## 1. 意图与背景

BoLe 的 MVP 已经告一段落。现在的形态是「本地常驻 Node 服务 + 浏览器打开 `http://127.0.0.1:8787`」，启动要靠 `pnpm install && pnpm web`，对演示对象（客户 / HR / 同事）不可接受。

本期要两件东西，按顺序：

1. **一个可以双击运行的 Windows 演示版**，用于现场演示。不需要自动更新、代码签名、多平台。
2. **演示之后继续开发的前端底座**：把 3,662 行手写 DOM 迁到 React + TypeScript，让后续迭代有组件边界和类型保护。

两件事共享同一个接缝——后端那套纯 HTTP 的 JSON + SSE 接口。所以它们可以分开交付：先把壳打通拿到可演示的安装包，再换掉壳里的前端，互不阻塞。

## 2. 目标 / 非目标 / 反目标

### 目标

- **G1 双击即用**：`BoLe-Setup-x.y.z.exe` 安装后从开始菜单启动，自动起本地服务、自动开窗口，用户不需要碰 Node、pnpm、命令行。
- **G2 数据落在用户目录**：台账、运行产物、上传缓存、知识库全部落在 `%APPDATA%\bole`，卸载重装不丢，也不写进安装目录（安装目录可能只读）。
- **G3 演示零事故**：端口被占自动换、二次启动聚焦已有窗口而不是开第二个服务、启动失败给出可读错误和一键打开日志、退出时优雅停服。
- **G4 前端 100% TypeScript**：`src/web/public/*.js` 四个文件消失，由 React + TS 取代；业务代码里不残留 `.js`。
- **G5 不破坏现有路径**：`pnpm web`、`pnpm check`、Docker 部署、CLI 子命令全部保持可用且行为不变。

### 非目标（本期不做）

- 代码签名证书、自动更新通道、崩溃上报、激活授权。
- macOS / Linux 打包（只做 Windows x64）。
- 托盘常驻、开机自启、全局快捷键。
- 前端视觉改版：迁移期间像素对齐现状。
- 后端重构：除了第 6 节列出的 4 处必要改动，不动服务端。

### 反目标（这些做法等于失败）

- 为了「更像桌面应用」把 HTTP 接口改成 Electron IPC，导致服务端、Docker、浏览器三种形态分叉。
- 为了 React 重写 `styles.css`，带来一次纯粹的视觉回归风险。
- 在演示版阶段顺手把后端类型从 `strict` 推到 `noUncheckedIndexedAccess` 全开，把交付拖成重构。
- 为了让安装包变小而砍掉正在被 agent 真正使用的工具（导出 Word / PDF）。

## 3. 已验证的现状事实

以下都是对着代码确认过的，不是推测：

| 事实 | 位置 |
|---|---|
| 后端/CLI/测试 已 100% TS：162 个 `.ts`、21,240 行 | 全仓 |
| JS 只剩 7 个：前端 4 个共 3,662 行 + `eslint.config.js` + `scripts/healthcheck.mjs` + `tests/fixtures/mcp/echo-server.mjs` | `src/web/public/` |
| 前端是手写 DOM：`index.html` 589 行/281 个 id，`app.js` 3,170 行/146 函数/449 处 `$('#id')`/145 个监听器，`styles.css` 897 行/555 条规则 | `src/web/public/` |
| 后端是干净的 HTTP 契约：约 30 条 `/api/*` 路由 + SSE，前端不碰 Node | `src/web/server.ts` |
| 启动链路：`node src/cli/index.ts web --port` → `startWebServer({host,port})` → `server.listen(port,host)`，启动后 stdout 打印 `BoLe Web 已启动: http://host:port` | `src/cli/index.ts:629`、`src/web/server.ts:1590` |
| 已有 `/healthz` `/readyz`，`readyz` 在 draining 时返回 503 | `src/web/server.ts:478` |
| 有 drain 能力，但**没接在信号上**：`drainWebServer(server)` 会等运行中任务落检查点（最长 60s）再关服；信号处理只装在 `scripts/serve.ts`（Docker）里，`web` CLI 路径没有 → 桌面壳必须自己触发 | `src/web/server.ts:65`、`:1570`、`scripts/serve.ts` |
| 路径模型：`projectRoot()` = `import.meta.dirname` 上两级；`data/` `runs/` 可用 `BOLE_DATA_DIR` `BOLE_RUNS` 覆盖，`config/` **不可**覆盖 | `src/util/fsx.ts`、`src/config.ts:71` |
| `config/` 运行时**只读**（只有 `readFileSync`，无写入）→ 可以放进安装目录 | `src/core/registry.ts`、`src/config.ts` |
| 静态资源运行时读盘：`PUBLIC_DIR = <server.ts 目录>/public`；PDF.js 直接读 `node_modules/pdfjs-dist/build` | `src/web/server.ts:190`、`:200` |
| 三处 `node:sqlite`（`DatabaseSync`），无 flag | `src/core/db.ts`、`src/core/ledger.ts`、`src/knowledge/service.ts` |
| `node-pty@1.1.0` 的 win32-x64 预编译是 **N-API**（49 个 `napi_` 符号）→ 跨 Node/Electron ABI 稳定，不需要 `electron-rebuild` | `node_modules/.pnpm/node-pty@1.1.0` |
| 子进程会 `spawn(process.execPath, [*.ts])` 跑自己（pty-host、npm 安装插件） | `src/mail/setup-runtime.ts:81`、`src/skills/installer.ts:73` |
| 存在 `spawn(process.execPath, [fileURLToPath(new URL('./pty-host.ts', import.meta.url))])` 的自引用 | `src/mail/setup-runtime.ts:81` |
| `node_modules` 实测 638 MB / 12,394 文件 | `bole/node_modules` |

### 依赖体积的真实构成（更正此前口径）

| 包 | 体积 | 用途 |
|---|---|---|
| `@deepseek-ai/libreoffice-kit-win32-x64` | 189.7 MB | Office→PDF 原生转换 |
| `@deepseek-ai/libreoffice-kit-wasm` | 145.3 MB | **同上，wasm 兜底；Windows 原生可用时是纯死重** |
| `node-pty@1.1.0` | 61.4 MB | 终端；含 darwin/win32-arm64 预编译 |
| `tesseract.js-core` | 43.2 MB | OCR wasm |
| `pdfjs-dist` | 35.6 MB | PDF 预览/解析 |
| `@napi-rs/canvas-win32-x64-msvc` | 35.0 MB | docx 渲染 |
| `typescript` / 其它 devDeps | ~30 MB | 打包时不该带 |
| `@deepseek-ai/cordis` + `dsh-tool-workspace-dependencies` | **0.6 MB** | 仅供 `load_workspace_dependencies` 一个工具 |

结论：**真正的大头是 LibreOffice（338.7 MB），不是 cordis**。把 `load_workspace_dependencies` 换成自实现只省 0.6 MB，收益是「去掉一个 alpha 依赖 + 去掉一个只在 DSH payload 下才有意义的工具」，不是省空间。省空间靠三件事：剔除 wasm 版 LibreOffice（-145 MB）、剔除跨平台预编译（-57 MB）、只装生产依赖（-30 MB）。

## 4. 方案与取舍

### 4.1 桌面壳（三选一，已选 A）

| | A. Electron | B. Tauri 2 + Node sidecar | C. 浏览器 + 启动器 |
|---|---|---|---|
| 运行时 | Electron 自带 Node | 自带 WebView2 + 自带 node.exe | 系统浏览器 |
| 服务端能否原样跑 | 能（Node 24 线） | 能（sidecar） | 能 |
| `node:sqlite` | Electron ≥37 已修复（[PR #47706](https://github.com/electron/electron/pull/47706)，2025-07 合入 36/37/38 分支）；Electron 44 = Node 24.22.3 | sidecar 保证 | 保证 |
| `node-pty` | N-API 预编译，免 rebuild | 免 rebuild | 免 rebuild |
| 安装包 | ~200 MB | ~110 MB | ~0 MB |
| 额外工程 | 低 | Rust 工具链 + 自己管进程生命周期 + 资源路径 | 要装 Node、要开浏览器，不像「app」 |
| 结论 | **选它** | 省下的 90 MB 被「多一个运行时 + Rust + 手写进程管理」吃回去 | 演示场合不可接受 |

Electron 的关键好处是**它不是「套壳浏览器」，而是「自带正确 Node 的服务宿主」**：`ELECTRON_RUN_AS_NODE=1` 让同一个 `electron.exe` 以 Node 身份跑现有服务端，`process.execPath` 在子进程里仍然指向它，于是 `spawn(process.execPath, ...)` 这类代码零改动继续工作。

### 4.2 前端迁移方式（二选一，已选 A）

- **A. 一次性重写（选它）**：`index.html` 那 281 个 id 和 `app.js` 的 449 处选择器是一个整体，按屏逐步替换意味着新旧两套 DOM 共享同一份 HTML 与同一批 id，混合期的复杂度高于重写。
- B. 增量（React 只接新页面）：看起来稳，实际要长期维护两套状态管理，且旧代码仍在驱动同一批 DOM 节点。

用 `styles.css` 原样复用来消化「重写会不会变丑」的风险——迁移只换 DOM 结构，不换视觉。

### 4.3 顺序（已选：先壳后前端）

壳（主进程、端口、数据目录、瘦身、安装器）与 UI 无关。先做完能在 3 天内拿到可演示安装包，之后 React 版本只是替换壳里的前端产物，前面的工作零浪费；反过来先花两周重构，演示风险全部压在最后一周的打包未知数上。

## 5. 设计：桌面壳

### 5.1 仓库结构

```
bole/
  desktop/                 # 新增，Electron 壳（不进 Docker 镜像）
    main.ts                # 主进程（esbuild 打包成 dist/main.mjs）
    preload.ts             # 只暴露 openExternal / 数据目录 / 版本
    build.mjs              # esbuild + 资源准备 + electron-builder 调用
    builder.yml            # electron-builder 配置
  src/                     # 服务端，随包发原样（见 5.4）
  config/                  # 只读资源，随包发
  frontend/                # 新增，Vite + React + TS（第 8 节）
  package.json             # + electron / electron-builder devDeps 与 desktop:* 脚本
```

`frontend/` 独立 `package.json`，理由：Docker 镜像与 `pnpm check` 不该被 React 工具链拖慢；`desktop/` 的依赖只进 devDependencies，Dockerfile 用 `--prod` 安装，镜像不受影响。

### 5.2 安装后的目录布局

```
BoLe.exe
resources/
  app.asar                # dist/main.mjs + preload.cjs
  server/                 # extraResources，未打包（需要真实文件路径）
    src/                  # 服务端源码原样
    config/               # 只读配置（agents.json / pipeline.json / prompts / skills）
    node_modules/         # 生产依赖，剪枝后
```

**为什么 `server/` 必须放在 asar 外**：`node-pty` 的 `.node` 不能从 asar 内加载；`spawn(process.execPath, ['src/mail/pty-host.ts'])` 需要一个真实的路径；`PUBLIC_DIR` 与 PDF.js 资源是按目录读盘的。

**对照参考**：同机的 DSH 桌面版（Electron 44.7.0）走的是另一条路——服务端入口 `<app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js` **留在 asar 内运行**，原生二进制（`node-pty`、`libreoffice-kit-win32-x64\dsoffice.exe`、`@img/sharp`、`koffi`）放 `app.asar.unpacked`。说明「服务端从 asar 里跑」在 Electron 上是可行的，`extraResources` 不是技术限制。我们仍选 `extraResources`：能直接看见文件、能单独替换 `server/` 而不重打包、调试期成本最低。

**为什么把 `src/` 原样发而不是编译**：`projectRoot()` 靠 `import.meta.dirname` 上两级定位仓库根，`PUBLIC_DIR`、`PDFJS_DIR` 都是相对目录推算。原样发 `src/` + `config/` + `node_modules/` 三者平级，**所有路径逻辑一行不用改**；一旦改成单文件 bundle，`import.meta.dirname` 全部失效，还要处理 `new URL('./pty-host.ts', import.meta.url)` 的自引用。

前提是 Electron 的 Node 能直接跑 `.ts`。依据有两条：Electron 维护者在 [PR #49711](https://github.com/electron/electron/pull/49711) 里明确写了「Electron already supports type stripping by default」，该 PR 只是补上非可擦除语法需要的 `--experimental-transform-types`；而本项目现在就是在 Node 24 默认擦除下跑的（`node src/cli/index.ts`），源码天然只含可擦除语法。M0 仍要跑一次确认，但不再是未知数。

### 5.3 进程模型与启动顺序

```
Electron main
  ├─ 单实例锁（拿不到 → 聚焦已有窗口，退出）
  ├─ 选端口（上次用的 → 8787 → 扫 8788–8900）
  ├─ spawn(electron.exe, ['src/cli/index.ts','web','--port',String(port)],
  │        { cwd: resources/server,
  │          env: { ELECTRON_RUN_AS_NODE:'1', BOLE_DATA_DIR, BOLE_RUNS, BOLE_SHUTDOWN_TOKEN },
  │          stdio: ['ignore','pipe','pipe'] })
  ├─ 解析 stdout 里 `BoLe Web 已启动: http://…:PORT` → 得到真实 URL
  ├─ 轮询 /readyz（300ms 间隔，最长 60s）
  ├─ BrowserWindow.loadURL(url)
  └─ 退出时 POST /api/shutdown → 等服务退出（最长 15s）→ 未退则 kill
```

- **端口必须尽量稳定，不能每次随机**。前端把主题、侧栏宽度、正文宽度、预览宽度、抽屉宽度、邮箱偏好、默认评分标准、默认团队存在 `localStorage` 里，而 `localStorage` 按 **origin（含端口）** 分区；端口一变，这些全部静默重置，主题还会在首帧闪一下。所以：把上次成功使用的端口记在 `userData/port.json`，下次启动优先复用 → 再试 8787 → 再在 8788–8900 里扫一个空闲端口。端口被长期占用时 UI 偏好会重置一次，这是可接受且有记录的代价（不引入 preload 持久化桥，保住 5.1 的最小面）。`cmdWeb` 会校验 1–65535，所以不走 `--port 0`。服务端 stdout 打印的 `BoLe Web 已启动: http://…:PORT` 是回传真实 URL 的唯一可靠通道（Docker、CLI、桌面三种形态都走它）。
- **健康检查**：`/readyz` 已存在，`startWebServer` 在 `listen` 回调后才打印那行，所以「拿到 URL」基本等于「已在监听」，`/readyz` 只是二次保险（覆盖 MCP 后台启动等）。
- **优雅退出**：Windows 上 `child.kill('SIGTERM')` 实际是 `TerminateProcess`；何况 `web` CLI 路径本来就没装信号处理（只有 `scripts/serve.ts` 装了）。所以新增 `POST /api/shutdown`（见 6.3），由它调用 `drainWebServer` 等运行中任务落检查点（≤60s）再退出；15s 未退再强杀，并在日志里记一笔。
- **子进程语义**：`ELECTRON_RUN_AS_NODE=1` 会沿环境变量继承给孙进程（pty-host、`npm install`），无需逐个改。

### 5.4 前端产物怎么加载

窗口**直接 `loadURL(http://127.0.0.1:<port>/)`**，不引入自定义协议，也不从 asar 读 `index.html`：

- 同源 → 现有 `fetch('/api/...')` 与 `EventSource` 一行不改，SSE 没有跨域/混合内容问题。
- 开发与打包走同一条路径，不用维护两套加载逻辑。
- 以后换成 React 只是替换服务端 `PUBLIC_DIR` 指向的新产物，主进程不动。

**另一个可选做法**：上游 DSH 桌面版不给窗口用 `http://127.0.0.1`，而是注册特权自定义协议（进程参数可见 `--standard-schemes=dsh-app --secure-schemes=dsh-app --cors-schemes=dsh-app --fetch-schemes=dsh-app`），origin 固定为 `dsh-app://`，端口怎么变都不影响 `localStorage`，也不把 API 端口暴露给本机其他进程。本期不抄：它要求主进程做 `protocol.handle` 转发（SSE 与上传的流式转发需要单独验证），而演示版阶段「端口记忆」已经把 origin 抖动压到很小。等 React 迁完、真要长期分发时再升级。

### 5.5 数据目录与首次启动

- `%APPDATA%\bole\`（`app.getPath('userData')`，先 `app.setName('bole')`）
  - `data\` → `BOLE_DATA_DIR`（台账 `ledger.db`、知识库、上传、OCR、providers、keyring）
  - `runs\` → `BOLE_RUNS`
  - `logs\server-YYYYMMDD.log`
- `config/` 留在安装目录只读；**不复制到用户目录**，因为运行时只读它，升级时天然跟着版本走。
- 首次启动不塞种子数据。**验证点**：空 `data/` 目录必须能跑通 `bootstrap`（默认 agent registry、评分标准、知识库初始化）。若不成立，改为首启复制 `seed/` 并打标记文件。
- **首启必然缺 provider**：`bootstrap()` 在没有 provider 时直接抛错（`src/bootstrap.ts:63`），`/api/run` 也会被挡。所以「开箱即用」靠的不是预置数据，而是一条明确的准备流程：装好 → 设置 → 模型 → 填 provider 和 key → 再开始。安装包里**不打包任何 API key**；演示机的 key 由演示的人现场填一次（存在 `%APPDATA%\bole\data\` 的加密 keyring 里，之后不再需要）。这条写进演示准备清单，不进代码。

### 5.6 窗口、菜单与错误体验

- 1440×900、最小 1024×700、启动时白色/深色按 `bole.theme` 记忆、`show:false` + 只读 splash 直到 ready。
- 精简中文菜单：重载、开发者工具、缩放、**清空演示数据**、打开数据目录、关于；去掉默认英文菜单。
  「清空演示数据」= 原生二次确认 → `POST /api/reset`（服务端已有，`src/web/server.ts:1535`，但前端从没接过）→ 自动重启服务。演示要准备两轮就得有它，否则只能手工删 `%APPDATA%\bole`。
- 服务端异常退出 → `dialog.showMessageBox` 展示最后 30 行 stderr + 「打开日志目录」按钮；窗口不静默白屏。
- 日志：stdout/stderr 双写文件（>5 MB 轮转保留 3 份）。

### 5.7 安装器

`electron-builder` + NSIS：`oneClick:false`、`allowToChangeInstallationDirectory:true`、`perMachine:false`、`createDesktopShortcut:'always'`、`language:'2052'`（简体中文）、`artifactName:'BoLe-Setup-${version}.exe'`。不签名——首次运行会有 SmartScreen 警告，README 里写清楚「更多信息 → 仍要运行」。

## 6. 需要改动的后端代码（全集）

刻意压到 4 处，每处都小：

1. **`src/util/fsx.ts` — `projectRoot()` 支持 `BOLE_ROOT`**
   为将来切构建产物留后门；打包走「原样发源码」时其实用不到，但 Docker / 自定义安装位置会需要。

2. **`src/web/server.ts` — `PUBLIC_DIR` 支持 `BOLE_WEB_DIR`**
   ```ts
   const PUBLIC_DIR = process.env.BOLE_WEB_DIR ?? path.join(import.meta.dirname, 'public');
   ```

3. **`src/web/server.ts` — 新增 `POST /api/shutdown`**
   仅当 `process.env.BOLE_SHUTDOWN_TOKEN` 存在时启用，校验请求头 `x-bole-token`，命中后调用已有的 drain 逻辑并退出；未设置 token（CLI 日常、Docker）时该路由返回 404，行为完全不变。

4. **`src/tools/tools-call.ts` — 用本地实现替换 `@deepseek-ai/dsh-tool-workspace-dependencies`**
   新增 `src/tools/workspace-deps.ts`：读 `BOLE_DSH_PAYLOAD` 或 `data/workspace-payload` 下的 `runtime.json`，返回 python/node/pnpm 绝对路径与版本；payload 不存在时返回**现有那条中文降级提示**（当前桌面环境本来就没有 payload，所以行为等价）。顺带把 `python_exec` 里 `bundledPython()` 的依赖一起摘掉。收益是去掉一个 alpha 依赖，不是省空间（见第 3 节更正）。

5. **`src/mail/setup-runtime.ts` — pty-host 路径兼容 `.ts`/`.js`**（仅当 R1 触发、需要改成编译产物时才做）
   ```ts
   const ts = new URL('./pty-host.ts', import.meta.url);
   const host = existsSync(fileURLToPath(ts)) ? ts : new URL('./pty-host.js', import.meta.url);
   ```

## 7. 设计：依赖瘦身与打包管线

顺序（`desktop/build.mjs` 串起来）：

1. `pnpm install --prod --frozen-lockfile` 到一个 staging 目录（只留生产依赖，-30 MB），复制 `src/`、`config/`、`package.json`。
2. 剪枝（**每次都跑一遍冒烟测试**）：
   - 删 `node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm@*`（-145 MB，Windows 用原生）
   - 删平台不匹配的预编译：`libreoffice-kit-{darwin-*,win32-arm64}`、`node-pty/prebuilds/{darwin-*,win32-arm64}`（-57 MB）、`@napi-rs/canvas-*` 非 win32-x64、**`@tencent-qqmail/agently-cli-{darwin-*,linux-*}`**（运行时按平台解析二进制，见 `src/mail/client.ts:34`）
   - `tesseract.js-core` 保留（OCR 需要全部 wasm 变体做指令集回退）
3. OCR 兜底数据入包：把 `scripts/download-ocr.ts` 的产物（`chi_sim` + `eng` traineddata，约 15–40 MB）下载到 `resources/server/ocr/`，并以 `BOLE_OCR_DIR` 指过去。默认走 DeepSeek Vision，但演示机断网/限流时 `BOLE_OCR_MODE=local` 是唯一的安全阀，而 `src/ingest/ocr.ts:37` 在缺文件时直接抛错。
4. 冒烟测试（在 staging 目录里跑，不依赖 Electron）：
   - `node src/cli/index.ts web --port 18787` → 从 stdout 抓 URL → `GET /readyz` 200 → 关掉（CLI 不接受 `--port 0`）
   - 一次 `office_export_pdf` 转换（验证 LibreOffice 原生路径仍然可用，不是走了被删的 wasm）
   - 一次 `node src/mail/pty-host.ts`（验证 ConPTY 预编译还在，`node-pty` 剪枝没剪错）
5. esbuild 打 `desktop/main.ts` → `desktop/preload.ts` → `dist/`
6. `electron-builder --win nsis` → `desktop/out/BoLe-Setup-0.1.0.exe`

预期体积（待实测校准）：解包后 ~380–420 MB，安装包 ~170–220 MB。

## 8. 设计：前端 React + TS

### 8.1 选型

| 关注点 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite + React 19 + TS | 与现有 `tsc --noEmit` 严格模式对齐 |
| 服务端状态 | TanStack Query | 页面里 90% 是 `/api/*` 的取数、缓存、失效 |
| 跨屏 UI 状态 | zustand | 当前 job、抽屉开合、设置 tab 这类全局 UI 状态 |
| 样式 | **原样复用 `styles.css`** | 897 行、class 驱动，迁移期零视觉漂移 |
| Markdown | `react-markdown` | 替掉 `app.js` 里手写的 `renderChatMarkdown` |
| 组件库 | 不引入 | 现有样式已经覆盖，引入即重写 |
| 测试 | Vitest + jsdom（hooks/工具）+ Playwright 冒烟 3 条（可选） | 现有 `node --test` 不覆盖前端 |

**上游参考（同机的 DSH 桌面版前端）**：React **18.2** + `react-dom/client`（`createRoot` / `hydrateRoot`）+ Vite 6 + TS 6，`packages/client/` 下 59 个 `ui-*` 包、673 个 `.tsx`、512 处 React 导入。两条值得借鉴、一条不必照抄：

- **不引入任何状态库**（无 redux/zustand/jotai/react-query），而是 80 处 `useSyncExternalStore` 直接订阅 cordis 服务的 `subscribe/getSnapshot`。原因是它的数据源是进程内服务快照；bole 的数据源是 REST + SSE，所以 TanStack Query 仍然合适。
- 但**流式 token 必须走外部 store + `useSyncExternalStore`**，不要用 `useState` 每 token 触发一次整树渲染——这条直接照抄。
- 它那套 `ui-slots` / `ui-renderer` 插槽插件体系是给「客户端插件运行时加载」用的（每个 `ui-*` 单独产出 `lib/client.js`），bole 只有一套 UI，不需要。

**已定：React 19**（2026-11-19 决定）。上游是 18.2，参考它的 hooks 与类型写法时注意差异：`useSyncExternalStore`、`createRoot`/`hydrateRoot` 语义与 API 在 19 里不变，`forwardRef` 在 19 中仍可用但已非必需（ref 可直接作为 prop）。

### 8.2 目录

```
frontend/
  src/
    api/          # fetch 封装 + 契约类型（复用 src/types.ts 的形状）+ zod 解析
    features/
      sessions/   # 侧栏会话列表、新建
      chat/       # 会话流、SSE、附件、HITL、审批
      drawer/     # 候选人 / 成本 / 合规 / 工作流
      settings/   # 模型 / 插件 / Agent / 记忆
      mailbox/
      knowledge/
    components/   # Button / Modal / Drawer / Toast / Resizer 等通用件
    styles/bole.css
    App.tsx
```

### 8.3 契约与 SSE

- `api/` 里按现有路由写一层 `request()` + 每个端点的类型；后端返回体用 zod 在开发模式下校验（仓库已有 zod，零新增依赖）。
- SSE：封装 `useEventSource()`，处理重连与 `token`/`snapshot`/`status`/`done` 四类事件；流式 token 直接写进 Query 缓存，避免整页重渲染。
- 上一版那个「轮询兜底」（`startFallbackPoll`）保留，作为 SSE 断线时的降级。

### 8.4 迁移批次（每批结束都能跑）

| 批 | 内容 | 验收 |
|---|---|---|
| B0 | 脚手架、布局壳（侧栏/主区/分栏拖拽）、主题、Toast/Modal/Drawer 通用件 | 空壳能开、主题能切、分栏能拖 |
| B1 | 会话列表 + 聊天流（SSE、Markdown、附件上传、HITL、审批弹窗） | 建会话 → 看到流式输出 → 回答 HITL |
| B2 | 抽屉四页（候选人/成本/合规/工作流）+ 终稿报告 + PDF 预览 | 打开候选人详情、预览 PDF |
| B3 | 设置四件套（模型/插件/Agent/记忆） | 增删 provider、装插件、改评分标准 |
| B4 | 邮箱（适配器、授权轮询、筛选表单）+ 知识库（增删/上传/统计） | 知识库可检索；邮箱：有账号则跑通真实授权，没有则记为已知限制（不阻塞前几批复用） |
| B5 | 删除 `src/web/public/*.js`，服务端 `STATIC_FILES` 收口到新产物 | 旧文件归零、`pnpm check` 绿 |

## 9. 里程碑与工作量

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M0 | 环境验证 spike：Electron 44 下 `ELECTRON_RUN_AS_NODE` 跑 `.ts` + `require('node:sqlite')` + `node-pty` 起一个**假子进程**（不需要真邮箱） | 0.5 天 |
| M1 | 依赖瘦身 + staging 管线 + 冒烟测试 | 1 天 |
| M2 | Electron 壳（单实例、端口、健康检查、优雅退出、日志、错误弹窗）+ NSIS 安装器 | 1.5 天 |
| — | **M2 结束：可演示安装包交付** | 3 天 |
| M3 | 前端 B0 + B1 | 4 天 |
| M4 | 前端 B2 | 3 天 |
| M5 | 前端 B3 | 3 天 |
| M6 | 前端 B4 | 3 天 |
| M7 | B5 收尾 + 全链路回归 + 文档 | 2 天 |

合计约 3 周（单人 + AI 协助，含缓冲）。

## 10. 风险与验证点

| # | 风险 | 触发后果 | 处置 |
|---|---|---|---|
| R1 | Electron 的 Node 不支持直接跑 `.ts` | 5.2 的「原样发源码」不成立 | **已大幅降级**：Electron 维护者在 [PR #49711](https://github.com/electron/electron/pull/49711) 确认「type stripping 默认启用」，项目源码本身也只含可擦除语法；M0 只需实测一遍。注意：同机的 DSH 桌面版服务端入口是编译后的 `.js`，它证明不了这一条。若仍失败，启用第 6 节第 5 条 + tsc 构建（`outDir` 保持结构），或退到 sidecar `node.exe`（+110 MB） |
| R2 | ConPTY 在无控制台的 `ELECTRON_RUN_AS_NODE` 子进程里行为异常 | 邮箱授权 / 终端类流程挂 | **机制**风险在 M0 用假子进程验证（不依赖真邮箱）；**真实 OAuth 流程**随 B4 验证，不阻塞 M2 交付。`docs/DEMO_SCRIPT.md` 本身不演邮箱，故邮箱不作为演示门槛。旁证：同机 DSH 桌面版（Electron 44）打包时确实把 `node-pty` 的 `conpty.dll`/`OpenConsole.exe` 放进了 `app.asar.unpacked`，说明这套组合在目标平台上落过地 |
| R3 | 剪枝后 LibreOffice 走了 wasm 或直接失败 | Office→PDF 导出挂（演示可见） | 剪枝后必跑冒烟测试（7.2）。旁证：DSH 桌面版同样只把 win32-x64 的 `dsoffice.exe`（186 MB）打进去，没带 wasm |
| R4 | 首次启动空数据目录 bootstrap 不完整 | 开箱即坏 | M2 在干净 `%APPDATA%` 上全流程走一遍 |
| R5 | SmartScreen / 杀软误报 | 演示机拒装 | README 写明绕过步骤；必要时把安装包改 zip 分发 |
| R6 | 演示机没有 Python / git | `python_exec`、部分插件失败 | 工具本身已有中文降级提示；演示脚本避开这些路径 |
| R7 | 数据目录含 `keyring.json` 明文密钥 | 泄露风险 | `keyring.json` 已在 `data/` 内、随用户目录；导出/分享 demo 环境时提醒清空 |

## 11. 留给 builder 的决定

- 图标与产品名（`BoLe` vs `伯乐`）、安装器文案。
- 日志轮转的具体阈值与保留份数。
- B0–B4 内部再细分的组件边界与文件切分。
- 是否上 Playwright（若上，选哪 3 条）。
- splash 用一张静态图还是纯 CSS。
- `desktop/` 的 esbuild 是否需要 sourcemap（建议 production 关掉）。

## 12. 已由用户决定的部分

- **发行定位**：先发一个**用于演示**的版本，后续继续开发 → 不做签名/自动更新/多平台。
- **前端框架**：React **19**（不降到上游 DSH 用的 18.2）。
- **依赖处理**：把 `load_workspace_dependencies` 改为本地实现，去掉 `@deepseek-ai/dsh-tool-workspace-dependencies` 依赖。（体积收益经更正后为 0.6 MB，主要收益是去掉 alpha 依赖；空间收益来自第 7 节的剪枝。）
