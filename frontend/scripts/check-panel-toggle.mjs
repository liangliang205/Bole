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

const state = async () => page.evaluate(() => ({
  open: Boolean(document.getElementById('drawer') && !document.getElementById('drawer').classList.contains('hidden')),
  cols: document.getElementById('app') ? getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length : 0,
  expanded: document.getElementById('panel-btn')?.getAttribute('aria-expanded') ?? null,
  label: document.getElementById('panel-btn')?.textContent?.trim() ?? '',
}));

const initial = await state();
process.stdout.write(`初始：open=${initial.open} cols=${initial.cols} aria=${initial.expanded}\n`);
check('初始 aria-expanded 反映状态', initial.expanded === String(initial.open), `aria=${initial.expanded}`);

// 第一次点击：如果开着就收起
await page.click('#panel-btn');
await page.waitForTimeout(500);
const first = await state();
process.stdout.write(`点 1 次：open=${first.open} cols=${first.cols} aria=${first.expanded}\n`);
check('第一次点击改变了面板状态', first.open !== initial.open, `${initial.open} → ${first.open}`);
check('收起后网格回到 3 列', first.open || first.cols === 3, `${first.cols} 列`);
check('收起后 aria-expanded=false', first.expanded === 'false');

// 第二次点击：重新打开
await page.click('#panel-btn');
await page.waitForTimeout(500);
const second = await state();
process.stdout.write(`点 2 次：open=${second.open} cols=${second.cols} aria=${second.expanded}\n`);
check('第二次点击重新打开面板', second.open === true);
check('打开后网格 4 列', second.cols === 4, `${second.cols} 列`);
check('打开后 aria-expanded=true', second.expanded === 'true');

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
