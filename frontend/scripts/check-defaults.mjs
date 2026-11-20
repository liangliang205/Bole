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

// 新建页不再有这两块下拉
const onNew = await page.evaluate(() => ({
  hasDefaults: Boolean(document.querySelector('#empty-view .new-defaults')),
  team: Boolean(document.querySelector('#empty-view #new-agent-team')),
  policy: Boolean(document.querySelector('#empty-view #new-policy-version')),
}));
process.stdout.write(`新建页：defaults=${onNew.hasDefaults} team=${onNew.team} policy=${onNew.policy}\n`);
check('新建页不再出现默认团队/评分标准', !onNew.hasDefaults && !onNew.team && !onNew.policy);

// 设置 → Agent 团队：默认团队在下拉里
await page.click('#open-settings');
await page.waitForTimeout(500);
await page.click('#settings-modal [data-settings-tab="agents"]');
await page.waitForTimeout(1200);
const teamSelect = await page.evaluate(() => {
  const select = document.getElementById('new-agent-team');
  return select ? { options: [...select.options].map((o) => o.textContent.trim()), value: select.value } : null;
});
process.stdout.write(`设置里的默认团队：${JSON.stringify(teamSelect)}\n`);
check('设置 · Agent 团队里有「新筛选默认团队」', Boolean(teamSelect) && teamSelect.options.includes('内置团队'));

// 设置 → 岗位与评分标准：默认评分标准在下拉里
await page.click('#settings-modal [data-settings-tab="memory"]');
await page.waitForTimeout(1000);
const policySelect = await page.evaluate(() => {
  const select = document.getElementById('new-policy-version');
  return select ? { options: [...select.options].map((o) => o.textContent.trim()), value: select.value } : null;
});
process.stdout.write(`设置里的默认评分标准：${JSON.stringify(policySelect)}\n`);
check('设置 · 岗位与评分标准里有「新筛选默认评分标准」', Boolean(policySelect) && policySelect.options.includes('按本次需求生成'));

// 选一个团队 → 持久化 → 刷新后仍在，且新建页会用到
const picked = await page.evaluate(() => {
  const select = document.getElementById('new-agent-team');
  if (!select || select.options.length < 2) return '';
  const target = select.options[1].value;
  select.value = target;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return target;
});
await page.waitForTimeout(400);
const stored = await page.evaluate(() => localStorage.getItem('bole.newRunDefaults'));
process.stdout.write(`已选团队=${picked} localStorage=${stored}\n`);
check('选择后写入 localStorage', Boolean(stored) && stored.includes(picked));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);
const afterReload = await page.evaluate(() => localStorage.getItem('bole.newRunDefaults'));
check('刷新后默认值仍保留', Boolean(afterReload) && afterReload.includes(picked));

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
