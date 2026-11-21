import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#app');
await page.waitForTimeout(1200);

const read = () => page.evaluate(() => {
  const light = document.querySelector('.brand-logo-light');
  const dark = document.querySelector('.brand-logo-dark');
  return {
    theme: document.documentElement.dataset.theme,
    lightDisplay: light ? getComputedStyle(light).display : 'missing',
    darkDisplay: dark ? getComputedStyle(dark).display : 'missing',
  };
});

const before = await read();
process.stdout.write(`当前主题=${before.theme} light=${before.lightDisplay} dark=${before.darkDisplay}\n`);
const lightOk = before.theme !== 'dark' ? before.lightDisplay !== 'none' && before.darkDisplay === 'none' : true;

await page.click('#theme-toggle');
await page.waitForTimeout(600);
const after = await read();
process.stdout.write(`切换后=${after.theme} light=${after.lightDisplay} dark=${after.darkDisplay}\n`);
const darkOk = after.theme === 'dark' ? after.darkDisplay !== 'none' && after.lightDisplay === 'none' : false;

await page.screenshot({ path: 'D:\\agent\\bole\\desktop\\out\\logo-dark.png' });

await page.click('#theme-toggle');
await page.waitForTimeout(500);
const restored = await read();
process.stdout.write(`切回=${restored.theme} light=${restored.lightDisplay} dark=${restored.darkDisplay}\n`);

await browser.close();
process.exit(lightOk && darkOk ? 0 : 1);
