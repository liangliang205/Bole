import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

await page.click('#open-knowledge');
await page.waitForTimeout(600);
const opened = await page.evaluate(() => !document.getElementById('knowledge-modal')?.classList.contains('hidden'));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const closed = await page.evaluate(() => document.getElementById('knowledge-modal')?.classList.contains('hidden'));
process.stdout.write(`知识库：open=${opened} closedByEsc=${closed}\n`);

await page.click('#open-mailbox');
await page.waitForTimeout(600);
const mailOpened = await page.evaluate(() => !document.getElementById('mailbox-modal')?.classList.contains('hidden'));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const mailClosed = await page.evaluate(() => document.getElementById('mailbox-modal')?.classList.contains('hidden'));
process.stdout.write(`邮箱：open=${mailOpened} closedByEsc=${mailClosed}\n`);

await browser.close();
process.exit(opened && closed && mailOpened && mailClosed ? 0 : 1);
