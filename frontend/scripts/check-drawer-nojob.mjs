import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);
// 先回到新建页，确保没有选中会话
const newBtn = await page.$('#new-run-btn');
if (newBtn) { await newBtn.click(); await page.waitForTimeout(500); }
const closed = await page.evaluate(() => document.getElementById('drawer')?.classList.contains('hidden'));
await page.click('#panel-btn');
await page.waitForTimeout(500);
const opened = await page.evaluate(() => !document.getElementById('drawer')?.classList.contains('hidden'));
const body = await page.evaluate(() => document.getElementById('drawer-body')?.textContent?.trim().slice(0, 30) ?? '');
await page.click('#panel-btn');
await page.waitForTimeout(400);
const closedAgain = await page.evaluate(() => document.getElementById('drawer')?.classList.contains('hidden'));
console.log(JSON.stringify({ startedHidden: closed, openedWithoutJob: opened, body, closedAgain }));
await browser.close();
