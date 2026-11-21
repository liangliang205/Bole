import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  icons: document.querySelectorAll('svg.icon').length,
  topbarIcons: document.querySelectorAll('.topbar svg.icon').length,
  sidebarIcons: document.querySelectorAll('.sidebar svg.icon').length,
  leftoverGlyphs: [...document.querySelectorAll('.topbar button, .sidebar button')]
    .map((b) => b.textContent.trim())
    .filter((t) => /[▤☀☾ⓘ✉⚙⌕＋⋯]/.test(t)),
}));
console.log(JSON.stringify(info));
await page.screenshot({ path: 'D:\\agent\\bole\\frontend\\public\\..\\..\\desktop\\out\\icons-check.png' });
await browser.close();
