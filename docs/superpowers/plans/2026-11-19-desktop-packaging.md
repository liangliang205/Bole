# 伯乐 Desktop 壳（M0–M2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有的本地 Node 服务打包成 Windows 上双击可用的演示版（`BoLe-Setup-0.1.0.exe`），并提供数据目录隔离、端口稳定、优雅停服、失败可诊断四件事。

**Architecture:** Electron 44 主进程用 `ELECTRON_RUN_AS_NODE=1` 把同一个 `electron.exe` 当成 Node 来跑 `server/src/cli/index.ts web`，服务端源码与 `config/`、生产依赖一起作为 `extraResources` 原样发布（不做编译/打包），窗口 `loadURL` 到 `http://127.0.0.1:<port>/`。主进程从服务端 stdout 抓真实端口、轮询 `/readyz`、退出时走新增的 token 校验 `POST /api/shutdown` 触发既有 drain 逻辑。

**Tech Stack:** Electron 44.7.0、electron-builder 26.x、esbuild、Node 24.11.1（本机，用于脚本与测试）、node:test。

**Spec:** `docs/superpowers/specs/2026-11-19-desktop-packaging-design.md`

> 本计划只覆盖打包壳（spec 的 M0–M2）。前端 React + TS 迁移（M3–M7）是另一个独立子系统，等安装包交付后单独立计划。

## Global Constraints

- 只做 **Windows x64**；`electron` 固定 `44.7.0`（与同机 DSH 桌面版一致），`electron-builder` `^26.17.0`。
- **不签名、不做自动更新、不带 sourcemap**。
- 数据目录固定 `%APPDATA%\bole`（`data/`、`runs/`、`logs/`）；`config/` 只读随安装包发布，不复制到用户目录。
- 不改既有 CLI / Docker 行为：未设置新环境变量时，服务端行为必须与现在逐字节一致。
- 所有校验必须通过：`pnpm typecheck`、`pnpm lint`、`pnpm test`（合起来就是 `pnpm check`）。
- 源码只能含**可擦除 TS 语法**：禁 `enum`、`namespace`、构造函数参数属性；`import` 一律带 `.ts` 扩展名；纯类型导入必须写 `type`。
- 测试用 `node:test`；`pnpm test` 以 `--test-isolation=none` 单进程运行全部用例，**不要在测试模块顶层计算环境相关的常量**（模块只加载一次）。
- 面向用户的文案用中文；日志与控制台输出沿用现有 `BoLe Web 已启动:` 格式。
- 提交前必须先配好仓库级 git 身份（Task 1 Step 1）。

## Review Focus

1. **端口被占用导致 origin 变化**：本地偏好（主题、侧栏/正文/抽屉宽度、邮箱偏好、默认评分标准、默认团队）都存 `localStorage`，按 origin 分区；换端口=全部静默重置。期望：优先复用上次端口，其次 8787，再次扫描——`desktop/tests/port.test.ts` 固定这个顺序。
2. **退出时仍有运行中的任务**：期望等 `drainWebServer` 落完检查点再退，超时才强杀。`tests/integration/shutdown.test.ts` 断言 drain 完成后才回调退出钩子。
3. **首次启动空 `%APPDATA%`**：期望装完就能进页面、`bootstrap` 自建默认 registry/评分标准。Task 8 的冒烟测试用一次性空数据目录，Task 9 的验收清单在真机空目录走一遍。
4. **剪枝后 Office→PDF 失效**：期望仍走原生 `dsoffice`，不是被删掉的 wasm，也不是直接抛错。Task 8 冒烟必须真实转一份 docx。
5. **安装路径含空格或中文**（`C:\Program Files\伯乐` 或带空格的用户目录）：期望 spawn 参数、`cwd`、PDF.js 目录、配置读取都正常。Task 7 手动验收里用带空格的路径跑一次，Task 9 装到 `C:\Program Files\BoLe Test\` 再开一次。

---

### Task 1: desktop 子包骨架 + M0 环境验证

**Files:**
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/scripts/verify-env.mjs`, `desktop/.gitignore`
- Modify: `eslint.config.js:16-23`

**Interfaces:**
- Consumes: 无
- Produces: `desktop/node_modules/electron` 可用；`desktop/scripts/verify-env.mjs` 可重复执行，退出码 0 表示三项环境能力齐备

- [ ] **Step 1: 配好仓库级 git 身份**（仓库当前没有 `user.name`/`user.email`，不配则任何 commit 失败）

```powershell
cd D:\agent\bole
git config --local user.name "liangliang205"
git config --local user.email "1066566849@qq.com"
```

- [ ] **Step 2: 写 `desktop/package.json`**

