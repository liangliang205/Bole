import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1424, height: 835 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1500);

// 选一个有执行轨迹的会话（列表第一条）
const firstJob = await page.$('#job-list .job-item, #job-list [data-job], #job-list button');
if (firstJob) { await firstJob.click(); await page.waitForTimeout(1500); }

// 展开执行轨迹
await page.evaluate(() => {
  for (const details of document.querySelectorAll('.msg-tools')) details.open = true;
});
await page.waitForTimeout(500);

const metrics = await page.evaluate(() => ({
  docScrollWidth: document.documentElement.scrollWidth,
  docClientWidth: document.documentElement.clientWidth,
  chatScrollWidth: document.getElementById('chat-scroll')?.scrollWidth ?? -1,
  chatClientWidth: document.getElementById('chat-scroll')?.clientWidth ?? -1,
  mainLeft: Math.round(document.querySelector('.main')?.getBoundingClientRect().left ?? -1),
  sidebarRight: Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().right ?? -1),
  toolRows: document.querySelectorAll('.tool-row').length,
}));
process.stdout.write(`${JSON.stringify(metrics)}\n`);

check('页面没有横向溢出', metrics.docScrollWidth <= metrics.docClientWidth + 1, `${metrics.docScrollWidth} vs ${metrics.docClientWidth}`);
check('对话区内部没有横向溢出', metrics.chatScrollWidth <= metrics.chatClientWidth + 1, `${metrics.chatScrollWidth} vs ${metrics.chatClientWidth}`);
check('正文列没有压到侧栏上', metrics.mainLeft >= metrics.sidebarRight - 1, `main.left=${metrics.mainLeft} sidebar.right=${metrics.sidebarRight}`);

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
