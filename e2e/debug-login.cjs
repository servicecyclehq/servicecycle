const { chromium } = require('playwright');
async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('https://demo.lapseiq.com/login', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Login page URL:', page.url());
  await page.fill('input[type=email]', 'admin@demo.local');
  await page.fill('input[type=password]', 'Admin1234!');
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);
  console.log('After login URL:', page.url());
  console.log('Body first 200:', (await page.locator('body').innerText()).slice(0, 200));
  await browser.close();
}
run().catch(e => console.error('ERR:', e));