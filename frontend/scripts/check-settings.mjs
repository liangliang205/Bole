import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(800);

// 打开设置
await page.click('#open-settings');
const opened = await page.evaluate(() => !document.getElementById('settings-modal')?.classList.contains('hidden'));
check('点击设置能打开弹窗', opened);

// ✕ 关闭
const hasClose = await page.evaluate(() => {
  const button = document.getElementById('settings-close');
  if (!button) return false;
  button.click();
  return true;
});
await page.waitForTimeout(200);
const closedByX = await page.evaluate(() => document.getElementById('settings-modal')?.classList.contains('hidden'));
check('设置弹窗 ✕ 可关闭', hasClose && closedByX);

// Esc 关闭
await page.click('#open-settings');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const closedByEsc = await page.evaluate(() => document.getElementById('settings-modal')?.classList.contains('hidden'));
check('Esc 可关闭设置弹窗', closedByEsc);

// 提供商编辑器
await page.click('#open-settings');
await page.waitForTimeout(200);
await page.click('#provider-add');
await page.waitForTimeout(200);
const editorVisible = await page.evaluate(() => Boolean(document.getElementById('provider-editor')));
check('「添加模型提供商」打开表单', editorVisible);
const fields = await page.evaluate(() => ['provider-name', 'provider-base', 'provider-key', 'provider-flash', 'provider-pro'].every((id) => Boolean(document.getElementById(id))));
check('表单字段齐全', fields);

// 插件页
await page.click('#settings-modal [data-settings-tab="plugins"]');
await page.waitForTimeout(300);
const pluginUi = await page.evaluate(() => {
  const add = document.getElementById('plugin-add');
  const refresh = document.getElementById('plugin-refresh');
  return { add: Boolean(add && !add.hasAttribute('disabled')), refresh: Boolean(refresh) };
});
check('插件页「添加插件」可点', pluginUi.add);
check('插件页「刷新」存在', pluginUi.refresh);

await browser.close();
const failed = results.filter((item) => !item.ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
