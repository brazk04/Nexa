import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const svg = await readFile(new URL('../public/pwa-icon.svg', import.meta.url), 'utf8');
  for (const size of [192, 512, 180]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: fileURLToPath(new URL(`../public/pwa-${size}.png`, import.meta.url)) });
  }
} finally { await browser.close(); }
