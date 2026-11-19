# 伯乐前端 React 迁移（F0–F6）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/web/public/` 的 3,662 行手写 DOM 迁到 React 19 + TypeScript，**视觉零漂移**——每批迁移都能拿出「旧页面 / 新页面 / 差异图」三张并排证据。

**Architecture:** `frontend/` 是独立的 Vite + React 19 + TS 应用，只通过 HTTP 与既有服务端通信（`/api/*` + SSE），开发时由 Vite dev server 代理到 `pnpm web` 的 8787。样式表 `styles.css` 原样复用；React 组件沿用原 DOM 的 `id`/`class`，因此同一套 Playwright 配方能同时驱动新旧两版，截图逐像素对比。后端只加一处改动：静态目录支持 `BOLE_WEB_DIR`。

**Tech Stack:** React 19、TypeScript 5.9、Vite 6.4、TanStack Query 5、zustand 5、react-markdown 9、Playwright（仅截图对照）。

**Spec:** `docs/superpowers/specs/2026-11-19-desktop-packaging-design.md`（第 8 节，尤其 8.5 对照与验收）

> 打包（D0–D2）另见 `plans/2026-11-19-desktop-packaging.md`，排在本计划之后执行。

## Global Constraints

- **`frontend/src/styles/bole.css` 是 `src/web/public/styles.css` 的逐字节副本，迁移期间禁止修改**。视觉漂移只能来自 DOM 结构，不能来自样式。
- **沿用原 `id` 与 `class`**：`index.html` 里的 281 个 id 在 React 里保持同名的 `id` 属性，容器层级与类名保持一致，否则样式表与对照脚本都会失效。
- **旧 UI 全程保留**，直到 F6 才删；F6 之前 `pnpm web` 必须始终可用。
- **不引入 UI 组件库**（不用 shadcn/Radix/MUI），不重写样式，不改后端接口语义。
- 所有校验必须通过：`pnpm check`（根，后端不变）、`cd frontend; pnpm typecheck; pnpm test`。
- 源码只含可擦除 TS 语法（禁 `enum`/`namespace`/参数属性）；纯类型导入写 `type`。
- 面向用户文案用中文，与现有文案逐字一致（文案变化会在截图里被放大）。
- 每个任务结束时必须跑 `node scripts/shoot.mjs` 并记录本批状态的差异比例；**> 2% 不算完成**。

## Review Focus

1. **字号与行高在不同元素上继承不同**：原页面靠 `styles.css` 的 class 层级决定排版，React 里多包一层 `div` 就可能改变 `line-height` 继承。期望：包一层也看不出差异。每批的截图对照覆盖（F1 的空状态、F2 的聊天流最敏感）。
2. **SSE 流式输出的滚动与追底**：原实现手写 `use-chat-scroll` 逻辑（`app.js` 有 `chat-scroll`、`scrollTop` 处理）。期望：流式输出时输入框不被顶走、滚到底部后跟随、用户上滑后不强制追底。F2 的手动验收清单逐条检查。
3. **`contenteditable` 输入框**：`#reply-input` 是可编辑 div（不是 textarea），带粘贴与 IME 处理。期望：中文输入法组字时不会丢字、粘贴富文本被降级为纯文本。F2 用中文输入法实测一次。
4. **拖拽分栏宽度记忆**：侧栏/正文/抽屉/预览四条 resizer 的宽度存 `localStorage` 并在刷新后恢复。期望：新页面刷新后宽度不变。F1 验收里逐条刷新确认。
5. **弹窗的焦点与 Escape**：`help-dialog` 用原生 `<dialog>`，其余用 `.modal`。期望：Esc 关闭、打开时焦点进入弹窗、关闭后焦点回到触发按钮。F4/F5 验收各测一次。

---

