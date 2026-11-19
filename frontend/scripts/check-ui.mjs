/**
 * 交互冒烟：验证主题与分栏宽度能落 localStorage、刷新后仍生效。
 * 覆盖计划里 F1 的手动验收项（Review Focus 4）。
 *
 *   node scripts/check-ui.mjs [--base http://127.0.0.1:5173]
 */
import { chromium } from 'playwright';

const baseArg = process.argv.indexOf('--base');
const base = baseArg > 0 ? process.argv[baseArg + 1] : 'http://127.0.0.1:5173';
const failures = [];

function check(name, condition, detail = '') {
  if (condition) process.stdout.write(`PASS ${name}\n`);
  else {
    failures.push(name);
    process.stdout.write(`FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');

// 分栏宽度：键盘 +24 后应写入 localStorage 并改变 CSS 变量
const before = await page.evaluate(() => {
  const app = document.getElementById('app');
  return {
    var: Number.parseFloat(app?.style.getPropertyValue('--sidebar-width') ?? '0'),
    stored: localStorage.getItem('bole.sidebarWidth'),
  };
});
await page.focus('#sidebar-resizer');
await page.keyboard.press('ArrowRight');
const after = await page.evaluate(() => {
  const app = document.getElementById('app');
  return {
    var: Number.parseFloat(app?.style.getPropertyValue('--sidebar-width') ?? '0'),
    stored: Number(localStorage.getItem('bole.sidebarWidth') ?? '0'),
  };
});
check('侧栏宽度键盘可调', after.var > before.var, `${before.var} -> ${after.var}`);
check('侧栏宽度写入 localStorage', after.stored === after.var, `stored=${after.stored} var=${after.var}`);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
const restored = await page.evaluate(() => Number.parseFloat(document.getElementById('app')?.style.getPropertyValue('--sidebar-width') ?? '0'));
check('刷新后宽度保持', Math.abs(restored - after.var) < 1, `${after.var} -> ${restored}`);

// 主题：切换后刷新仍保持
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
await page.click('#theme-toggle');
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
check('主题可切换', themeAfter !== themeBefore, `${themeBefore} -> ${themeAfter}`);
await page.reload({ waitUntil: 'domcontentloaded' });
const themeReloaded = await page.evaluate(() => document.documentElement.dataset.theme);
check('刷新后主题保持', themeReloaded === themeAfter, `${themeAfter} -> ${themeReloaded}`);

await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
