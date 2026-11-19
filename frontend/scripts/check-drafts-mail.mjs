import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

// ---- Agent 草稿 ----
await page.click('#open-settings');
await page.waitForTimeout(500);
await page.click('#settings-modal [data-settings-tab="agents"]');
await page.waitForTimeout(900);

await page.click('.agent-team-editor > summary');
await page.waitForTimeout(400);

const draftName = `验证草稿-${Date.now().toString(36)}`;
await page.evaluate((name) => {
  const nameInput = document.getElementById('agent-name');
  const promptInput = document.getElementById('agent-prompt');
  if (nameInput) nameInput.value = name;
  if (promptInput) promptInput.value = '检查简历中的职业资格，只输出有原文依据的发现。';
}, draftName);

await page.click('button:has-text("保存草稿")');
await page.waitForTimeout(1500);

const afterSave = await page.evaluate(() => ({
  cards: document.querySelectorAll('#agent-draft-list .eval-card').length,
  text: document.getElementById('agent-draft-list')?.textContent?.slice(0, 140) ?? '',
}));
process.stdout.write(`草稿保存后：卡片 ${afterSave.cards} 个\n`);
check('保存草稿后出现在草稿列表', afterSave.cards > 0 && afterSave.text.includes(draftName));

await page.click('#agent-draft-list .eval-card:first-child button:has-text("继续编辑")');
await page.waitForTimeout(600);
const editing = await page.evaluate(() => ({
  name: document.getElementById('agent-name')?.value ?? '',
  hint: document.querySelector('.agent-team-editor p.muted')?.textContent?.replace(/\s+/g, ' ').slice(0, 40) ?? '',
}));
process.stdout.write(`继续编辑：name="${editing.name}" 提示="${editing.hint}"\n`);
check('继续编辑把定义填回表单', editing.name === draftName);
check('编辑态有明显提示', editing.hint.includes('正在编辑草稿'), editing.hint);

page.once('dialog', (dialog) => { void dialog.accept(); });
await page.click('#agent-draft-list .eval-card:first-child button:has-text("删除")');
await page.waitForTimeout(1500);
const afterDelete = await page.evaluate(() => document.querySelectorAll('#agent-draft-list .eval-card').length);
check('删除草稿后列表减少', afterDelete < afterSave.cards, `${afterSave.cards} → ${afterDelete}`);

// ---- 邮箱高级配置 ----
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('#open-mailbox');
await page.waitForTimeout(700);
const adapterEditor = await page.evaluate(() => {
  const details = document.querySelector('.mailbox-adapter-editor');
  return { exists: Boolean(details), hidden: details?.classList.contains('hidden') ?? null };
});
check('邮箱高级配置可见', adapterEditor.exists && adapterEditor.hidden === false);

await page.click('.mailbox-adapter-editor > summary');
await page.waitForTimeout(300);
await page.click('#mail-adapter-template');
await page.waitForTimeout(300);
const config = await page.evaluate(() => document.getElementById('mail-adapter-config')?.value ?? '');
check('「填入通用示例」写入配置', config.includes('"operations"') && config.includes('"download"'));

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
