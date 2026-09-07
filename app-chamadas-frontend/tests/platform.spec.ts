import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

interface InstrumentedWindow extends Window {
  __peers: RTCPeerConnection[];
  __streams: MediaStream[];
  __displays: MediaStream[];
  __mediaRequests: { audio: boolean; video: boolean }[];
  __releaseMedia?: () => void;
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as InstrumentedWindow;
    target.__peers = []; target.__streams = []; target.__displays = []; target.__mediaRequests = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) { super(configuration); target.__peers.push(this); }
    };
    const videoStream = (color: string) => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d')!; let frame = 0;
      const paint = () => { context.fillStyle = color; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.font = '30px sans-serif'; context.fillText(String(frame++), 25, 50); };
      paint(); const timer = window.setInterval(paint, 100);
      const stream = canvas.captureStream(10); const track = stream.getVideoTracks()[0]; const nativeStop = track.stop.bind(track);
      track.stop = () => { window.clearInterval(timer); nativeStop(); };
      return stream;
    };
    navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
      target.__mediaRequests.push({ audio: Boolean(constraints.audio), video: Boolean(constraints.video) });
      const tracks: MediaStreamTrack[] = [];
      if (constraints.video) tracks.push(...videoStream('#5b3ca0').getVideoTracks());
      if (constraints.audio) {
        const audioContext = new AudioContext(); const oscillator = audioContext.createOscillator(); const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const audio = destination.stream.getAudioTracks()[0]; const nativeStop = audio.stop.bind(audio);
        audio.stop = () => { oscillator.stop(); void audioContext.close(); nativeStop(); };
        tracks.push(audio);
      }
      const stream = new MediaStream(tracks); target.__streams.push(stream); return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = videoStream('#145c50'); target.__displays.push(stream); return stream;
    };
  });
}
async function signup(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ainda não tenho uma conta' }).click();
  await page.getByLabel('Nome de usuário', { exact: true }).fill(username);
  await page.getByLabel('Data de nascimento', { exact: true }).fill('1990-01-02');
  await page.getByLabel('E-mail', { exact: true }).fill(`${username.toLowerCase()}@example.com`);
  await page.getByLabel('Senha', { exact: true }).fill('Senha1234');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verifique seu e-mail.' })).toBeVisible();
  const response = await page.request.get(`http://127.0.0.1:3355/__test/verification/${username}`);
  expect(response.ok()).toBeTruthy();
  const { token } = await response.json() as { token: string };
  await page.goto(`/?verify=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: 'Seu espaço começa aqui.' })).toBeVisible();
}
async function createRoom(page: Page, name: string) {
  await page.getByRole('button', { name: 'Criar sala', exact: true }).first().click();
  await page.getByLabel('Nome da sala', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Criar sala', exact: true }).click();
  await expect(page.locator('.room-header').getByRole('heading', { name })).toBeVisible();
  return page.locator('.room-code span').innerText();
}
async function joinRoom(page: Page, code: string, name: string) {
  await page.getByRole('button', { name: 'Entrar com código', exact: true }).first().click();
  await page.getByLabel('Código de convite', { exact: true }).fill(code.toLowerCase().replace('-', ''));
  await page.getByRole('dialog').getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.locator('.room-header').getByRole('heading', { name })).toBeVisible();
}
async function person(browser: Browser, username: string, room?: { code: string; name: string }) {
  const context = await browser.newContext();
  const page = await context.newPage(); await instrument(page); await signup(page, username);
  if (room) await joinRoom(page, room.code, room.name);
  return { context, page };
}
async function expectConnectedPeers(page: Page, count: number) {
  await expect(page.getByText('Chamada conectada', { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as InstrumentedWindow).__peers.filter(peer => peer.connectionState === 'connected').length)).toBe(count);
}
async function expectStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as InstrumentedWindow;
    return state.__peers.every(peer => peer.connectionState === 'closed') && [...state.__streams, ...state.__displays].every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
  })).toBe(true);
}
async function closeAll(contexts: BrowserContext[]) { await Promise.all(contexts.map(context => context.close())); }

test('cadastro verificado, salas por código, chat persistente, isolamento e logout', async ({ browser }) => {
  const alice = await person(browser, 'AliceWeb');
  const contexts = [alice.context];
  try {
    const code = await createRoom(alice.page, 'Projeto Alpha');
    const bruno = await person(browser, 'BrunoWeb', { code, name: 'Projeto Alpha' }); contexts.push(bruno.context);
    const carla = await person(browser, 'CarlaWeb'); contexts.push(carla.context);
    await expect(alice.page.getByRole('region', { name: 'Pessoas online' }).getByText('BrunoWeb', { exact: true })).toBeVisible();
    await expect(carla.page.getByText('Projeto Alpha', { exact: true })).toHaveCount(0);
    const message = `Mensagem autenticada ${Date.now()}`;
    await alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true }).fill(message);
    await alice.page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    await expect(alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true })).toBeFocused();
    await expect(alice.page.getByRole('log').getByText(message, { exact: true })).toHaveCount(1);
    await expect(bruno.page.getByRole('log').getByText(message, { exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Aparência', exact: true }).click();
    await alice.page.getByLabel('Tema').selectOption('light');
    await alice.page.getByRole('button', { name: 'Salvar aparência', exact: true }).click();
    await expect(alice.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await alice.page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await bruno.page.reload();
    await expect(bruno.page.getByRole('log').getByText(message, { exact: true })).toBeVisible();
    await bruno.page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await expect(bruno.page.getByRole('heading', { name: 'Entre na sua conta.' })).toBeVisible();
  } finally { await closeAll(contexts); }
});

test('WebRTC mesh com três pessoas, compartilhamento tardio, saída isolada e maximização', async ({ browser }) => {
  const alice = await person(browser, 'AliceCall'); const contexts = [alice.context];
  try {
    const code = await createRoom(alice.page, 'Sala Mesh');
    const bruno = await person(browser, 'BrunoCall', { code, name: 'Sala Mesh' }); contexts.push(bruno.context);
    const carla = await person(browser, 'CarlaCall', { code, name: 'Sala Mesh' }); contexts.push(carla.context);
    await alice.page.getByRole('button', { name: 'Iniciar chamada', exact: true }).click();
    await bruno.page.getByRole('button', { name: 'Entrar na chamada', exact: true }).click();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(bruno.page, 1);
    expect(await alice.page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([]);
    expect(await bruno.page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([]);
    await alice.page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
    await expect(alice.page.getByRole('button', { name: 'Silenciar microfone', exact: true })).toBeEnabled();
    await alice.page.getByRole('button', { name: 'Ligar câmera', exact: true }).click();
    await expect(alice.page.getByRole('button', { name: 'Desligar câmera', exact: true })).toBeEnabled();
    expect(await alice.page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([
      { audio: true, video: false }, { audio: false, video: true },
    ]);
    await alice.page.getByRole('button', { name: 'Levantar a mão', exact: true }).click();
    await bruno.page.getByRole('button', { name: 'Abrir participantes', exact: true }).click();
    await expect(bruno.page.locator('.participants-panel').getByText('Mão levantada', { exact: true })).toBeVisible();
    const closeParticipants = bruno.page.getByRole('button', { name: 'Fechar participantes', exact: true });
    expect((await closeParticipants.boundingBox())?.width).toBeLessThanOrEqual(44);
    await bruno.page.locator('.participants-panel').getByRole('button', { name: /AliceCall/ }).click();
    await expect(bruno.page.locator('.video-tile.is-pinned').getByText('AliceCall', { exact: false })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Reagir com 🎉', exact: true }).click();
    await expect(bruno.page.locator('.reaction-cloud').getByText('AliceCall', { exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Abaixar a mão', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Ativar Modo Eco', exact: true }).click();
    await expect(alice.page.getByText('Eco · vídeo reduzido', { exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
    await expect(alice.page.getByRole('button', { name: 'Parar compartilhamento', exact: true })).toBeEnabled();
    await carla.page.getByRole('button', { name: 'Entrar na chamada', exact: true }).click();
    await expectConnectedPeers(alice.page, 2); await expectConnectedPeers(bruno.page, 2); await expectConnectedPeers(carla.page, 2);
    await expect(carla.page.getByText('Compartilhando tela', { exact: true })).toBeVisible();
    await expect.poll(() => alice.page.evaluate(() => {
      const state = window as unknown as InstrumentedWindow;
      const screen = state.__displays[0].getVideoTracks()[0];
      return state.__peers.filter(peer => peer.connectionState === 'connected').every(peer => peer.getSenders().find(sender => sender.track?.kind === 'video')?.track === screen);
    })).toBe(true);
    await alice.page.getByRole('button', { name: 'Parar compartilhamento', exact: true }).click();
    await alice.page.setViewportSize({ width: 390, height: 844 });
    await alice.page.getByRole('button', { name: 'Maximizar chamada', exact: true }).click();
    await expect(alice.page.getByRole('button', { name: 'Restaurar chamada', exact: true })).toBeVisible();
    const leaveButton = alice.page.getByRole('button', { name: 'Encerrar chamada', exact: true });
    await leaveButton.scrollIntoViewIfNeeded();
    await expect(leaveButton).toBeVisible();
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await alice.page.getByRole('button', { name: 'Restaurar chamada', exact: true }).click();
    await bruno.page.getByRole('button', { name: 'Encerrar chamada', exact: true }).click();
    await expect(alice.page.getByText('BrunoCall saiu da chamada.', { exact: true })).toBeVisible();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(carla.page, 1); await expectStopped(bruno.page);
    await alice.page.getByRole('button', { name: 'Encerrar chamada', exact: true }).click();
    await carla.page.getByRole('button', { name: 'Encerrar chamada', exact: true }).click();
    await expectStopped(alice.page); await expectStopped(carla.page);
  } finally { await closeAll(contexts); }
});

test('cancelar enquanto a permissão está pendente não deixa tracks ou peers órfãos', async ({ page }) => {
  await instrument(page);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      await new Promise<void>(resolveMedia => { (window as unknown as InstrumentedWindow).__releaseMedia = resolveMedia; });
      return stream;
    };
  });
  await signup(page, 'DianaCall'); await createRoom(page, 'Sala Diana');
  await page.getByRole('button', { name: 'Iniciar chamada', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ligar câmera', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([]);
  await page.getByRole('button', { name: 'Ligar câmera', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as InstrumentedWindow).__releaseMedia))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([{ audio: false, video: true }]);
  await page.getByRole('button', { name: 'Encerrar chamada', exact: true }).click();
  await page.evaluate(() => (window as unknown as InstrumentedWindow).__releaseMedia?.());
  await expectStopped(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as InstrumentedWindow).__peers.length)).toBe(0);
});

test('layout móvel mantém login, marca, chat e anexos dentro da viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.locator('.entry-copy .nexa-logo')).toHaveCount(1);
      await expect(page.locator('.entry-page .entry-brand .nexa-logo')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }

    await page.setViewportSize({ width: 320, height: 720 });
    await signup(page, `Mobile${Date.now()}`);
    await createRoom(page, 'Sala Mobile');
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    const mark = page.locator('.mobile-drawer .nexa-mark');
    await expect(mark).toBeVisible();
    expect((await mark.boundingBox())?.width).toBeLessThanOrEqual(44);
    await page.getByRole('button', { name: 'Fechar menu' }).click();

    await page.locator('.attach-button input[type="file"]').setInputFiles({
      name: 'imagem-com-nome-bem-longo-para-validar-layout.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4x8AAAAASUVORK5CYII=', 'base64'),
    });
    await page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    const attachment = page.getByRole('button', { name: /Visualizar imagem imagem-com-nome/ });
    await expect(attachment).toBeVisible();
    const imageBox = await attachment.locator('img').boundingBox();
    const textBox = await attachment.locator('span').boundingBox();
    expect(imageBox && textBox && textBox.x >= imageBox.x + imageBox.width).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const composer = await page.locator('.composer').boundingBox();
    expect(composer && composer.x >= 0 && composer.x + composer.width <= 320).toBe(true);
  } finally { await context.close(); }
});