```json
{
  "name": "bole-desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "out/main.cjs",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test tests/*.test.ts",
    "verify:env": "node scripts/verify-env.mjs",
    "dev": "node build.mjs --dev"
  },
  "devDependencies": {
    "electron": "44.7.0",
    "electron-builder": "^26.17.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.3",
    "@types/node": "^24.10.0"
  }
}
```

- [ ] **Step 3: 写 `desktop/tsconfig.json`**（单独一份，不进根 tsconfig）

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.mjs", "tests/**/*.ts"]
}
```

- [ ] **Step 4: 让根 ESLint 跳过 `desktop/`**（根配置用 `projectService`，缺 tsconfig 覆盖会直接报错）

在 `eslint.config.js` 的 `ignores` 数组里追加两行：`'desktop/**'`、`'frontend/**'`。

- [ ] **Step 5: 安装依赖**

Run: `cd desktop; pnpm install`
Expected: 成功；`desktop/node_modules/electron/dist/electron.exe` 存在。

- [ ] **Step 6: 写 `desktop/scripts/verify-env.mjs`**——三项能力，任一失败即非零退出

内容要求（用 `node:child_process.spawnSync` 调本包 electron，`env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`）：
1. `electron -e "console.log(process.versions.node)"` → 打印 Node 版本，必须 ≥ 24。
2. `electron -e "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); db.exec('create table t(a)'); console.log('sqlite ok')"` → 输出含 `sqlite ok`。
3. 临时目录写一个 `probe.ts`：`const x: number = 1; console.log('ts ok', x);`，用 `electron <probe.ts>` 运行 → 输出含 `ts ok 1`。
4. `electron -e "const p=require('node-pty'); const t=p.spawn(process.env.COMSPEC||'cmd.exe',['/c','echo ptyok'],{cols:80,rows:24}); t.onData(d=>{if(d.includes('ptyok')){console.log('pty ok');process.exit(0)}}); setTimeout(()=>{console.log('pty timeout');process.exit(3)},8000)"` → 输出含 `pty ok`。

每项打印 `PASS <名称>` 或 `FAIL <名称>: <stderr 前 400 字>`，最后打印汇总并以 0/1 退出。

- [ ] **Step 7: 跑验证**

Run: `cd desktop; node scripts/verify-env.mjs`
Expected: 四行 `PASS`，退出码 0。

**若任一 FAIL：停止本计划**，回到 spec §10 的 R1 处置（`tsc` 构建或 sidecar `node.exe`），先更新设计再继续。

- [ ] **Step 8: 写 `desktop/.gitignore`**：`node_modules/`、`out/`、`staging/`

- [ ] **Step 9: 提交**

```powershell
git add desktop eslint.config.js
git commit -m "feat(desktop): scaffold electron package and env verification"
```

---

### Task 2: `projectRoot()` 支持 `BOLE_ROOT`

**Files:**
- Modify: `src/util/fsx.ts:74-77`
- Test: `tests/unit/paths.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `projectRoot(): string` —— 设置了非空 `BOLE_ROOT` 时返回 `path.resolve(BOLE_ROOT)`，否则返回仓库根（`src/util` 上两级）

- [ ] **Step 1: 写失败测试 `tests/unit/paths.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../../src/util/fsx.ts';

test('BOLE_ROOT 覆盖项目根', () => {
  const saved = process.env.BOLE_ROOT;
  process.env.BOLE_ROOT = 'D:\\tmp\\bole-root';
  try {
    assert.equal(projectRoot(), path.resolve('D:\\tmp\\bole-root'));
  } finally {
    if (saved === undefined) delete process.env.BOLE_ROOT; else process.env.BOLE_ROOT = saved;
  }
});

test('未设置 BOLE_ROOT 时回落到包含 bole 包描述文件的仓库根', () => {
  const saved = process.env.BOLE_ROOT;
  delete process.env.BOLE_ROOT;
  try {
    const root = projectRoot();
    assert.ok(existsSync(path.join(root, 'package.json')));
    assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'bole');
  } finally {
    if (saved !== undefined) process.env.BOLE_ROOT = saved;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/paths.test.ts`
Expected: 第一个用例 FAIL（`BOLE_ROOT` 被忽略）

- [ ] **Step 3: 改 `src/util/fsx.ts` 的 `projectRoot`**

```ts
export function projectRoot(): string {
  const override = process.env.BOLE_ROOT?.trim();
  if (override) return path.resolve(override);
  return path.resolve(import.meta.dirname, '..', '..');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/paths.test.ts`
Expected: 2 passed

- [ ] **Step 5: 提交**

```powershell
git add src/util/fsx.ts tests/unit/paths.test.ts
git commit -m "feat(paths): honor BOLE_ROOT override in projectRoot"
```

---

### Task 3: 前端静态目录支持 `BOLE_WEB_DIR`

