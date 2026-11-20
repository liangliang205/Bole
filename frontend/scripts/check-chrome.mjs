import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((ctx) => ctx.pages()).find((p) => p.url().startsWith('http://127.0.0.1'));
if (!page) { process.stdout.write('无页面\n'); process.exit(1); }
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const app = document.getElementById('app');
  const topbar = document.querySelector('.topbar');
  const button = document.getElementById('panel-btn');
  const style = topbar ? getComputedStyle(topbar) : null;
  return {
    appClass: app ? app.className : '',
    hasBoleDesktop: typeof window.boleDesktop !== 'undefined',
    topbarRegion: style ? style.getPropertyValue('-webkit-app-region') : 'n/a',
    topbarPaddingRight: style ? style.paddingRight : 'n/a',
    buttonRegion: button ? getComputedStyle(button).getPropertyValue('-webkit-app-region') : 'n/a',
    windowOuter: window.outerWidth + 'x' + window.outerHeight,
    windowInner: window.innerWidth + 'x' + window.innerHeight,
  };
});
process.stdout.write(JSON.stringify(info, null, 1) + '\n');

await page.click('#panel-btn');
await page.waitForTimeout(500);
const opened = await page.evaluate(() => !document.getElementById('drawer').classList.contains('hidden'));
process.stdout.write('任务面板可打开=' + opened + '\n');

await browser.close();
process.exit(info.appClass.includes('desktop-chrome') && info.topbarRegion === 'drag' && opened ? 0 : 1);
