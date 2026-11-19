import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

await page.click('#open-settings');
await page.waitForTimeout(600);

// ---- 模型页 ----
const providerCards = await page.evaluate(() => document.querySelectorAll('#provider-list .provider-card').length);
process.stdout.write(`provider 卡片：${providerCards}\n`);
const providerActions = await page.evaluate(() => {
  const card = document.querySelector('#provider-list .provider-card');
  if (!card) return [];
  return [...card.querySelectorAll('.provider-actions button')].map((b) => b.textContent.trim());
});
check('模型卡片有操作按钮', providerActions.includes('测试') && providerActions.includes('编辑'), providerActions.join('/'));

await page.click('#provider-add');
await page.waitForTimeout(300);
const createFields = await page.evaluate(() => ['provider-name', 'provider-base', 'provider-key', 'provider-flash', 'provider-pro'].every((id) => Boolean(document.getElementById(id))));
check('新增表单字段齐全', createFields);

// 关掉新增表单，改编辑第一个 provider
await page.click('#provider-editor button:has-text("取消")');
await page.waitForTimeout(300);
await page.click('#provider-list .provider-card .provider-actions button:has-text("编辑")');
await page.waitForTimeout(300);
const editPrefill = await page.evaluate(() => {
  const name = document.getElementById('provider-name');
  const base = document.getElementById('provider-base');
  return { name: name ? name.value : '', base: base ? base.value : '', hasIdField: Boolean(document.getElementById('provider-id')) };
});
check('编辑表单预填且不显示 ID 字段', editPrefill.name.length > 0 && !editPrefill.hasIdField, `name=${editPrefill.name}`);
await page.click('#provider-editor button:has-text("取消")');
await page.waitForTimeout(200);

// ---- 岗位与评分标准 ----
await page.click('#settings-modal [data-settings-tab="memory"]');
await page.waitForTimeout(600);
const memoryTabs = await page.evaluate(() => [...document.querySelectorAll('[data-memory-tab]')].map((b) => b.textContent.trim()));
process.stdout.write(`memory tabs: ${memoryTabs.join(' | ')}\n`);
check('岗位页有四个子 tab', memoryTabs.length === 4);

await page.click('[data-memory-tab="proposals"]');
await page.waitForTimeout(500);
const proposalsVisible = await page.evaluate(() => {
  const section = document.querySelector('[data-memory-section="proposals"]');
  return Boolean(section && !section.classList.contains('hidden'));
});
check('提案与审批可切换', proposalsVisible);

await page.click('[data-memory-tab="create"]');
await page.waitForTimeout(500);
const createFields2 = await page.evaluate(() => ['memory-family', 'memory-rule', 'memory-why', 'memory-how', 'memory-profile', 'memory-submit', 'memory-base-version', 'memory-source-job'].every((id) => Boolean(document.getElementById(id))));
check('创建提案表单字段齐全', createFields2);

await page.click('[data-memory-tab="job"]');
await page.waitForTimeout(800);
const jobTab = await page.evaluate(() => {
  const section = document.querySelector('[data-memory-section="job"]');
  return { visible: Boolean(section && !section.classList.contains('hidden')), text: section?.textContent?.slice(0, 40) ?? '' };
});
check('当前任务记忆可切换并有内容', jobTab.visible, jobTab.text.replace(/\s+/g, ' '));

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
