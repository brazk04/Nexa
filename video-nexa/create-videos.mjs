import { chromium } from '../app-chamadas-frontend/node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const slides = [
  ['01-chat-da-sala.png', 'Converse com sua equipe'],
  ['02-central-da-reuniao.png', 'Organize os próximos passos'],
  ['03-landing-desktop.png', 'Tudo em um só lugar'],
  ['04-landing-mobile.png', 'Nexa, onde sua equipe estiver'],
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const format of [{ name: 'nexa-apresentacao-horizontal.webm', width: 1280, height: 720 }, { name: 'nexa-apresentacao-vertical.webm', width: 720, height: 1280 }]) {
    const page = await browser.newPage({ viewport: { width: format.width, height: format.height }, deviceScaleFactor: 1 });
    const payload = await Promise.all(slides.map(async ([file, title]) => ({ title, data: (await readFile(join(root, file))).toString('base64') })));
    await page.setContent(`<canvas id="video" width="${format.width}" height="${format.height}"></canvas><script>window.__slides=${JSON.stringify(payload)}</script>`);
    const video = await page.evaluate(async ({ width, height }) => {
      const canvas = document.querySelector('canvas'); const context = canvas.getContext('2d');
      const loaded = await Promise.all(window.__slides.map(item => new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ ...item, image }); image.src = 'data:image/png;base64,' + item.data; })));
      const stream = canvas.captureStream(30); const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 5_000_000 }); const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const fit = (image, alpha) => { context.globalAlpha = alpha; context.fillStyle = '#101116'; context.fillRect(0, 0, width, height); const scale = Math.min((width * .9) / image.naturalWidth, (height * .72) / image.naturalHeight); const w = image.naturalWidth * scale; const h = image.naturalHeight * scale; context.drawImage(image, (width - w) / 2, (height - h) / 2 - height * .04, w, h); context.globalAlpha = 1; };
      recorder.start();
      for (const slide of loaded) for (let frame = 0; frame < 120; frame++) { fit(slide.image, frame < 21 ? frame / 21 : 1); context.fillStyle = '#f5f3f8'; context.font = `600 ${Math.max(24, Math.round(width / 28))}px Arial`; context.textAlign = 'center'; context.fillText(slide.title, width / 2, height * .9); await new Promise(requestAnimationFrame); }
      recorder.stop(); await new Promise(resolve => { recorder.onstop = resolve; });
      return new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    }, { width: format.width, height: format.height });
    await writeFile(join(root, format.name), video);
    await page.close();
  }
} finally { await browser.close(); }
console.log('Vídeos criados em video-nexa/.');
