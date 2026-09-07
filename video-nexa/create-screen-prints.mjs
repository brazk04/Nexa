import { chromium } from '../app-chamadas-frontend/node_modules/@playwright/test/index.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const source = [
  ['chat', '01-chat-da-sala.png'],
  ['reuniao', '02-central-da-reuniao.png'],
  ['landing-desktop', '03-landing-desktop.png'],
  ['landing-mobile', '04-landing-mobile.png'],
];
const formats = [['16x9', 1920, 1080], ['9x16', 1080, 1920]];
await Promise.all(formats.map(([name]) => mkdir(join(root, 'telas', name), { recursive: true })));
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [format, width, height] of formats) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    for (const [name, file] of source) {
      const data = (await readFile(join(root, file))).toString('base64');
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101116}body{display:grid;place-items:center}img{display:block;width:94vw;height:88vh;object-fit:contain;border:1px solid #484c59;border-radius:18px;box-shadow:0 30px 90px #0009}</style><img src="data:image/png;base64,${data}" alt="Nexa ${name}">`);
      await page.screenshot({ path: join(root, 'telas', format, `${name}.png`) });
    }
    await page.close();
  }
} finally { await browser.close(); }
console.log('Prints separados criados em video-nexa/telas/.');
