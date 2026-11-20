import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { choosePort } from './port.ts';
import { resolveServerLayout, startServer, type RunningServer } from './server-process.ts';

// 虚拟机/远程桌面里没有可用 GPU，Chromium 会直接 FATAL，先关掉硬件加速。
app.disableHardwareAcceleration();
// 远程桌面/无 GPU 环境里 Chromium 仍会尝试起 GPU 进程并崩溃，这里强制走软件渲染。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-features', 'DawnGraphiteCache,DawnWireValidation');
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
process.on('uncaughtException', (error) => {
  // 无窗口时也要留下痕迹
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'crash.log'), new Date().toISOString() + ' ' + (error?.stack ?? String(error)) + '\n');
  } catch {
    // ignore
  }
  app.exit(1);
});

app.setName('bole');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void main();
}

let mainWindow: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let running: RunningServer | null = null;
let quitting = false;

/** 启动硬超时：超时抛错，交给上层弹窗并退出，避免进程无窗口挂着拖慢整机。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function isPortFree(port: number): Promise<boolean> {  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function readLastPort(file: string): number | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { lastPort?: number };
    return typeof value.lastPort === 'number' ? value.lastPort : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await app.whenReady();

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const runsDir = path.join(userData, 'runs');
  const logDir = path.join(userData, 'logs');
  for (const dir of [dataDir, runsDir, logDir]) mkdirSync(dir, { recursive: true });

  const portFile = path.join(userData, 'port.json');
  const preferred = readLastPort(portFile);

  splash = new BrowserWindow({
    width: 360,
    height: 120,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash?.show());

  try {
    const choice = await choosePort({ preferred, isFree: isPortFree });
    writeFileSync(portFile, JSON.stringify({ lastPort: choice.port }), 'utf8');

    const layout = resolveServerLayout(app.isPackaged, __dirname);
    const started = await withTimeout(startServer({
      serverDir: layout.serverDir,
      entry: layout.entry,
      dataDir,
      runsDir,
      logDir,
      port: choice.port,
      shutdownToken: randomBytes(24).toString('hex'),
    }), 120_000, '启动后端服务');
    running = started;

    await waitForReady(started.url);
    createWindow(started.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[bole] 启动失败', message);
    dialog.showErrorBox('伯乐启动失败', message.slice(0, 2000));
    shell.openPath(logDir);
    app.exit(1);
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (quitting || !running) return;
    event.preventDefault();
    quitting = true;
    void running.stop().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => app.quit());
}

async function waitForReady(url: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/readyz`);
      if (response.status === 200) return;
    } catch {
      // 继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务端在 ${timeoutMs}ms 内没有就绪：${url}`);
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    splash?.close();
    splash = null;
    mainWindow?.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(url);

  // 冒烟模式：截一张图后退出，便于无头验证窗口确实渲染了页面。
  if (process.env.BOLE_DESKTOP_SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then(async (image) => {
          const target = process.env.BOLE_DESKTOP_SMOKE as string;
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, image.toPNG());
          quitting = true;
          app.exit(0);
        });
      }, 2500);
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => { void shell.openPath(path.join(app.getPath('userData'), 'data')); },
        },
        {
          label: '清空演示数据',
          click: () => { void resetData(); },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于伯乐', click: () => { void about(); } },
      ],
    },
  ]));
}

async function resetData(): Promise<void> {
  if (!mainWindow || !running) return;
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['取消', '清空'],
    defaultId: 0,
    cancelId: 0,
    message: '清空演示数据？',
    detail: '会删除本机的会话、简历与报告记录。此操作不可撤销。',
  });
  if (answer.response !== 1) return;
  try {
    const response = await fetch(`${running.url}/api/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET' }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    app.relaunch();
    app.exit(0);
  } catch (error) {
    dialog.showErrorBox('清空失败', error instanceof Error ? error.message : String(error));
  }
}

async function about(): Promise<void> {
  if (!mainWindow) return;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: `伯乐 Desktop ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron}\nNode ${process.versions.node}\n数据目录：${app.getPath('userData')}`,
  });
}
