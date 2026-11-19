# 伯乐前端 React 迁移（F0–F6）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/web/public/` 的 3,662 行手写 DOM 迁到 React 19 + TypeScript，**视觉零漂移**——每批迁移都能拿出「旧页面 / 新页面 / 差异图」三张并排证据。

**Architecture:** `frontend/` 是独立的 Vite + React 19 + TS 应用，只通过 HTTP 与既有服务端通信（`/api/*` + SSE），开发时由 Vite dev server 代理到 `pnpm web` 的 8787。样式表 `styles.css` 原样复用；React 组件沿用原 DOM 的 `id`/`class`，因此同一套 Playwright 配方能同时驱动新旧两版，截图逐像素对比。后端只加一处改动：静态目录支持 `BOLE_WEB_DIR`。

**Tech Stack:** React 19、TypeScript 5.9、Vite 6.4、TanStack Query 5、zustand 5、react-markdown 9、Playwright（仅截图对照）。

**Spec:** `docs/superpowers/specs/2026-11-19-desktop-packaging-design.md`（第 8 节，尤其 8.5 对照与验收）

> 打包（D0–D2）另见 `plans/2026-11-19-desktop-packaging.md`，排在本计划之后执行。

## Global Constraints

- **视觉目标是"看不出变化"，但手段已放宽**：`styles.css` 以复制品 `frontend/src/styles/bole.css` 为主体，**允许等价性修正**（抵消结构变化所必需的补丁），**禁止风格调整**（间距/字号/颜色/圆角/阴影一律不动）。凡改样式，必须单独一次提交并在信息里写明"为抵消什么结构变化"。
- **零第三方组件库**（对齐 DSH 的做法）。DSH 的 `packages/client/AGENTS.md` 里是明文规则：*"with no literal colors, component library, or Tailwind"*——它的 59 个 client 包里唯一的外部依赖是 `zod`，UI 全部由 `ui-primitives` 手写（`Modal.tsx` 91 行、`Menu.tsx` 等），样式是 CSS Modules + `--dsw-*` design tokens。
  - **样式组织改为 CSS Modules**（对齐 DSH 的 `*.module.css` 方案；897 行 / 553 条规则，现有 section 注释已天然切成 12 块，成本可控）。但**规则内容不许变**：拆模块是一次纯组织重构，颜色/间距/字号/层叠语义必须逐条等价——覆盖审计脚本 + 像素对照共同作为这项重构的验收证据。
  - 全局保留三块：`styles/tokens.css`（`:root` 变量）、`styles/base.css`（reset、`html/body`、滚动条、`.hidden` 工具类）、`styles/global.css`（17 条 `#id` 规则 + 跨组件变体）。
  - `.hidden` 必须保持**全局类**：对照配方用的是 `#empty-view:not(.hidden)` 这类选择器，局部化会让配方失效。
- **自建的原语不改变 DOM 结构**，只接管行为（Esc/外点关闭/焦点/aria）。
- **浮层定位暂不引 `@floating-ui`**：旧 UI 的菜单都是 `.mode-picker` 内的 `position:absolute`，没有视口翻转需求。真要了就再引，YAGNI。
- **已有 `id` 与关键 `class` 必须保留**：可以新增 wrapper、可以换容器，但旧 id 不能消失——这是同一套 Playwright 配方能驱动新旧两版的前提。
- **旧 UI 全程保留**，直到 F6 才删；F6 之前 `pnpm web` 必须始终可用。
- 所有校验必须通过：`pnpm check`（根，后端不变）、`cd frontend; pnpm typecheck; pnpm test`。
- 源码只含可擦除 TS 语法（禁 `enum`/`namespace`/参数属性）；纯类型导入写 `type`。
- 面向用户文案用中文，与现有文案逐字一致（文案变化会在截图里被放大）。
- 每个任务结束时必须跑 `node scripts/shoot.mjs --compare`，把三图落盘并记录差异比例；**> 2% 必须给出解释**（回归就修，预期变化就写明原因），解释不通不算完成。

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
    "remark-gfm": "^4.0.0",
    "@tanstack/react-query": "^5.62.0",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.7.0",
    "playwright": "^1.49.0",
    "pixelmatch": "^6.0.0",
    "pngjs": "^7.0.0",
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

