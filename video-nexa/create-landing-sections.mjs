import { chromium } from '../app-chamadas-frontend/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sections = [
  ['01-hero', '.landing-hero'],
  ['02-funcionalidades', '#funcionalidades'],
  ['03-recursos', '#recursos'],
  ['04-cta-final', '.landing-close'],
  ['05-rodape', '.landing-footer'],
];
const formats = [['16x9', 1920, 1080], ['9x16', 1080, 1920]];
for (const [format] of formats) await mkdir(join(root, 'telas', format, 'landing-secoes'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [format, width, height] of formats) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(process.argv[2] || 'https://heynexa.vercel.app/');
    await page.evaluate(() => localStorage.removeItem('nexa-landing-language'));
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    for (const [name, selector] of sections) {
      const section = page.locator(selector);
      await section.scrollIntoViewIfNeeded();
      for (const image of await section.locator('img').all()) { await image.evaluate(element => element.decode().catch(() => undefined)); }
      await section.screenshot({ path: join(root, 'telas', format, 'landing-secoes', `${name}.png`), animations: 'disabled' });
    }
    await context.close();
  }
} finally { await browser.close(); }
console.log('Seções separadas da landing exportadas.');
