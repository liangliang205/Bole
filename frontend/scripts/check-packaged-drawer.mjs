import { chromium } from 'playwright';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((ctx) => ctx.pages()).find((p) => p.url().startsWith('http://127.0.0.1'));
if (!page) { process.stdout.write('没有页面\n'); process.exit(1); }
process.stdout.write(`连接页面：${page.url()}\n`);
await page.waitForTimeout(1500);

const state = () => page.evaluate(() => ({
  drawerOpen: !document.getElementById('drawer')?.classList.contains('hidden'),
  body: document.getElementById('drawer-body')?.textContent?.trim().slice(0, 24) ?? '',
  gridColumns: getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length,
  ariaExpanded: document.getElementById('panel-btn')?.getAttribute('aria-expanded'),
}));

const initial = await state();
process.stdout.write(`初始：${JSON.stringify(initial)}\n`);

await page.click('#panel-btn');
await page.waitForTimeout(600);
const opened = await state();
process.stdout.write(`点开：${JSON.stringify(opened)}\n`);
check('无会话时任务面板能打开', opened.drawerOpen === true);
check('打开后给出"选择会话"提示', opened.body.includes('选择会话'), opened.body);
check('打开后网格变 4 列', opened.gridColumns === 4, `${opened.gridColumns}`);

await page.click('#panel-btn');
await page.waitForTimeout(500);
const closed = await state();
process.stdout.write(`再点：${JSON.stringify(closed)}\n`);
check('再点能收起', closed.drawerOpen === false);

// 其余弹窗仍然可点（回归）
await page.click('#open-settings');
await page.waitForTimeout(600);
check('设置可打开', await page.evaluate(() => !document.getElementById('settings-modal')?.classList.contains('hidden')));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.click('#help-open');
await page.waitForTimeout(600);
check('帮助可打开', await page.evaluate(() => document.getElementById('help-dialog')?.open === true));

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