选择器**只能用 `#id`、属性与结构伪类**（如 `#job-list .job-row`、`#empty-view:not(.hidden)`），**不要用 class 选择器**——迁移后 class 会被 CSS Modules 哈希成随机名，写死 class 的配方在旧版能用、新版必然失效。`waitFor` 用 `page.waitForSelector`（`state: 'visible'`），`waitMs` 兜底等动画结束。涉及弹窗的状态用 `click: '#open-settings'` 这类现成按钮进入。

- [ ] **Step 9: 写 `scripts/shoot.mjs`**

要求：
- `--base <url> --out <dir>`：逐个状态执行 → `page.screenshot({ fullPage: true })` → `<name>.png`
- `--compare --out <dir> [--baseline <dir>]`：对每个状态同时跑旧（默认 `http://127.0.0.1:8787`）与新（默认 `http://127.0.0.1:5173`），落盘 `<name>-old.png` / `-new.png` / `-diff.png`；`--baseline` 存在时改为「基线图 vs 新图」（F7 用这个模式）
- 差异用 `pngjs` 解码 + `pixelmatch` 计算（阈值 `threshold: 0.1`、`includeAA: false`），百分比 = 差异像素数 / 总像素数
- 输出 `DIFF <name> <pct>%`；**不因为差异大小而改变退出码**（差异判定交给人），只在截图失败或页面报错时以 1 退出
- `--manual`：不截旧图，只起两版并打印 12 条 URL 清单（Playwright 装不上时的退路）

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

### Task F1: B0 —— 样式模块化、布局壳、会话列表、新建会话页

> **执行时的裁决（2026-11-19，Step 0 已按此调整）**：一次拆成 12 个 `*.module.css` 试过，做跨模块分析后发现这张表不具备模块自洽性——39 个类跨模块出现，9 条 `@media` 是全站响应式规则；哈希化会造成"一处哈希、一处字面量"的失配。改为：先做零风险组织重构（`styles/tokens.css` + `base.css` + `legacy.css`，规则一字未改，`audit-styles.mjs` 逐条校验），再按组件**增量**提取 `*.module.css`（只搬该组件独占、且不被媒体查询或其它组件引用的规则，提取后仍要过审计）。详见 `frontend/src/styles/README.md`。下文 Step 0 的原始一刀切方案作废，保留仅作记录。

