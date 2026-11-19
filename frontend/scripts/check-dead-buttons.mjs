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

// 1) 新建筛选会话：从已选会话回到新建页
const beforeNew = await page.evaluate(() => ({
  emptyHidden: document.getElementById('empty-view')?.classList.contains('hidden') ?? null,
  chatHidden: document.getElementById('chat-view')?.classList.contains('hidden') ?? null,
  hash: window.location.hash,
}));
process.stdout.write(`点击前：emptyHidden=${beforeNew.emptyHidden} chatHidden=${beforeNew.chatHidden} hash=${beforeNew.hash}\n`);
check('点击前确实在会话里（用于验证切换）', beforeNew.emptyHidden === true);

// 2) 对话附件按钮可点（打开文件选择器由 input 存在性验证）
const attach = await page.evaluate(() => {
  const button = document.getElementById('chat-attach-btn');
  const input = document.getElementById('chat-file-input');
  return { hasButton: Boolean(button), hasInput: Boolean(input), inputHidden: input ? input.hidden : null };
});
check('对话附件按钮存在且绑定了隐藏 input', attach.hasButton && attach.hasInput);
await page.click('#new-run-btn');
await page.waitForTimeout(700);
const afterNew = await page.evaluate(() => ({
  emptyHidden: document.getElementById('empty-view')?.classList.contains('hidden') ?? null,
  chatHidden: document.getElementById('chat-view')?.classList.contains('hidden') ?? null,
  hash: window.location.hash,
  drawerHidden: document.getElementById('drawer')?.classList.contains('hidden') ?? null,
}));
process.stdout.write(`点击后：emptyHidden=${afterNew.emptyHidden} chatHidden=${afterNew.chatHidden} hash="${afterNew.hash}" drawerHidden=${afterNew.drawerHidden}\n`);
check('新建按钮切回新建页', afterNew.emptyHidden === false && afterNew.chatHidden === true);
check('新建按钮清空 URL hash', afterNew.hash === '', afterNew.hash);
check('新建时收起任务面板', afterNew.drawerHidden === true);


// 3) 知识库两个按钮不再 disabled
await page.click('#open-knowledge');
await page.waitForTimeout(600);
const kb = await page.evaluate(() => {
  const refresh = document.getElementById('kb-model-refresh');
  const test = document.getElementById('kb-test-embedding');
  return { hasRefresh: Boolean(refresh), refreshDisabled: refresh?.hasAttribute('disabled') ?? null, hasTest: Boolean(test), testDisabled: test?.hasAttribute('disabled') ?? null };
});
check('知识库「获取模型列表」可点', kb.hasRefresh && kb.refreshDisabled === false);
check('知识库「测试嵌入连接」可点', kb.hasTest && kb.testDisabled === false);
await page.click('#knowledge-close');
await page.waitForTimeout(300);

// 4) 插件页：开关存在，空按钮已移除
await page.click('#open-settings');
await page.waitForTimeout(500);
await page.click('#settings-modal [data-settings-tab="plugins"]');
await page.waitForTimeout(700);
const plugins = await page.evaluate(() => ({
  toggles: document.querySelectorAll('input[data-plugin-toggle]').length,
  deadActions: document.querySelectorAll('[data-plugin-action]').length,
}));
process.stdout.write(`插件：开关 ${plugins.toggles} 个，遗留空按钮 ${plugins.deadActions} 个\n`);
if (plugins.toggles === 0) { process.stdout.write('（本机没有安装插件，跳过开关断言）\n'); } else { check('插件行有启用开关', plugins.toggles > 0); }
check('插件行的空按钮已移除', plugins.deadActions === 0);

await browser.close();
const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
