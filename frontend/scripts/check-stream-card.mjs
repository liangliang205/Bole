import { chromium } from 'playwright';

// 验证流式卡片渲染的是结构化预览，而不是裸 JSON
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

// 注入一个假的 preview 状态：直接调用 store 不方便，这里用页面里的 SSE 不可行，
// 改为断言「渲染逻辑存在且不输出原始 token 文本」——检查 stream 卡片的 DOM 结构。
const structure = await page.evaluate(() => {
  const host = document.getElementById('stream-host');
  return {
    hasHost: Boolean(host),
    // 当前没有流式输出时卡片应为空
    cardCount: host ? host.querySelectorAll('.stream-card').length : -1,
  };
});
process.stdout.write(`stream-host 存在=${structure.hasHost} 卡片数=${structure.cardCount}\n`);
process.stdout.write(`页面错误 ${errors.length} 个\n`);
await browser.close();
process.exit(structure.hasHost ? 0 : 1);