> **执行本计划时跳过本任务**：它已并入前端计划的前端收口任务（`plans/2026-11-19-frontend-react-migration.md` 的 F6），因为顺序改成前端先行。保留在此仅为记录设计意图。

**Files:**
- Modify: `src/web/server.ts:190`（`PUBLIC_DIR` 常量）与 `:521`（唯一使用处）
- Test: `tests/integration/static-root.test.ts`（新建）

**Interfaces:**
- Consumes: `startWebServer(options)`（既有）
- Produces: `staticDir(): string` —— 每次请求时读 `process.env.BOLE_WEB_DIR`，非空则 `path.resolve` 之，否则 `path.join(import.meta.dirname, 'public')`

> 必须是函数而不是模块级常量：`pnpm test` 单进程运行，`server.ts` 只会加载一次，常量会把第一次读到的值固化死。

- [ ] **Step 1: 写失败测试 `tests/integration/static-root.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../../src/web/server.ts';
import { setupTempEnv } from '../helpers/env.ts';

test('BOLE_WEB_DIR 覆盖静态资源目录', async () => {
  const env = await setupTempEnv();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-web-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>custom-root</h1>', 'utf8');
  const saved = process.env.BOLE_WEB_DIR;
  process.env.BOLE_WEB_DIR = dir;
  const server = await startWebServer({ port: 0 });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /custom-root/);
  } finally {
    if (saved === undefined) delete process.env.BOLE_WEB_DIR; else process.env.BOLE_WEB_DIR = saved;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await env.restore();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/integration/static-root.test.ts`
Expected: FAIL —— 返回的是仓库里的 `index.html`，不匹配 `custom-root`

- [ ] **Step 3: 改造 `src/web/server.ts`**

把第 190 行常量换成函数，并把第 521 行改成调用它：

```ts
function staticDir(): string {
  const override = process.env.BOLE_WEB_DIR?.trim();
  return override ? path.resolve(override) : path.join(import.meta.dirname, 'public');
}
```
```ts
const full = path.join(staticDir(), staticFile.file);
```

`PDFJS_DIR` 保持不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/integration/static-root.test.ts`
Expected: 1 passed

- [ ] **Step 5: 提交**

```powershell
git add src/web/server.ts tests/integration/static-root.test.ts
git commit -m "feat(web): allow overriding static asset dir via BOLE_WEB_DIR"
```

---

### Task 4: `POST /api/shutdown`（token 校验 + 触发 drain）

**Files:**
- Modify: `src/web/server.ts`（`WebServerOptions` 接口；路由；把 `draining` 与 `server` 传进闭包）
- Test: `tests/integration/shutdown.test.ts`（新建）

**Interfaces:**
- Consumes: `drainWebServer(server, timeoutMs)`（既有）
- Produces:
  - `interface WebServerOptions { host?: string; port?: number; onShutdown?: () => void | Promise<void> }`
  - 路由 `POST /api/shutdown`：未设 `BOLE_SHUTDOWN_TOKEN` → 404 `{ok:false,error:'not found'}`；请求头 `x-bole-token` 不等于该 token → 403 `{ok:false,error:'forbidden'}`；匹配 → 先回 202 `{ok:true}`，再 `await drainWebServer(server, 15_000)`，随后 `await options.onShutdown?.()`

- [ ] **Step 1: 写失败测试 `tests/integration/shutdown.test.ts`**

三个用例，都走 `setupTempEnv()`：

```ts
test('未设置 token 时 /api/shutdown 不存在', ...)   // POST → 404
test('token 不匹配时拒绝', ...)                      // 设置 BOLE_SHUTDOWN_TOKEN='t1'，带 x-bole-token: 'wrong' → 403
test('token 匹配时先回应再排空并回调', async () => {
  process.env.BOLE_SHUTDOWN_TOKEN = 't1';
  let called = false;
  let listeningAtHook: boolean | null = null;
  const server = await startWebServer({ port: 0, onShutdown: () => { listeningAtHook = server.listening; called = true; } });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const res = await fetch(`http://127.0.0.1:${address.port}/api/shutdown`, {
    method: 'POST', headers: { 'x-bole-token': 't1' },
  });
  assert.equal(res.status, 202);
  await waitFor(() => called, 3000);
  assert.equal(listeningAtHook, false, '退出钩子必须在 drain 完成之后才被调用');
  assert.equal(server.listening, false);
});
```

`waitFor` 用轮询（20ms 一次，超时抛错），写在该测试文件内。所有用例在 `finally` 里恢复 `BOLE_SHUTDOWN_TOKEN` 并 `server.close()`（若仍在监听）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/integration/shutdown.test.ts`
Expected: 三个用例都 FAIL（路由返回 404/405 之外的默认分支行为）

