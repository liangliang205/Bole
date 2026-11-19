import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 880, height: 861 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

await page.click('#open-settings');
await page.waitForTimeout(600);

// 1) 卡片布局：三个操作按钮在同一行（高度差 < 6px）
const layout = await page.evaluate(() => {
  const card = document.querySelector('#provider-list .provider-card');
  if (!card) return null;
  const buttons = [...card.querySelectorAll('.provider-actions button')].map((b) => b.getBoundingClientRect());
  const cardBox = card.getBoundingClientRect();
  const meta = card.querySelector('.provider-meta')?.getBoundingClientRect();
  return {
    buttonCount: buttons.length,
    sameRow: buttons.every((box) => Math.abs(box.top - buttons[0].top) < 6),
    cardHeight: Math.round(cardBox.height),
    metaHeight: meta ? Math.round(meta.height) : 0,
  };
});
process.stdout.write(`卡片：${layout?.buttonCount} 个操作按钮，高度 ${layout?.cardHeight}px\n`);
check('操作按钮排在同一行', Boolean(layout?.sameRow));
check('卡片没有因长地址变成多行', (layout?.cardHeight ?? 999) < 90, `${layout?.cardHeight}px`);
check('地址单行展示', (layout?.metaHeight ?? 99) < 22, `${layout?.metaHeight}px`);

// 2) 卡片级「测试」发出的是该 provider 的 id 与地址
let captured = null;
page.on('request', (request) => {
  if (request.url().includes('/api/providers/discover-models')) {
    try { captured = JSON.parse(request.postData() ?? '{}'); } catch { captured = {}; }
  }
});
await page.click('#provider-list .provider-card:nth-child(2) .provider-actions button:has-text("测试")');
await page.waitForTimeout(2500);
process.stdout.write(`测试请求体：${JSON.stringify(captured)}\n`);
check('卡片测试带 providerId', Boolean(captured?.providerId), String(captured?.providerId ?? ''));
check('卡片测试带该提供商的 baseUrl', Boolean(captured?.baseUrl), String(captured?.baseUrl ?? ''));
check('卡片测试不带密钥（由服务端按 id 取）', captured?.apiKey === undefined);

// 3) 编辑：列表隐藏、标题点名、按钮齐全
await page.click('#provider-list .provider-card:nth-child(2) .provider-actions button:has-text("编辑")');
await page.waitForTimeout(400);
const editing = await page.evaluate(() => ({
  listHidden: !document.getElementById('provider-list'),
  title: document.querySelector('#provider-editor .provider-editor-head h3')?.textContent?.trim() ?? '',
  hasTest: Boolean(document.querySelector('#provider-editor .provider-editor-actions button')) ,
  actions: [...document.querySelectorAll('#provider-editor .provider-editor-actions button')].map((b) => b.textContent.trim()),
}));
process.stdout.write(`编辑面板标题：${editing.title}\n`);
check('编辑时列表让位给独立面板', editing.listHidden);
check('面板标题点名正在编辑的提供商', /^编辑：.+/.test(editing.title), editing.title);
check('面板底部有测试/取消/保存', editing.actions.includes('测试连接') && editing.actions.includes('取消') && editing.actions.some((text) => text.includes('保存')), editing.actions.join('/'));

await page.click('#provider-editor .provider-editor-actions button:has-text("取消")');
await page.waitForTimeout(400);
const restored = await page.evaluate(() => Boolean(document.getElementById('provider-list')));
check('取消后回到列表', restored);

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