**Files:**
- Create: `frontend/src/styles/{tokens.css,base.css,global.css,README.md}`, `frontend/src/**/*.module.css`（按组件）, `frontend/scripts/audit-styles.mjs`, `frontend/src/api/client.ts`, `frontend/src/api/jobs.ts`, `frontend/src/store/ui.ts`, `frontend/src/components/{Resizer,Modal,Menu}.tsx`, `frontend/src/components/useModalLayer.ts`, `frontend/src/features/sessions/{Sidebar,JobList,JobRow}.tsx`, `frontend/src/features/new/{EmptyView,Composer}.tsx`, `frontend/src/App.tsx`, `frontend/src/theme.ts`
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
  // components/Modal.tsx
  export function Modal(props: { open: boolean; onClose: () => void; className: string; labelledBy?: string; children: ReactNode }): JSX.Element | null
  // components/useModalLayer.ts
  export function useModalLayer(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void
  ```

- [ ] **Step 0: 把全局样式拆成 CSS Modules（独立一次提交，先做）**

这是纯组织重构，**不改任何一条规则的取值**。按 `styles.css` 现有 section 注释切：

| 源区段（行号） | 目标 |
|---|---|
| `:root` 变量 | `styles/tokens.css`（全局，不模块化） |
| 文件头 reset、`html/body`、滚动条、`.hidden` | `styles/base.css`（全局） |
| 17 条 `#id` 规则 + 34 处跨组件变体 | `styles/global.css`（全局） |
| `/* sidebar */`(120) | `features/sessions/Sidebar.module.css` |
| `/* main */`(199)、`/* empty view */`(230) | `features/new/EmptyView.module.css` + `App.module.css` |
| `/* chat */`(244)、`/* streaming */`(349)、`/* HITL */`(363) | `features/chat/Chat.module.css` 等 |
| `/* composer */`(372) | `features/chat/Composer.module.css` |
| `/* 导出文件卡片 */`(291) | `components/FileCard.module.css` |
| `/* 文件预览 */`(306) | `features/preview/Preview.module.css` |
| `/* drawer */`(465) | `features/drawer/Drawer.module.css` |
| `/* modal / tools */`(539) | `components/Modal.module.css` + 各弹窗模块 |
| `/* 插件 */`(739)、`/* approvals */`(763) | `features/settings/Plugins.module.css`、`features/chat/Approvals.module.css` |
| `/* buttons */`(182) | `components/Button.module.css`（`.btn` 全族） |

要求：
- `frontend/src/styles/README.md` 记录完整映射表，并逐条说明那 17 条 id 规则与 34 处跨组件选择器为什么留在全局。
- 禁止无理由 `:global`；每处 `:global` 必须在 README 里登记。
- 写 `scripts/audit-styles.mjs`：解析 `src/web/public/styles.css` 与所有 `*.module.css`，按"选择器 + 声明块归一化"做集合比对，打印未归属的源规则（应为空）与孤立的目标规则（应为空）。

Run: `cd frontend; node scripts/audit-styles.mjs`
Expected: `audit: 553 source rules, 553 mapped, 0 missing, 0 orphan`，退出码 0。

```powershell
git add frontend/src/styles frontend/scripts/audit-styles.mjs
git commit -m "refactor(frontend): split global stylesheet into css modules (no rule changes)"
```

- [ ] **Step 1: 写 `api/client.ts`**

`api<T>(path, init)` = `fetch(path, { headers: { 'content-type': 'application/json' }, ...init })`，非 2xx 抛 `ApiError`，解析 `{ ok, ...data }` 时若 `ok === false` 也抛；SSE 不走这里。

- [ ] **Step 2: 写 `store/ui.ts`（zustand）**

只放跨屏 UI 状态：`activeJobId`、`showArchived`、`theme`、`drawerTab`、`drawerOpen`、`previewFile`。**服务端数据一律走 TanStack Query，不进 zustand。**

- [ ] **Step 3: 写 `theme.ts`**

复刻 `app.js` 的 `applyTheme`：`document.documentElement.dataset.theme = 'dark' | 'light'`，键名 `bole.theme`。首帧前在 `main.tsx` 顶部同步执行一次（对应旧 `index.html` 里的内联脚本）。

- [ ] **Step 4: 写通用件：`Resizer` + 三个自建原语**

**手写，不引库**（对齐 DSH 的 `ui-primitives`）。照 DSH 的 `Modal.tsx`（91 行）的结构来写，但**容器 class 用 bole 自己的**，保证旧 CSS 生效：

`components/Resizer.tsx`：四条拖拽分栏共用。`props: { storageKey: string; defaultWidth: number; min: number; max: number; side: 'left'|'right'; onWidth(width: number): void }`。指针按下 → `setPointerCapture` → `pointermove` 计算宽度 → `pointerup` 落 `localStorage`；`dblclick` 恢复默认；键盘左右键 ±16px（原实现支持，见 `app.js` 的 `keydown` 分支）。

`components/Modal.tsx`：`props: { open, onClose, className, labelledBy?, children }`。渲染结构**必须**是旧页面的形状——`createPortal(<div className="modal">…<div className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>{children}</div></div>, document.body)`，其中 `className` 由调用方给（如 `modal-card settings-card`）。不要新增 wrapper、不要给 `.modal` 加额外的遮罩层，否则 `styles.css` 的 `.modal{display:flex;position:fixed;…}` 语义会被破坏。

`components/useModalLayer.ts`（约 40 行）：`useModalLayer(ref, open, onClose)` — Esc 关闭、打开时把焦点移进 `[data-autofocus]` 或首个可聚焦元素、关闭时焦点还给触发元素、`document.body.style.overflow = 'hidden'` 并在关闭/卸载时还原。

`components/Menu.tsx`（约 60 行）：`useAnchoredMenu` 管 `.mode-menu` 的开合——外点关闭、Esc 关闭、上下键移动、`aria-haspopup="menu"` / `aria-expanded` 同步、`role="menuitemradio"` 的 `aria-checked`。**DOM 结构保持原样**（trigger 与 `.mode-menu` 仍是同一个 `.mode-picker` 的子节点），只把 `app.js` 里手写的 `hidden` class 切换与 `document.addEventListener('click', …)` 换成 React 状态。

`components/Tooltip.tsx`：**本期不写**。旧页面用的是原生 `title` 属性，保留即可（不引入浮层定位，见 Global Constraints）。

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
cd frontend; node scripts/shoot.mjs --compare --out .shots/f1
```
Expected: `01-empty`、`02-session-list`、`03-archive`（若有）三态打印 `DIFF` 百分比；其余状态此时会因选择器超时报错，这是预期的——本批只对 F1 范围内的状态负责（把未实现的状态在 `states.mjs` 里用 `batch: 'f1'` 分组，脚本按 `--batch` 过滤）。三张差异图打开看过，> 2% 的要有解释。

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
cd frontend; node scripts/shoot.mjs --compare --out .shots/f2 --batch f2
```
Expected: `04-streaming`、`05-hitl`、`06-approval` 三态打印 `DIFF`；三张 diff 图打开确认——流式输出的行高/等宽字体最容易在这里露出破绽。

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
cd frontend; node scripts/shoot.mjs --compare --out .shots/f3 --batch f3
```
Expected: `07-drawer-candidates`、`08-candidate-detail`、`09-drawer-cost-compliance`、`12-preview` 四态打印 `DIFF` 并给出三图。

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
cd frontend; node scripts/shoot.mjs --compare --out .shots/f4 --batch f4
```
Expected: `10-settings-models`、`10-settings-plugins` 两态打印 `DIFF` 并给出三图。**注意**：自建 `Modal` 走 `createPortal` 挂到 `body`，设置弹窗从 `.app` 的子树里移出去了，层叠上下文与 `position:fixed` 的包含块都会变；若出现阴影/遮罩/宽度差异，优先在样式里做等价性修正（例如给 `.modal` 补必要的定位），而不是调整设计。

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
cd frontend; node scripts/shoot.mjs --compare --out .shots/f5 --batch f5
```
Expected: `11-mailbox`、`11-knowledge`、`11-help` 三态打印 `DIFF` 并给出三图。

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
- `node scripts/shoot.mjs --compare` 的 12 个状态全部跑通并产出三图；每一处 > 2% 的差异都有书面解释（回归已修 / 结构变化已抵消 / 预期的可接受差异）
- 业务方看过 12 组对照图并明确说"可以"
- `pnpm check` 与前端 `typecheck`/`test` 全绿
- 旧版页面可用上一个 tag 复现，用于事后比对

---

### Task F7: 阶段 B —— 视觉优化（迁移收口之后再动，范围另定）

> 本任务不写死具体改什么：这是设计与审美的活，先拿 F0–F6 的验收图集当基线，一屏一屏改。

**Files:**
- Modify: `frontend/src/styles/bole.css` 与相关组件
- Create: `frontend/.shots/baseline-a/`（把 F6 验收通过的 12 张新图存成阶段 A 基线）

**Interfaces:**
- Consumes: `shoot.mjs` 的 `--baseline` 模式
- Produces: 新的图集 `frontend/.shots/<轮次>/`，每轮一张 before/after 对照

- [ ] **Step 1: 固化阶段 A 基线**

```powershell
cd frontend
node scripts/shoot.mjs --base http://127.0.0.1:5173 --out .shots/baseline-a
```
Expected: 12 张图，作为后续所有视觉改动的对照基准。**这一套图要提交进 git**（约 2–3 MB），因为它是对"迁移完成时长什么样"的权威记录。

- [ ] **Step 2: 按屏分批改，每批一次提交 + 一组对照**

```powershell
cd frontend
node scripts/shoot.mjs --compare --baseline .shots/baseline-a --out .shots/visual-1 --batch <范围>
```
Expected: 每张 `<name>-diff.png` 里的差异**全部是有意的**；提交信息里写清"这一轮改了什么、为什么"。

- [ ] **Step 3: 想换视觉体系时**（Tailwind / shadcn / 新配色）

先只挑**一个**屏做试点，产出 before/after 两图给业务方确认；确认后再推广到其余屏。不要一次性全站换皮——那会让对照失效，等于又回到"看不出哪里变了"的状态。