### Task F0: 对照工具链（脚手架 + 双开 + 截图基线）

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/styles/bole.css`（复制品）, `frontend/scripts/shoot.mjs`, `frontend/scripts/states.mjs`, `frontend/.gitignore`
- Modify: `eslint.config.js:16-23`（忽略 `frontend/**`）

**Interfaces:**
- Consumes: 既有 `pnpm web`
- Produces:
  - `node frontend/scripts/shoot.mjs --base <url> --out <dir>`：对 `states.mjs` 里的每个状态截图，返回退出码 0/1
  - `node frontend/scripts/shoot.mjs --compare`：同时跑旧（8787）与新（5173），输出三图并打印差异比例
  - `frontend/scripts/states.mjs` 导出 `export const states: { name: string; steps: Step[] }[]`，`Step = { click?: string; fill?: string; text?: string; waitFor?: string; waitMs?: number }`

- [ ] **Step 1: 写 `frontend/package.json`**

```json
{
  "name": "bole-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "shoot": "node scripts/shoot.mjs"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-markdown": "^9.0.1",
    "@tanstack/react-query": "^5.62.0",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.7.0",
    "playwright": "^1.49.0",
    "typescript": "^5.9.3",
    "vite": "^6.4.3",
    "vitest": "^4.0.0",
    "jsdom": "^25.0.0"
  }
}
```

- [ ] **Step 2: 写 `frontend/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
});
```

- [ ] **Step 3: 写 `frontend/tsconfig.json`**（`jsx: "react-jsx"`、`strict: true`、`noEmit: true`、`lib: ["ES2023","DOM","DOM.Iterable"]`、`moduleResolution: "bundler"`）

- [ ] **Step 4: 复制样式表并加同步脚本**

```powershell
cd D:\agent\bole
New-Item -ItemType Directory -Force frontend\src\styles | Out-Null
Copy-Item src\web\public\styles.css frontend\src\styles\bole.css
```
在 `frontend/package.json` 的 scripts 里加 `"sync:styles": "node scripts/sync-styles.mjs"`，该脚本逐字节比较并复制；若目标已存在且内容不同，**打印警告但仍复制**（开发期允许，F6 会收敛）。

- [ ] **Step 5: 写 `frontend/index.html` 与占位 `src/main.tsx`**

`index.html` 只保留 `<div id="root">` + `<script type="module" src="/src/main.tsx">`，`<title>` 与 `lang="zh-CN"` 与旧页一致；`main.tsx` 先渲染一行「React 迁移占位 —— 见 B0 任务」，用于确认构建链路通。

- [ ] **Step 6: 安装并确认构建链路**

```powershell
cd frontend; pnpm install; pnpm typecheck; pnpm build
```
Expected: `frontend/dist/index.html` 生成；`pnpm typecheck` 无错。

`pnpm install` 若因 `playwright` 体积失败，可先 `pnpm install --ignore-scripts`，再手动 `npx playwright install chromium`（失败则接受 8.5 的 `--manual` 退路）。

- [ ] **Step 7: 让根 ESLint 跳过 `frontend/`**

在 `eslint.config.js` 的 `ignores` 数组追加 `'frontend/**'`、`'desktop/**'`（`projectService` 需要每个被 lint 的 TS 文件都在某个 tsconfig 里，而这两个子包有自己的 tsconfig）。

- [ ] **Step 8: 写 `scripts/states.mjs`（12 个状态配方）**

按 spec 8.5 的 12 个状态各写一条，形如：

```js
export const states = [
  { name: '01-empty', steps: [{ waitFor: '#empty-view:not(.hidden)' }] },
  { name: '02-session-list', steps: [{ waitFor: '#job-list .job-row' }] },
  // …其余 10 条，选择器全部来自现有 index.html 的 id
];
```

选择器只能用两版都存在的 id/class；`waitFor` 用 `page.waitForSelector`，`waitMs` 兜底等动画结束。涉及弹窗的状态用 `click: '#open-settings'` 这类现成按钮进入。

- [ ] **Step 9: 写 `scripts/shoot.mjs`**

要求：
- `--base <url> --out <dir>`：逐个状态执行 → 截图 `page.screenshot({ fullPage: true })` → 文件名 `<name>.png`
- `--compare`：额外把旧图与新图读成 `pngjs`/`sharp` 之外的**纯 Node** 方式比较（用 `playwright` 自带的 `page.screenshot` 得到 Buffer 后，可用 `sharp`；若无 `sharp`，退化为比较文件大小与逐字节相等，并至少输出两图供人看）
- 打印 `PASS <name> diff=<pct>%` 或 `FAIL <name> diff=<pct>%`
- 差异 > 2% 时以 1 退出（覆盖 Review Focus 1 的量化标准）

- [ ] **Step 10: 生成旧版基线**

```powershell
# 终端 1
cd D:\agent\bole; pnpm web
# 终端 2
cd D:\agent\bole\frontend; node scripts/shoot.mjs --base http://127.0.0.1:8787 --out .shots/old
```
Expected: `.shots/old/` 下 12 张图；打开任意一张确认是有内容的真页面（不是白屏）。

若仓库 `data/ledger.db` 里没有可用任务导致多处空状态，先在旧 UI 里建一个会话再重跑（会话会落进 `data/`）。

- [ ] **Step 11: 提交**

```powershell
git add frontend eslint.config.js
git commit -m "feat(frontend): scaffold react app and screenshot comparison harness"
```

---

### Task F1: B0 —— 布局壳、会话列表、新建会话页

**Files:**
- Create: `frontend/src/api/client.ts`, `frontend/src/api/jobs.ts`, `frontend/src/store/ui.ts`, `frontend/src/components/{Resizer,Modal,Toast,Button}.tsx`, `frontend/src/features/sessions/{Sidebar,JobList,JobRow}.tsx`, `frontend/src/features/new/{EmptyView,Composer}.tsx`, `frontend/src/App.tsx`, `frontend/src/theme.ts`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `states.mjs` 的选择器约定；既有 `GET /api/jobs`、`GET /api/config`
- Produces:
  ```ts
  // api/client.ts
  export async function api<T>(path: string, init?: RequestInit): Promise<T>
  export class ApiError extends Error { status: number }
  // api/jobs.ts
  export interface JobSummary { id: string; title: string; status: string; archived?: boolean; createdAt: string; updatedAt?: string }
  export function useJobs(): { jobs: JobSummary[]; isLoading: boolean; error: Error | null }
  // store/ui.ts
  export const useUiStore: import('zustand').UseBoundStore<...>  // { activeJobId, showArchived, theme, drawerTab, setTheme, toggleArchived, setActiveJob }
  ```

- [ ] **Step 1: 写 `api/client.ts`**

`api<T>(path, init)` = `fetch(path, { headers: { 'content-type': 'application/json' }, ...init })`，非 2xx 抛 `ApiError`，解析 `{ ok, ...data }` 时若 `ok === false` 也抛；SSE 不走这里。

- [ ] **Step 2: 写 `store/ui.ts`（zustand）**

只放跨屏 UI 状态：`activeJobId`、`showArchived`、`theme`、`drawerTab`、`drawerOpen`、`previewFile`。**服务端数据一律走 TanStack Query，不进 zustand。**

- [ ] **Step 3: 写 `theme.ts`**

复刻 `app.js` 的 `applyTheme`：`document.documentElement.dataset.theme = 'dark' | 'light'`，键名 `bole.theme`。首帧前在 `main.tsx` 顶部同步执行一次（对应旧 `index.html` 里的内联脚本）。

- [ ] **Step 4: 写 `components/Resizer.tsx`**

四条拖拽分栏共用：`props: { storageKey: string; defaultWidth: number; min: number; max: number; side: 'left'|'right'; onWidth(width: number): void }`。指针按下 → `setPointerCapture` → `pointermove` 计算宽度 → `pointerup` 落 `localStorage`；`dblclick` 恢复默认；键盘左右键 ±16px（原实现支持，见 `app.js` 的 `keydown` 分支）。

- [ ] **Step 5: 写 `App.tsx` 的骨架**

严格复刻 `index.html` 的容器层级（这是视觉对等的前提）：

```
<div class="app" id="app">
  <aside class="sidebar">…</aside>
  <div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" tabIndex={0} />
  <main class="main">
    <header class="topbar"><div class="topbar-actions">…</div></header>
    <div class="content-resizer content-resizer-left" id="content-resizer-left" … />
    <div class="content-resizer content-resizer-right" id="content-resizer" … />
    <section id="empty-view" class="empty-view">…</section>
    <section id="chat-view" class="chat-view hidden">…</section>
  </main>
</div>
```

`id`/`class` 必须与 `index.html` 一致；`hidden` 用 `hidden` class 而不是条件卸载（避免布局抖动，也让选择器行为一致）。

- [ ] **Step 6: 写侧栏（`Sidebar`/`JobList`/`JobRow`）**

复刻 `.brand`、`#new-run-btn`、`#job-search`、`#job-count`、`#archived-toggle`、`#job-list`、`.side-footer` 三个按钮。行内结构与 `app.js` 的 `renderJobs()` 产物一致（含归档灰显与右键菜单的定位容器 `#session-menu`）。

- [ ] **Step 7: 写新建会话页（`EmptyView`/`Composer`）**

复刻 hero 标题、`#new-requirements` textarea、`#new-attachments`、`#attach-btn`、模式选择器（`#mode-trigger`/`#mode-menu`/`#mode-label`）、邮箱来源选择器（`#new-mail-summary`/`#mail-source-menu`）、`#new-start`、`#new-hint`。**本任务只做静态渲染与开合**，真正提交留到 F2（要接 `POST /api/run` 与事件流）。

- [ ] **Step 8: 双开对照本批状态**

```powershell
cd frontend; node scripts/shoot.mjs --compare
```
Expected: `01-empty`、`02-session-list`、`03-archive`（若有）三态 `diff < 0.5%`；其余状态此时会 FAIL（未实现），这是预期的——本批只对 F1 范围内的状态负责。

- [ ] **Step 9: 手动验收（Review Focus 4）**

- 拖四条 resizer，刷新页面确认宽度恢复
- 切换主题，刷新确认仍是深色（`bole.theme`）
- 复制仓库到带空格的路径后再跑一次，样式仍正常（`#` 与空格不破坏相对路径）

- [ ] **Step 10: 提交**

```powershell
git add frontend
git commit -m "feat(frontend): react shell, sidebar, job list, new-session view"
```

---

### Task F2: B1 —— 会话流（SSE、Markdown、附件、HITL、审批）

**Files:**
- Create: `frontend/src/api/{run,events,chat}.ts`, `frontend/src/hooks/useEventSource.ts`, `frontend/src/store/stream.ts`, `frontend/src/features/chat/{ChatView,MessageList,MessageItem,EventLine,StreamHost,HitlHost,ApprovalHost,Composer,Markdown}.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `api<T>()`（F1）
- Produces:
  ```ts
  // store/stream.ts —— 外部 store，避免每 token 触发整树渲染
  export const streamStore: {
    subscribe(cb: () => void): () => void;
    getSnapshot(): { streaming: string; events: RunEvent[]; snapshot: RunSnapshot | null };
    pushToken(text: string): void;
    reset(): void;
  };
  export function useStreamingText(): string;     // 内部用 useSyncExternalStore
  // hooks/useEventSource.ts
  export function useRunStream(jobId: string | null, onDone?: () => void): { connected: boolean };
  // api/run.ts
  export function useStartRun(): { start(input: { requirements: string; files: File[]; mode: string }): Promise<{ jobId: string }> }
  ```

- [ ] **Step 1: 写 `store/stream.ts`（外部 store）**

按 `DeepSeek` 的运行态复刻 `app.js` 的 `state.streams`/`state.events` 语义：`pushToken` 累积字符串，`run`/`tool` 事件追加到数组，`done` 后清空。**React 侧只用 `useSyncExternalStore` 订阅**，不把 token 放进 `useState`。

- [ ] **Step 2: 写 `hooks/useEventSource.ts`**

封装 `new EventSource(`/api/run/${jobId}/stream?sinceSeq=${lastSeq}`)`，监听 `status`/`snapshot`/`log`/`token`/`done` 五类事件（与 `app.js` 的 `connectStream` 一致）；断线指数退避重连（1s→2s→4s，上限 10s），30s 无事件切到轮询兜底（复刻 `startFallbackPoll`）。

- [ ] **Step 3: 写 Markdown 渲染**

`react-markdown` + `remark-gfm`；**不允许** `rehype-raw`（旧实现先转义再渲染，保留这个安全边界）。代码块用 `<pre><code>`，行内代码 `<code>`，与旧产物标签结构一致（样式表按这两个标签写）。

- [ ] **Step 4: 写 `MessageList`/`MessageItem`/`EventLine`**

复刻 `app.js` 的 `messageHtml()`、`eventLine()` 产物结构：`.msg` 容器 + 角色类 + 时间戳 + 正文。事件行保持 `.event` + 图标 + 文本的单行结构。

- [ ] **Step 5: 写 `HitlHost`/`ApprovalHost`**

复刻 `renderHitl()` 与 `renderApprovals()`：选项按钮用 `data-hitl-*` / `data-approval` 属性（对照脚本要用）。提交路径已确认：

- HITL：`POST /api/run/:jobId/hitl`，body `{ answer, actor: 'HR(web)' }`
- 审批：`POST /api/run/:jobId/approvals/:approvalId`，body `{ decision }`；响应里 `resumeRequired` 为真时再 `POST /api/run/:jobId/resume`

- [ ] **Step 6: 写 `Composer`（会话内输入框）**

`contenteditable` div，`id="reply-input"`；Tab/Shift+Tab、Enter 发送、Shift+Enter 换行；粘贴走 `onPaste` 取 `text/plain`（复刻 `app.js` 的 paste 处理）；附件 `#chat-attach-btn` + `#chat-file-input`；发送后清空并聚焦。

- [ ] **Step 7: 接 SSE 并对照**

```powershell
# 旧端口起服务并在旧 UI 里跑一个会话，让它有历史
cd frontend; node scripts/shoot.mjs --compare
```
Expected: `04-streaming`、`05-hitl`、`06-approval` 三态 `diff < 0.5%`。

- [ ] **Step 8: 手动验收（Review Focus 2、3）**

- 流式输出时输入框不被顶走；滚到底后自动跟随；向上滚动后不被强制拉回
- 用中文输入法打一句话（组字过程中不能丢字）再发送
- 断网 10 秒后恢复：能自动重连或切到轮询并继续出字

- [ ] **Step 9: 提交**

```powershell
git add frontend
git commit -m "feat(frontend): chat stream with SSE, markdown, hitl and approvals"
```

---

### Task F3: B2 —— 抽屉六页 + 终稿报告 + 文件预览

**Files:**
- Create: `frontend/src/api/{candidates,cost,compliance,memory,workflow,preview}.ts`, `frontend/src/features/drawer/{Drawer,Tabs,Candidates,CandidateDetail,Compliance,Cost,MemoryTab,AgentsTab,WorkflowTab}.tsx`, `frontend/src/features/report/FinalReport.tsx`, `frontend/src/features/preview/{PreviewPane,PdfPages}.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `api<T>()`、`useUiStore.drawerTab`
- Produces: `export function Drawer(): JSX.Element`（`id="drawer"`、`#drawer-tabs` 六个 `button.tab[data-drawer-tab]`、`#drawer-body`）

- [ ] **Step 1: 写抽屉骨架与六个 tab 内容**

tab 顺序与文案必须与 `index.html` 一致：候选人 / 合规 / 成本 / 任务记忆 / Agent / 工作流。每页的行、表、徽标沿用 `app.js` 对应 `render*()` 的产物结构（`renderCandidates`、`renderCompliance`、`renderCost`、`loadDrawerInspector` 的 workflow 分支）。

- [ ] **Step 2: 写候选人详情与「返回」**

复刻 `renderCandidateDetail()`：`#candidate-back` 返回列表，字段与徽标顺序一致。

- [ ] **Step 3: 写终稿报告**

复刻 `finalReportHtml()`：标题、结论徽标、评分表格、证据列表；用 `react-markdown` 渲染正文段落（与聊天里的渲染同一套组件）。

- [ ] **Step 4: 写预览面板与 PDF 分页**

`#preview-pane` + `#preview-resizer`；PDF 走既有 `/vendor/pdfjs/*` 资源，用 `pdfjs-dist` 的 `getDocument` 逐页渲染到 canvas。路径已确认：

- 原文件：`GET /api/run/:jobId/files/:name`（用作 `#file-preview-download` 的 `href`）
- 预览：`GET /api/run/:jobId/files/:name/preview?t=<时间戳>`，返回服务端转好的 PDF（DOCX 由服务端转换）
- 报告：`GET /api/run/:jobId/report`

页码、下载链接、关闭按钮沿用原 id。

- [ ] **Step 5: 对照**

```powershell
cd frontend; node scripts/shoot.mjs --compare
```
Expected: `07-drawer-candidates`、`08-candidate-detail`、`09-drawer-cost-compliance`、`12-preview` 四态 `diff < 0.5%`。

- [ ] **Step 6: 手动验收**

抽屉宽度拖拽后刷新保持；PDF 分页可滚动；候选人详情返回不丢列表滚动位置。

- [ ] **Step 7: 提交**

```powershell
git add frontend
git commit -m "feat(frontend): drawer pages, final report and file preview"
```

---

### Task F4: B3 —— 设置四件套

**Files:**
- Create: `frontend/src/api/{providers,plugins,agents,memory-settings}.ts`, `frontend/src/features/settings/{SettingsModal,ModelsTab,PluginsTab,AgentsTab,MemoryTab,ProviderEditor,PluginEditor}.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useUiStore`
- Produces: `export function SettingsModal(): JSX.Element`（`id="settings-modal"`，`#settings-nav` 四个 `button[data-settings-tab]`）

- [ ] **Step 1: 写设置外壳与导航**

复刻 `.settings-shell` / `.settings-nav` / `.settings-content` 三段结构与 `#settings-close`。tab 切换只改 class `active`/`hidden`，不卸载已填表单（旧实现如此，卸载会丢输入）。

- [ ] **Step 2: 模型 tab（含 provider 编辑器）**

复刻 `renderProviders()`、`openProviderEditor()`、`renderModelDirectory()`：字段顺序、默认值、"测试"按钮与状态文案逐字一致。API：`/api/providers` 的增删改测。

- [ ] **Step 3: 插件 tab（含安装与编辑器）**

复刻 `renderPlugins()`、`openPluginEditor()`、`togglePlugin()`；保留 `window` 上的 `bole-plugin-add` / `bole-plugin-manual` 事件契约（`agent-ui.js` 等仍在用同名事件，若已迁移则同步替换）。

- [ ] **Step 4: Agent 团队 tab 与任务记忆 tab**

这两块原本在 `agent-ui.js` / `memory-ui.js` 里（共 387 行）。逐块搬迁，保留其内部 `data-*` 属性。

- [ ] **Step 5: 对照**

```powershell
cd frontend; node scripts/shoot.mjs --compare
```
Expected: `10-settings-models`、`10-settings-plugins` 两态 `diff < 0.5%`。

- [ ] **Step 6: 手动验收（Review Focus 5）**

Esc 关闭设置、焦点回到「设置」按钮；打开 provider 编辑器填一半再切 tab 回来，内容还在。

- [ ] **Step 7: 提交**

```powershell
git add frontend
git commit -m "feat(frontend): settings modal with models, plugins, agents, memory"
```

---

### Task F5: B4 —— 邮箱与知识库

**Files:**
- Create: `frontend/src/api/{mail,knowledge}.ts`, `frontend/src/features/mailbox/{MailboxModal,AdapterList,Authorization}.tsx`, `frontend/src/features/knowledge/{KnowledgeModal,BaseList,DocList,Stats}.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `api<T>()`
- Produces: `export function MailboxModal(): JSX.Element`（`id="mailbox-modal"`）、`export function KnowledgeModal(): JSX.Element`（`id="knowledge-modal"`）

- [ ] **Step 1: 写邮箱弹窗**

复刻 `#mailbox-modal` 的卡片结构、适配器列表、授权轮询状态机（`pollMailAuthorization` 的 2s 间隔与超时）、`#mail-auth` 按钮。

- [ ] **Step 2: 写知识库弹窗**

复刻 `#knowledge-modal` 的三栏（库列表 / 文档列表 / 设置与统计）、上传、嵌入模型选择、`#knowledge-status` 状态行。

- [ ] **Step 3: 对照**

```powershell
cd frontend; node scripts/shoot.mjs --compare
```
Expected: `11-mailbox`、`11-knowledge`、`11-help` 三态 `diff < 0.5%`。

- [ ] **Step 4: 提交**

```powershell
git add frontend
git commit -m "feat(frontend): mailbox and knowledge modals"
```

---

### Task F6: B5 —— 收口：切换静态产物、删旧代码

**Files:**
- Modify: `src/web/server.ts`（`staticDir()` 认 `BOLE_WEB_DIR`；`STATIC_FILES` 收口到生产产物）, `package.json`（加 `web:build` 脚本）
- Delete: `src/web/public/{app,agent-ui,memory-ui,skill-ui}.js`, `src/web/public/index.html`
- Test: `tests/integration/static-root.test.ts`（新建）

**Interfaces:**
- Consumes: `frontend/dist`（Vite 产物）
- Produces: 服务端在未设 `BOLE_WEB_DIR` 时从 `frontend/dist` 提供页面；设了则用该目录

- [ ] **Step 1: 写失败测试 `tests/integration/static-root.test.ts`**

用 `mkdtemp` 造一个目录，写入 `<h1>custom-root</h1>` 作为 `index.html`，`process.env.BOLE_WEB_DIR` 指向它，`startWebServer({port:0})`，`GET /` 断言 body 含 `custom-root`。`finally` 里恢复环境变量。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/integration/static-root.test.ts`
Expected: FAIL —— 返回的是仓库自带的旧 `index.html`

- [ ] **Step 3: 改造 `src/web/server.ts`**

把模块级 `const PUBLIC_DIR` 换成函数（**必须是函数**：`pnpm test` 单进程运行，`server.ts` 只加载一次，常量会固化第一次读到的值）：

```ts
function staticDir(): string {
  const override = process.env.BOLE_WEB_DIR?.trim();
  return override ? path.resolve(override) : path.join(import.meta.dirname, 'public');
}
```
默认值改为 `path.join(import.meta.dirname, '..', '..', 'frontend', 'dist')`（`src/web` 上两级 + `frontend/dist`），并把 `STATIC_FILES` 的条目改为 `/assets/*` 这类 Vite 产物路径 + `/`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/integration/static-root.test.ts`
Expected: 1 passed

- [ ] **Step 5: 删旧静态资源并做一次端到端验证**

```powershell
cd D:\agent\bole\frontend; pnpm build
cd D:\agent\bole; pnpm web
```
打开 `http://127.0.0.1:8787/`：应当是 React 版页面，且能跑一个完整会话（新建 → 流式 → 抽屉 → 报告）。

- [ ] **Step 6: 全量校验**

Run: `pnpm check; cd frontend; pnpm typecheck; pnpm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(web): serve react bundle and remove legacy vanilla frontend"
```

---

## 完成标准

- `frontend/dist` 是唯一的前端产物；`src/web/public/*.js` 归零
- `node scripts/shoot.mjs --compare` 的 12 个状态全部 `diff < 0.5%`，并把结果贴给业务方确认
- `pnpm check` 与前端 `typecheck`/`test` 全绿
- 旧版页面可随时通过 `git stash`/上一个 tag 复现，用于事后比对