- [ ] **Step 3: 实现路由**

在 `handle` 开头、`/api/reset` 同级的 `if` 链里加分支（必须在通用 404 之前）：

```ts
if (method === 'POST' && pathname === '/api/shutdown') {
  const token = process.env.BOLE_SHUTDOWN_TOKEN?.trim();
  if (!token) { json(res, 404, { ok: false, error: 'not found' }); return; }
  if (req.headers['x-bole-token'] !== token) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
  draining = true;
  json(res, 202, { ok: true });
  setTimeout(() => { void (async () => {
    try { await drainWebServer(server, 15_000); } finally { await options.onShutdown?.(); }
  })(); }, 0);
  return;
}
```

`WebServerOptions` 加 `onShutdown?: () => void | Promise<void>`；注意 `drainWebServer` 只能调用一次（第二次会因为没有 handler 而走 `server.close` 分支），这里靠 `draining` 标记防止重复触发：分支入口加 `if (draining) { json(res, 202, { ok: true }); return; }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/integration/shutdown.test.ts`
Expected: 3 passed

- [ ] **Step 5: 跑全量回归**

Run: `pnpm test`
Expected: 全绿（`health.test.ts` 里 drain 行为不变）

- [ ] **Step 6: 提交**

```powershell
git add src/web/server.ts tests/integration/shutdown.test.ts
git commit -m "feat(web): add token-gated POST /api/shutdown that drains before exit"
```

---

### Task 5: 用本地实现替换 `@deepseek-ai/dsh-tool-workspace-dependencies`

**Files:**
- Create: `src/tools/workspace-deps.ts`
- Modify: `src/tools/tools-call.ts`（删掉第 16-23 行的外部导入、`findPayloadSource`、`bundledPython`；改第 126 与 235-236 行）
- Modify: `package.json`（移除 `@deepseek-ai/dsh-tool-workspace-dependencies`）、`pnpm-lock.yaml`
- Test: `tests/unit/workspace-deps.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces（全部从 `src/tools/workspace-deps.ts` 导出）：
  ```ts
  export interface RuntimeManifest {
    python?: string; node?: string; pnpm?: string;
    pythonPackages?: Record<string, string>;
    pythonDistributions?: Record<string, string>;
  }
  export interface WorkspaceDependencyPaths {
    python: string | null; node: string | null; pnpm: string | null;
    pythonPackages: Record<string, string>;
    nodePackages: Record<string, string> | null;
    pythonDistributions: Record<string, string>;
  }
  export async function findPayloadRoot(dataDir: string): Promise<string | null>
  export async function readManifest(root: string): Promise<RuntimeManifest | null>
  export function resolveWorkspaceDependencies(root: string, manifest: RuntimeManifest): WorkspaceDependencyPaths
  export async function bundledPython(dataDir: string): Promise<string | null>
  ```

- [ ] **Step 1: 写失败测试 `tests/unit/workspace-deps.test.ts`**

用 `mkdtemp` 造一个与 DSH payload 同构的目录（已对真机 `G:\dsh\resources\runtime\primary-runtime` 核对过）：

```
<payload>/runtime.json                                   {"python":"3.12.14","node":"24.21.0","pythonPackages":{"numpy":"2.3.5"}}
<payload>/dependencies/python/python.exe                  （win32 下存在即可）
<payload>/dependencies/node/bin/node.exe
<payload>/dependencies/pnpm/bin/pnpm.cmd
```
非 win32 布局是 `dependencies/python/bin/python3`、`dependencies/node/bin/node`、`dependencies/pnpm/bin/pnpm`。

用例：
1. `findPayloadRoot(dataDir)` 在 `<dataDir>/workspace-payload` 存在 `runtime.json` 时返回该目录，否则返回 `null`。
2. `readManifest` 读出 `pythonPackages.numpy === '2.3.5'`。
3. `resolveWorkspaceDependencies(root, manifest)` 在 win32 下返回 `python` 以 `python.exe` 结尾、`node` 以 `node.exe` 结尾、`pnpm` 以 `pnpm.cmd` 结尾；`pythonDistributions` 在 manifest 没有 `pythonDistributions` 时等于 `pythonPackages`。
4. 目录里缺 `python.exe` 时 `python` 为 `null`（不抛错）。
5. `bundledPython(dataDir)`：payload 缺失时返回 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/workspace-deps.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/tools/workspace-deps.ts`**

要点：`findPayloadRoot` 的候选与现实现一致（`process.env.BOLE_DSH_PAYLOAD`，其次 `<dataDir>/workspace-payload`），判据是目录里存在 `runtime.json`；路径用 `existsSync` 探测，缺失返回 `null` 而不是抛错；`readManifest` 解析失败返回 `null`。

