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
await page.waitForTimeout(1500);

// 确保任务面板打开
const drawerHidden = await page.evaluate(() => document.getElementById('drawer')?.classList.contains('hidden'));
if (drawerHidden) {
  await page.click('#panel-btn');
  await page.waitForTimeout(600);
}

async function openTab(key) {
  await page.click(`[data-drawer-tab="${key}"]`);
  await page.waitForTimeout(1200);
}

// 任务记忆
await openTab('memory');
const memory = await page.evaluate(() => {
  const body = document.getElementById('drawer-body');
  return {
    headings: [...body.querySelectorAll('h3')].map((el) => el.textContent.trim()),
    cards: body.querySelectorAll('.eval-card').length,
    hasRawPre: body.querySelectorAll(':scope > pre').length > 0,
    details: body.querySelectorAll('details').length,
  };
});
process.stdout.write(`memory: ${memory.headings.join(' | ')}\n`);
check('任务记忆有分节标题', memory.headings.includes('当前任务记忆') && memory.headings.includes('人工确认记录'));
check('任务记忆用卡片而不是纯 JSON', memory.cards >= 1 && !memory.hasRawPre, `cards=${memory.cards}`);

// Agent
await openTab('agents');
const agents = await page.evaluate(() => {
  const body = document.getElementById('drawer-body');
  return {
    headings: [...body.querySelectorAll('h3')].map((el) => el.textContent.trim()),
    cards: body.querySelectorAll('.eval-card').length,
    hasRawPre: body.querySelectorAll(':scope > pre').length > 0,
  };
});
process.stdout.write(`agents: ${agents.headings.join(' | ')}\n`);
check('Agent 页有绑定卡与调用记录', agents.cards >= 1 && agents.headings.includes('调用记录'));

// 工作流
await openTab('workflow');
const workflow = await page.evaluate(() => {
  const body = document.getElementById('drawer-body');
  return {
    headings: [...body.querySelectorAll('h3')].map((el) => el.textContent.trim()),
    nodes: body.querySelectorAll('details.workflow-node').length,
    tags: body.querySelectorAll('.eval-head .tag').length,
    hasRawPre: body.querySelectorAll(':scope > pre').length > 0,
  };
});
process.stdout.write(`workflow: nodes=${workflow.nodes} tags=${workflow.tags}\n`);
check('工作流页渲染节点折叠块', workflow.nodes > 0, `${workflow.nodes} 个节点`);
check('工作流页有状态标签', workflow.tags > 0);
check('三个 tab 都不再是整页裸 JSON', !workflow.hasRawPre && !agents.hasRawPre && !memory.hasRawPre);

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
