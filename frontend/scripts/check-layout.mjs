import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

const before = await page.evaluate(() => {
  const app = document.getElementById('app');
  return {
    className: app?.className ?? '',
    columns: app ? getComputedStyle(app).gridTemplateColumns : '',
    mainClass: document.querySelector('.main')?.className ?? '',
    resizerDisplay: (() => { const el = document.querySelector('.content-resizer'); return el ? getComputedStyle(el).display : 'none'; })(),
  };
});
process.stdout.write(`初始：#app=${before.className} | main=${before.mainClass}\n`);
check('有空会话时 main 带 chat-active', before.mainClass.includes('chat-active'), before.mainClass);
check('chat 视图下分栏把手可见', before.resizerDisplay !== 'none', before.resizerDisplay);

// 确保任务面板是打开状态（打开时按钮是"收起"，先判断再点）
const alreadyOpen = await page.evaluate(() => !document.getElementById('drawer')?.classList.contains('hidden'));
if (!alreadyOpen) { await page.click('#panel-btn'); await page.waitForTimeout(600); }
const withDrawer = await page.evaluate(() => {
  const app = document.getElementById('app');
  const drawer = document.getElementById('drawer');
  return {
    className: app?.className ?? '',
    columns: app ? getComputedStyle(app).gridTemplateColumns.split(' ').length : 0,
    drawerVisible: drawer ? !drawer.classList.contains('hidden') : false,
    drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
  };
});
process.stdout.write(`开面板：#app=${withDrawer.className} | 网格 ${withDrawer.columns} 列\n`);
check('打开任务面板后 #app 带 drawer-open', withDrawer.className.includes('drawer-open'), withDrawer.className);
check('网格变成 4 列', withDrawer.columns === 4, String(withDrawer.columns));
check('面板实际渲染出宽度', withDrawer.drawerWidth > 200, `${withDrawer.drawerWidth}px`);

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
