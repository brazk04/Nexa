import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) throw new Error('Informe a URL a verificar.');
const profile = await mkdtemp(join(tmpdir(), 'nexa-pwa-check-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', colorScheme: 'dark' });
try {
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  console.log('Manifest:', JSON.stringify({ url: manifest.url, errors: manifest.errors }));
  console.log('Installability:', JSON.stringify(await cdp.send('Page.getInstallabilityErrors')));
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  console.log('Service worker controls page:', await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  await context.setOffline(true);
  await page.goto(new URL('/login', url).href);
  console.log('Offline:', await page.locator('h2').innerText());
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
