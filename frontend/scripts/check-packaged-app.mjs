import { chromium } from 'playwright';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = browser.contexts().flatMap((ctx) => ctx.pages());
const page = pages.find((item) => item.url().startsWith('http://127.0.0.1'));
if (!page) {
  process.stdout.write(`找不到页面，pages=${pages.map((p) => p.url()).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`连接页面：${page.url()}\n`);
await page.waitForTimeout(1500);

// 在输入框写内容但不带附件 → 应提示"请上传简历或选择从招聘邮箱收取"（而不是 404）
await page.fill('#new-requirements', '打包验证：找一位全栈工程师');
await page.click('#new-start');
await page.waitForTimeout(1200);
const hint = await page.evaluate(() => document.getElementById('new-hint')?.textContent?.trim() ?? '');
process.stdout.write(`提示文本：${hint}\n`);
check('无附件时给出正确提示', hint.includes('请上传简历'), hint);
check('没有再调用不存在的接口', !hint.includes('未知接口'), hint);

// 设置 / 知识库 / 帮助 可点
const toggle = async (label, selector, probe) => {
  const before = await probe();
  await page.click(selector, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  const after = await probe();
  check(label, JSON.stringify(before) !== JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
};
await toggle('打开设置', '#open-settings', () => page.evaluate(() => !document.getElementById('settings-modal')?.classList.contains('hidden')));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await toggle('打开知识库', '#open-knowledge', () => page.evaluate(() => !document.getElementById('knowledge-modal')?.classList.contains('hidden')));
await page.keyboard.press('Escape').catch(() => undefined);
await page.waitForTimeout(300);
await toggle('打开帮助', '#help-open', () => page.evaluate(() => document.getElementById('help-dialog')?.open === true));

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
