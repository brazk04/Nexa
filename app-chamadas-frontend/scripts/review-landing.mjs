import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ colorScheme: 'dark', viewport: { width: 1440, height: 1000 } });
  await page.goto(process.argv[2] || 'http://127.0.0.1:5175/');
  await page.locator('.landing').waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const picture of await page.locator('.landing img').all()) {
    await picture.scrollIntoViewIfNeeded();
    await picture.evaluate(element => element.decode());
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.landing').screenshot({ path: 'test-results/landing-desktop.png' });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.locator('.landing').screenshot({ path: 'test-results/landing-mobile.png' });
  console.log('Landing screenshots captured.');
} finally { await browser.close(); }