- [ ] **Step 4: 改 `src/tools/tools-call.ts`**

- 删掉外部包导入与本地 `findPayloadSource`/`bundledPython`，改成 `import { bundledPython, findPayloadRoot, readManifest, resolveWorkspaceDependencies } from './workspace-deps.ts';`
- `loadWorkspaceDependencies.run`：`const root = await findPayloadRoot(ctx.dataDir);` 为 `null` 时返回**现有那段中文降级提示原文**（`未找到 DSH workspace payload…`）；否则 `const manifest = (await readManifest(root)) ?? {};` 并把 `resolveWorkspaceDependencies(root, manifest)` 的字段按现有 `data` 结构返回。
- `pythonExec`：`const interpreter = (await bundledPython(ctx.dataDir)) ?? (process.platform === 'win32' ? 'python' : 'python3');`

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/unit/workspace-deps.test.ts; node --test tests/unit/tools-call.test.ts`
Expected: 全绿（既有 tools-call 测试不能被破坏）

- [ ] **Step 6: 移除依赖并更新锁文件**

```powershell
cd D:\agent\bole
pnpm remove @deepseek-ai/dsh-tool-workspace-dependencies
```
Expected: `package.json` 里该依赖消失，`pnpm-lock.yaml` 更新，安装成功。

- [ ] **Step 7: 确认体积收益并提交**

Run: `pnpm typecheck; pnpm lint; pnpm test`
Expected: 全绿

```powershell
git add src/tools/workspace-deps.ts src/tools/tools-call.ts tests/unit/workspace-deps.test.ts package.json pnpm-lock.yaml
git commit -m "refactor(tools): replace dsh workspace-deps package with local implementation"
```

---

### Task 6: 桌面侧纯函数（端口选择、启动行解析、日志文件命名）

**Files:**
- Create: `desktop/src/port.ts`, `desktop/src/launch-url.ts`, `desktop/src/log-file.ts`
- Test: `desktop/tests/port.test.ts`, `desktop/tests/launch-url.test.ts`, `desktop/tests/log-file.test.ts`

**Interfaces:**
- Consumes: 无（三个模块都不得 import `electron`）
- Produces:
  ```ts
  // port.ts
  export interface PortChoice { port: number; reused: boolean }
  export async function choosePort(input: {
    preferred?: number | null; defaultPort?: number; scanFrom?: number; scanTo?: number;
    isFree: (port: number) => Promise<boolean>;
  }): Promise<PortChoice>
  // launch-url.ts
  export function parseServerUrl(line: string): string | null
  // log-file.ts
  export function formatLogName(now: Date): string          // 'server-YYYYMMDD.log'
  export function pickLogPath(dir: string, currentSize: number, now: Date): string  // >5MB 时换 ...-2.log
  ```

- [ ] **Step 1: 写三个失败测试**

`port.test.ts` 关键断言（默认 `defaultPort=8787`、`scanFrom=8788`、`scanTo=8900`）：
- `preferred=9001` 且 `isFree(9001)` 为真 → `{port:9001, reused:true}`
- `preferred=9001` 不可用、8787 可用 → `{port:8787, reused:false}`
- `preferred` 空、8787 与 8788 都不可用、8789 可用 → `{port:8789, reused:false}`
- 8900 全占 → 抛错 `所有候选端口都被占用`

`launch-url.test.ts`：
- `parseServerUrl('BoLe Web 已启动: http://127.0.0.1:8787')` → `'http://127.0.0.1:8787'`
- 前后带 ANSI 颜色码也能解析（行内含 `\u001b[32m`）
- `parseServerUrl('对话式控制台：上传简历 → 开始筛选')` → `null`

`log-file.test.ts`：
- `formatLogName(new Date('2026-11-19T01:02:03Z'))` → `'server-20261119.log'`（用本地时区日期；测试里用 `new Date(2026, 10, 19)` 构造避免时区歧义）
- `pickLogPath('C:\\logs', 5 * 1024 * 1024, d)` → `C:\logs\server-*-2.log`
- `pickLogPath('C:\\logs', 1024, d)` → `C:\logs\server-*.log`

- [ ] **Step 2: 跑测试确认失败**

Run: `cd desktop; node --test tests/*.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个模块**

`choosePort` 按 `preferred → defaultPort → scanFrom..scanTo` 顺序返回第一个 `isFree` 为真的端口；一次都不成立则 `throw new Error('所有候选端口都被占用')`。`isFree` 由调用方注入（main 里用 `net.createServer().listen(port).on('error')` 实现），便于测试。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd desktop; node --test tests/*.test.ts; pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```powershell
git add desktop/src desktop/tests
git commit -m "feat(desktop): port selection, launch line parsing, log naming"
```

---

### Task 7: 主进程、preload、窗口与生命周期（能起窗口的完整壳）

**Files:**
- Create: `desktop/src/server-process.ts`, `desktop/src/main.ts`, `desktop/src/preload.ts`, `desktop/src/splash.html`
- Modify: `desktop/build.mjs`（本任务只加 esbuild 部分；打包部分留到 Task 9）

**Interfaces:**
- Consumes: Task 2/3/4/6 的产物（`BOLE_ROOT`、`BOLE_WEB_DIR`、`/api/shutdown`、`choosePort`、`parseServerUrl`、`pickLogPath`）
- Produces:
  ```ts
  // server-process.ts
  export interface StartInput {
    serverDir: string; entry: string; dataDir: string; runsDir: string; logDir: string;
    port: number; shutdownToken: string;
  }
  export interface RunningServer { url: string; stop: (timeoutMs?: number) => Promise<void>; onExit: (cb: (code: number | null) => void) => void }
  export function startServer(input: StartInput): Promise<RunningServer>
  export function resolveServerLayout(): { serverDir: string; entry: string }   // 打包/开发两种布局
  ```

- [ ] **Step 1: 实现 `server-process.ts`**

- `startServer` 用 `spawn(process.execPath, [entry, 'web', '--port', String(port)], { cwd: serverDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BOLE_DATA_DIR, BOLE_RUNS, BOLE_SHUTDOWN_TOKEN, BOLE_OCR_MODE: process.env.BOLE_OCR_MODE ?? 'deepseek', ...(existsSync(path.join(serverDir,'ocr')) ? { BOLE_OCR_DIR: path.join(serverDir,'ocr') } : {}) }, stdio: ['ignore','pipe','pipe'], windowsHide: true })`
- stdout 逐行解析（`readline.createInterface`）：命中 `parseServerUrl` 就记下 URL 并 resolve；同时把每一行都追加到当前日志文件（用 `pickLogPath`，超 5MB 换 `-2`，保留 3 份）
- stderr 同样落盘并保留最后 40 行在内存，供失败弹窗使用
- `stop(timeoutMs = 15_000)`：`POST ${url}/api/shutdown` 带 `x-bole-token`；等到子进程 `exit`；超时则 `child.kill()`；再超时不管
- 子进程在拿到 URL 前退出 → reject 一个带 `code` 与最后 40 行 stderr 的 Error
- `serverDir()`：`app.isPackaged ? path.join(process.resourcesPath,'server') : path.resolve(app.getAppPath(),'..')`，`entry` 均为 `path.join(serverDir,'src','cli','index.ts')`

- [ ] **Step 2: 实现 `main.ts`**

顺序必须是：`app.setName('bole')` → 单实例锁（拿不到 `app.quit()`）→ `app.whenReady()`：
1. `dataDir = path.join(app.getPath('userData'),'data')`、`runsDir = …\runs`、`logDir = …\logs`，`mkdirSync(…,{recursive:true})`
2. 端口：读 `…\port.json` 的 `lastPort` 作 `preferred`；`choosePort` 取端口；成功后把端口写回 `port.json`
3. `shutdownToken = randomBytes(24).toString('hex')`
4. 先开 360×120 无边框 splash 窗口（`loadFile(splash.html)`），再 `startServer`
5. `startServer` 成功后轮询 `GET ${url}/readyz`（300ms 一次，最多 60s，非 200 继续等），然后建主窗口 `1440×900`（min 1024×700），`loadURL(url)`，`ready-to-show` 后显示并关掉 splash
6. 任何一步失败：`dialog.showErrorBox('伯乐启动失败', 摘要 + 最后 30 行日志)` + 「打开日志目录」用 `shell.openPath(logDir)`，然后 `app.exit(1)`
7. `app.on('second-instance')` → `win.focus()`
8. 退出：`before-quit` 只处理一次（`e.preventDefault()`）→ `await running.stop()` → `app.exit(0)`

窗口安全设置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，`preload` 指向构建产物；`setWindowOpenHandler` 一律 `shell.openExternal` 并返回 `{action:'deny'}`。

- [ ] **Step 3: 实现菜单**

`Menu.buildFromTemplate`，中文：`重载`(role reload)、`开发者工具`(role toggleDevTools)、`缩放`(zoomIn/zoomOut/resetZoom)、**`清空演示数据`**、`打开数据目录`、`关于`。
`清空演示数据`：`dialog.showMessageBox`（`buttons:['取消','清空']`，`cancelId:0`）→ 选清空则 `POST ${url}/api/reset`，body `{"confirm":"RESET"}`，成功后 `app.relaunch(); app.exit(0)`。

- [ ] **Step 4: 实现 `preload.ts` 与 `splash.html`**

`contextBridge.exposeInMainWorld('boleDesktop', { openExternal, revealDataDir, version })`；`splash.html` 只放产品名 + CSS 动画点，不引外部资源。

- [ ] **Step 5: `build.mjs` 的 dev 分支**

`--dev` 时用 esbuild 打 `src/main.ts` → `out/main.cjs`、`src/preload.ts` → `out/preload.cjs`（`platform:'node'`、`format:'cjs'`、`external:['electron']`、`sourcemap:false`），然后用 `electron` 启动。

- [ ] **Step 6: 手动验收（用带空格的路径，覆盖 Review Focus 5）**

Run: `cd desktop; node build.mjs --dev`
Expected 清单：
- 窗口打开并显示现有控制台界面，URL 是 `http://127.0.0.1:<port>/`
- 关掉窗口后进程树里没有残留 `electron.exe`（任务管理器确认）
- 再启动一次：不新开服务，聚焦已有窗口
- 菜单「清空演示数据」能完成并自动重启
- 把仓库复制到 `D:\agent\bole space test\` 再跑一次，窗口仍能打开（路径含空格）

- [ ] **Step 7: 提交**

```powershell
git add desktop/src desktop/build.mjs
git commit -m "feat(desktop): electron main process, window lifecycle, menus, graceful shutdown"
```

---

### Task 8: `prepare-server.mjs`（staging + 剪枝 + 冒烟）

**Files:**
- Create: `desktop/prepare-server.mjs`, `desktop/scripts/smoke-office.mjs`
- Modify: `desktop/package.json`（加 `"prepare:server": "node prepare-server.mjs"`）

**Interfaces:**
- Consumes: 仓库根的 `src/`、`config/`、`package.json`、`pnpm-lock.yaml`
- Produces: `desktop/staging/server/`，内含 `src/`、`config/`、`ocr/`（`chi_sim` + `eng` 的 traineddata）、`node_modules/`（已剪枝），并在结束时打印解包体积与五项冒烟结果

- [ ] **Step 1: 写 `prepare-server.mjs`**

步骤：
1. 清空并重建 `desktop/staging/server`
2. 复制 `src/`、`config/`、`package.json`、`pnpm-lock.yaml`
3. 在该目录 `pnpm install --prod --frozen-lockfile`
4. 剪枝（每删一项打印 `pruned <path> (<MB>)`）：
   - `node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm*` 及对应 `node_modules/@deepseek-ai/libreoffice-kit-wasm` 符号链接
   - `node_modules/.pnpm/@deepseek-ai+libreoffice-kit-{darwin-arm64,darwin-x64,win32-arm64}*` 及链接
   - `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/{darwin-arm64,darwin-x64,win32-arm64}`
   - `node_modules/.pnpm/@tencent-qqmail+agently-cli-{darwin-*,linux-*}*` 及链接
   - `node_modules/.pnpm/@napi-rs+canvas-{darwin-*,linux-*,win32-arm64}*` 及链接
   删 `.pnpm` 目录时必须同时删 `node_modules/<pkg>` 的符号链接，否则残留悬空链接。
5. 打印 `staging/server` 的总大小（MB）与文件数

- [ ] **Step 2: 下载 OCR 兜底数据到 staging**

```powershell
cd D:\agent\bole
$env:BOLE_OCR_DIR = (Resolve-Path desktop\staging).Path + '\server\ocr'
node scripts/download-ocr.ts
```
Expected: 打印 `完成 …\chi_sim.traineddata.gz` 与 `完成 …\eng.traineddata.gz`，共约 15–40 MB。
（该脚本按 `resolvePaths().ocrDir` 落盘，因此必须用 `BOLE_OCR_DIR` 指到 staging；不下载也能出包，但演示机断网时就没有本地 OCR 兜底。）

- [ ] **Step 3: 写 `desktop/scripts/smoke-office.mjs`**

用 staging 里的 `docx` 生成一份含一段文字的 `.docx` 到临时目录，再用 `@deepseek-ai/libreoffice-kit` 的 `createConverter` 转成 PDF，断言输出文件以 `%PDF-` 开头且大于 1KB；成功打印 `PASS office`，失败打印 `FAIL office: <原因>` 并以 1 退出。

- [ ] **Step 4: 写冒烟主流程**（放在 `prepare-server.mjs` 末尾，剪枝之后）

用 `node staging/server/src/cli/index.ts web --port 18787` 起服务，`env` 里 `BOLE_DATA_DIR` 指向临时空目录、`BOLE_RUNS` 同理：
- 从 stdout 抓到 URL → `GET /readyz` 必须 200（覆盖 Review Focus 3：空数据目录可启动）
- `GET /` 返回 200 且 body 含 `<div class="app"`（静态资源齐全）
- 杀掉子进程
- 断言 `staging/server/ocr/chi_sim.traineddata.gz` 与 `eng.traineddata.gz` 存在 → `PASS ocr`
- 依次跑 `node scripts/smoke-office.mjs` 与 Task 1 的 pty 探测（复用 `verify-env.mjs` 的第 4 项）
- 五步全 PASS 才以 0 退出，否则 1（覆盖 Review Focus 4）

- [ ] **Step 5: 跑一遍**

Run: `cd desktop; node prepare-server.mjs`
Expected: 打印剪枝明细 + `PASS readyz` / `PASS static` / `PASS ocr` / `PASS office` / `PASS pty` + staging 体积（预期 350–450 MB）

- [ ] **Step 6: 提交**

```powershell
git add desktop/prepare-server.mjs desktop/scripts/smoke-office.mjs desktop/package.json
git commit -m "feat(desktop): stage and prune server bundle with smoke tests"
```

---

### Task 9: 打包安装包

**Files:**
- Create: `desktop/electron-builder.yml`
- Modify: `desktop/build.mjs`（加打包分支）、`desktop/package.json`（`"dist": "node build.mjs --dist"`）

**Interfaces:**
- Consumes: `desktop/out/*.cjs`（Task 7）、`desktop/staging/server/`（Task 8）
- Produces: `desktop/out/BoLe-Setup-0.1.0.exe`

- [ ] **Step 1: 写 `desktop/electron-builder.yml`**

```yaml
appId: com.bole.desktop
productName: BoLe
directories:
  output: out
  buildResources: build
files:
  - out/main.cjs
  - out/preload.cjs
  - package.json
extraResources:
  - from: staging/server
    to: server
asar: true
win:
  target:
    - nsis
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: always
  shortcutName: 伯乐 BoLe
  artifactName: BoLe-Setup-${version}.exe
  language: '2052'
```

- [ ] **Step 2: `build.mjs --dist`**

顺序：esbuild（main/preload）→ 若 `staging/server` 不存在则提示先跑 `node prepare-server.mjs` 并退出 1 → `npx electron-builder --win nsis --config electron-builder.yml`。

- [ ] **Step 3: 打包**

Run: `cd desktop; node build.mjs --dist`
Expected: 生成 `out/BoLe-Setup-0.1.0.exe`；打印体积；asar 内只有两个 cjs + package.json

- [ ] **Step 4: 真机验收（覆盖 Review Focus 3 与 5）**

装到 `C:\Program Files\BoLe Test\`（含空格）：
- 从开始菜单启动 → 窗口出现、能新建会话、能上传一份简历
- 「设置 → 模型」按演示准备清单填好 provider 后能跑
- 关闭应用 → 任务管理器无残留 `electron.exe`、无残留 `node` 进程
- 再启动 → 页面偏好（主题/宽度）没有丢
- 卸载后 `%APPDATA%\bole` 仍在（数据不丢）

- [ ] **Step 5: 提交**

```powershell
git add desktop/electron-builder.yml desktop/build.mjs desktop/package.json
git commit -m "feat(desktop): package NSIS installer with staged server bundle"
```

---

### Task 10: 文档

**Files:**
- Create: `docs/DESKTOP.md`
- Modify: `README.md`（在「本地与 Docker 启动」附近加一段指向 `docs/DESKTOP.md`）

**Interfaces:**
- Consumes: 全部前序产物
- Produces: 无代码接口

- [ ] **Step 1: 写 `docs/DESKTOP.md`**

必须包含：安装包怎么打（两条命令）、装完数据在哪、演示前准备清单（① 设置→模型 填 provider 与 key ② 可选：导入示例知识库 ③ 跑一次「清空演示数据」确保从零开始）、SmartScreen 提示怎么绕、日志在哪、以及"必须先在设置里配好 provider，否则 `/api/run` 会被挡"这条已知行为。

- [ ] **Step 2: README 加一行指引**

在本地启动段落后面加：`桌面版（演示用）：见 docs/DESKTOP.md`。

- [ ] **Step 3: 全量校验并提交**

Run: `pnpm check; cd desktop; pnpm typecheck; node --test tests/*.test.ts`
Expected: 全绿

```powershell
git add docs/DESKTOP.md README.md
git commit -m "docs: desktop build and demo preparation guide"
```

---

## 完成标准

- `desktop/out/BoLe-Setup-0.1.0.exe` 存在，安装后双击可用，卸载重装不丢 `%APPDATA%\bole`
- `pnpm check` 全绿，`desktop` 的两份 typecheck/测试全绿
- 退出应用后没有残留进程
- `docs/DESKTOP.md` 的演示准备清单可被没做过这个项目的人照着执行
