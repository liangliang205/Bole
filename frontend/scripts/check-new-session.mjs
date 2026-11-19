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

// 回到新建页（若已有会话，点「新建」）
const emptyHidden = await page.evaluate(() => document.getElementById('empty-view')?.classList.contains('hidden'));
if (emptyHidden) {
  await page.click('#new-run-btn');
  await page.waitForTimeout(600);
}

const selectors = await page.evaluate(() => {
  const team = document.getElementById('new-agent-team');
  const policy = document.getElementById('new-policy-version');
  return {
    hasTeam: Boolean(team),
    hasPolicy: Boolean(policy),
    teamOptions: team ? [...team.options].map((option) => option.textContent.trim()) : [],
    policyOptions: policy ? [...policy.options].map((option) => option.textContent.trim()) : [],
  };
});
process.stdout.write(`团队选项: ${selectors.teamOptions.join(' / ')}\n`);
process.stdout.write(`评分标准选项: ${selectors.policyOptions.join(' / ')}\n`);
check('新建页有「默认团队」下拉', selectors.hasTeam);
check('新建页有「默认评分标准」下拉', selectors.hasPolicy);
check('团队下拉有内置兜底项', selectors.teamOptions.includes('内置团队'));
check('评分标准下拉有按需求生成兜底项', selectors.policyOptions.includes('按本次需求生成'));

// 选择团队后值能保留
const selected = await page.evaluate(() => {
  const team = document.getElementById('new-agent-team');
  if (!team || team.options.length < 2) return null;
  team.value = team.options[1].value;
  team.dispatchEvent(new Event('change', { bubbles: true }));
  return team.value;
});
if (selected) {
  await page.waitForTimeout(200);
  const kept = await page.evaluate(() => document.getElementById('new-agent-team')?.value ?? '');
  check('选择团队后状态保留', kept === selected, kept);
}

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
