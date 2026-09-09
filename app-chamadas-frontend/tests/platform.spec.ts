import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

interface InstrumentedWindow extends Window {
  __peers: RTCPeerConnection[];
  __streams: MediaStream[];
  __displays: MediaStream[];
  __mediaRequests: { audio: boolean; video: boolean }[];
  __notificationRequests: number;
  __notifications: { title: string; body: string; tag: string }[];
  __installPromptCalls: number;
  __releaseMedia?: () => void;
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as InstrumentedWindow;
    target.__peers = []; target.__streams = []; target.__displays = []; target.__mediaRequests = [];
    target.__notificationRequests = 0; target.__notifications = [];
    target.__installPromptCalls = 0;
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission() { target.__notificationRequests += 1; FakeNotification.permission = 'granted'; return 'granted' as NotificationPermission; }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) { target.__notifications.push({ title, body: options?.body ?? '', tag: options?.tag ?? '' }); }
      close() { /* Test double. */ }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: FakeNotification });
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
        await audioContext.resume();
        const audio = destination.stream.getAudioTracks()[0]; const nativeStop = audio.stop.bind(audio);
        audio.stop = () => { oscillator.stop(); void audioContext.close(); nativeStop(); };
        tracks.push(audio);
      }
      const stream = new MediaStream(tracks); target.__streams.push(stream); return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = videoStream('#145c50'); target.__displays.push(stream); return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'mic-test-2', groupId: 'test', kind: 'audioinput', label: 'Microfone de teste 2', toJSON: () => ({}) },
      { deviceId: 'camera-test-2', groupId: 'test', kind: 'videoinput', label: 'Câmera de teste 2', toJSON: () => ({}) },
    ];
  });
}
async function signup(page: Page, username: string) {
  await page.goto('/login');
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
async function expectConnectedPeersAtLeast(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as unknown as InstrumentedWindow).__peers.filter(peer => peer.connectionState === 'connected').length)).toBeGreaterThanOrEqual(count);
}
async function expectStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as InstrumentedWindow;
    return state.__peers.every(peer => peer.connectionState === 'closed') && [...state.__streams, ...state.__displays].every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
  })).toBe(true);
}
async function expectRemoteAudio(page: Page, name: string) {
  const tile = page.locator('.video-tile').filter({ has: page.locator('.video-caption strong', { hasText: name }) });
  await expect.poll(() => tile.locator('audio').evaluate(element => {
    const video = element as HTMLVideoElement;
    const stream = video.srcObject as MediaStream | null;
    return { muted: video.muted, paused: video.paused, audio: stream?.getAudioTracks().map(track => ({ state: track.readyState, muted: track.muted })) };
  })).toEqual({ muted: false, paused: false, audio: [{ state: 'live', muted: false }] });
  await expect.poll(() => page.evaluate(async () => {
    const peers = (window as unknown as InstrumentedWindow).__peers.filter(peer => peer.connectionState === 'connected');
    const reports = await Promise.all(peers.map(peer => peer.getStats()));
    return reports.some(report => [...report.values()].some(item => item.type === 'inbound-rtp' && item.kind === 'audio' && item.totalAudioEnergy > 0 && item.packetsReceived > 0));
  })).toBe(true);
}
async function closeAll(contexts: BrowserContext[]) { await Promise.all(contexts.map(context => context.close())); }

test('idioma da landing alterna, persiste e funciona no celular', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A place for your team.Even from afar.');
  await expect(page.locator('.landing-footer')).toContainText('Conversations, meetings and teamwork.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mudar para português', exact: true })).toBeVisible();
  for (const width of [320, 375, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Mudar para português', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator('.landing-actions').getByRole('link', { name: 'Get started', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('button', { name: 'Criar conta', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.goto('/');
  await page.getByRole('button', { name: 'Mudar para português', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('O lugar da sua equipe.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Switch to English', exact: true })).toBeVisible();
});

test('capturas reais para a landing e navegação responsiva', async ({ browser }) => {
  const demo = await person(browser, 'EquipeNexa');
  try {
    await demo.page.emulateMedia({ colorScheme: 'dark' });
    await demo.page.setViewportSize({ width: 1440, height: 960 });
    await createRoom(demo.page, 'Planejamento');
    const dismiss = demo.page.getByRole('button', { name: 'Agora não', exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    for (const message of ['Bom dia, equipe! Este é o nosso espaço de planejamento.', 'Vamos reunir as ideias para a próxima entrega por aqui.', 'A pauta está na central da reunião. Depois da conversa, registramos as decisões e os próximos passos.']) {
      await demo.page.getByRole('textbox', { name: 'Mensagem para Planejamento' }).fill(message);
      await demo.page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
      await expect(demo.page.getByText(message, { exact: true })).toBeVisible();
    }
    await demo.page.screenshot({ path: 'public/screenshots/chat.png', animations: 'disabled' });
    await demo.page.getByRole('button', { name: 'Convidar e organizar' }).click();
    await demo.page.getByRole('button', { name: 'Reunião', exact: true }).click();
    await demo.page.getByPlaceholder('Novo item').fill('Alinhar prioridades da próxima entrega');
    await demo.page.getByRole('button', { name: '+ Pauta', exact: true }).click();
    await expect(demo.page.getByText('Alinhar prioridades da próxima entrega', { exact: true })).toBeVisible();
    await demo.page.screenshot({ path: 'public/screenshots/meeting.png', animations: 'disabled' });
  } finally { await demo.context.close(); }
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    for (const width of [320, 375, 390, 430, 768, 1440, 2560]) {
      await page.setViewportSize({ width, height: 960 }); await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('O lugar da sua equipe.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 800) { await page.getByRole('button', { name: 'Menu', exact: true }).click(); await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible(); }
      await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Funcionalidades' }).click();
      await expect(page).toHaveURL(/#funcionalidades$/);
    }
    await page.locator('.landing-actions').getByRole('link', { name: 'Começar agora', exact: true }).click();
    await expect(page.getByLabel('Nome de usuário', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar conta', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('cadastro verificado, salas por código, chat persistente, isolamento e logout', async ({ browser }) => {
  const alice = await person(browser, 'AliceWeb');
  const contexts = [alice.context];
  try {
    const code = await createRoom(alice.page, 'Projeto Alpha');
    const bruno = await person(browser, 'BrunoWeb', { code, name: 'Projeto Alpha' }); contexts.push(bruno.context);
    const carla = await person(browser, 'CarlaWeb'); contexts.push(carla.context);
    await expect(alice.page.getByRole('region', { name: 'Pessoas online' }).getByText('BrunoWeb', { exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Ver perfil de BrunoWeb', exact: true }).click();
    await expect(alice.page.getByRole('dialog').getByRole('heading', { name: 'BrunoWeb', exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Fechar perfil', exact: true }).click();
    await alice.page.locator('.desktop-sidebar').getByLabel('Status de presença', { exact: true }).click();
    await alice.page.locator('.desktop-sidebar').getByRole('button', { name: /Ocupado.*Pode demorar/ }).click();
    await expect(alice.page.locator('.desktop-sidebar').getByLabel('Status de presença', { exact: true })).toContainText('Ocupado');
    await expect(carla.page.getByText('Projeto Alpha', { exact: true })).toHaveCount(0);
    const message = `Mensagem autenticada ${Date.now()}`;
    await alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true }).fill(message);
    await alice.page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    await expect(alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true })).toBeFocused();
    await expect(alice.page.getByRole('log').getByText(message, { exact: true })).toHaveCount(1);
    await expect(bruno.page.getByRole('log').getByText(message, { exact: true })).toBeVisible();
    let historyReloads = 0;
    alice.page.on('request', request => { if (/\/rooms\/[^/]+\/messages(?:\?|$)/.test(request.url())) historyReloads++; });
    for (let index = 0; index < 8; index++) {
      await alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true }).fill(`Rajada ${index}`);
      await alice.page.getByLabel('Mensagem para Projeto Alpha', { exact: true }).press('Enter');
    }
    for (let index = 0; index < 8; index++) {
      await expect(alice.page.getByRole('log').getByText(`Rajada ${index}`, { exact: true })).toHaveCount(1);
      await expect(bruno.page.getByRole('log').getByText(`Rajada ${index}`, { exact: true })).toHaveCount(1);
    }
    expect(historyReloads).toBe(0);
    await alice.page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Aparência', exact: true }).click();
    await alice.page.getByLabel('Tema').selectOption('light');
    await alice.page.getByRole('button', { name: 'Salvar aparência', exact: true }).click();
    await expect(alice.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await alice.page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await bruno.page.reload();
    await expect(bruno.page.getByRole('log').getByText(message, { exact: true })).toBeVisible();
    await bruno.page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await expect(bruno.page.getByRole('heading', { level: 1 })).toContainText('O lugar da sua equipe.');
  } finally { await closeAll(contexts); }
});

test('notificações do computador, contador na aba e ações de sala', async ({ browser }) => {
  const alice = await person(browser, 'AliceNotify'); const contexts = [alice.context];
  try {
    const manifestResponse = await alice.page.request.get('/manifest.webmanifest');
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json() as { name: string; display: string; icons: { sizes: string }[] };
    expect(manifest.name).toBe('Nexa'); expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    await alice.page.evaluate(() => {
      const target = window as unknown as InstrumentedWindow;
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => { target.__installPromptCalls += 1; },
        userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
      });
      window.dispatchEvent(event);
    });
    await alice.page.getByRole('button', { name: 'Instalar Nexa', exact: true }).click();
    await expect.poll(() => alice.page.evaluate(() => (window as unknown as InstrumentedWindow).__installPromptCalls)).toBe(1);
    const firstCode = await createRoom(alice.page, 'Sala Alertas');
    const bruno = await person(browser, 'BrunoNotify', { code: firstCode, name: 'Sala Alertas' }); contexts.push(bruno.context);
    const secondCode = await createRoom(alice.page, 'Sala Atual');
    await joinRoom(bruno.page, secondCode, 'Sala Atual');
    await bruno.page.getByRole('button', { name: 'Ativar', exact: true }).click();
    await expect.poll(() => bruno.page.evaluate(() => (window as unknown as InstrumentedWindow).__notificationRequests)).toBe(1);
    await alice.page.locator('.desktop-sidebar .channel-item').filter({ hasText: 'Sala Alertas' }).click();
    await alice.page.getByLabel('Mensagem para Sala Alertas', { exact: true }).fill('Mensagem para aparecer no computador');
    await alice.page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    await expect.poll(() => bruno.page.evaluate(() => (window as unknown as InstrumentedWindow).__notifications)).toContainEqual({
      title: 'Nova mensagem de AliceNotify', body: 'Mensagem para aparecer no computador', tag: expect.any(String),
    });
    await expect(bruno.page).toHaveTitle('(1) Nexa');
    await expect(bruno.page.locator('.desktop-sidebar .channel-row').filter({ hasText: 'Sala Alertas' }).getByText('1', { exact: true })).toBeVisible();
    await bruno.page.locator('.desktop-sidebar .channel-item').filter({ hasText: 'Sala Alertas' }).click();
    await expect(bruno.page).toHaveTitle('Nexa');

    await bruno.page.getByRole('button', { name: 'Convidar e organizar', exact: true }).click();
    await bruno.page.getByRole('button', { name: 'Sala', exact: true }).click();
    await bruno.page.getByRole('button', { name: 'Sair da sala', exact: true }).click();
    await bruno.page.locator('.confirm-dialog').getByRole('button', { name: 'Sair da sala', exact: true }).click();
    await expect(bruno.page.locator('.channel-item').filter({ hasText: 'Sala Alertas' })).toHaveCount(0);

    await alice.page.getByRole('button', { name: 'Convidar e organizar', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Sala', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Excluir sala', exact: true }).click();
    await alice.page.locator('.confirm-dialog').getByRole('button', { name: 'Excluir definitivamente', exact: true }).click();
    await expect(alice.page.locator('.channel-item').filter({ hasText: 'Sala Alertas' })).toHaveCount(0);
  } finally { await closeAll(contexts); }
});

test('WebRTC mesh com três pessoas, compartilhamento tardio, saída isolada e maximização', async ({ browser }) => {
  test.setTimeout(140_000);
  const alice = await person(browser, 'AliceCall'); const contexts = [alice.context];
  try {
    const code = await createRoom(alice.page, 'Sala Mesh');
    await alice.page.getByRole('button', { name: 'Iniciar chamada', exact: true }).click();
    const bruno = await person(browser, 'BrunoCall', { code, name: 'Sala Mesh' }); contexts.push(bruno.context);
    await expect(bruno.page.getByRole('button', { name: 'Entrar na chamada', exact: true })).toBeVisible();
    await bruno.page.getByRole('button', { name: 'Entrar na chamada', exact: true }).click();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(bruno.page, 1);
    await createRoom(alice.page, 'Sala Paralela');
    await expect(alice.page.getByText('Chamada conectada', { exact: true })).toBeVisible();
    await alice.page.getByLabel('Mensagem para Sala Paralela', { exact: true }).fill('A chamada da Sala Mesh continua ativa.');
    await alice.page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    await expect(alice.page.getByText('A chamada da Sala Mesh continua ativa.', { exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'Iniciar chamada', exact: true }).click();
    await expect(alice.page.getByText('Você já está em uma chamada em outra sala. Saia da chamada atual antes de entrar em outra.', { exact: true })).toBeVisible();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(bruno.page, 1);
    await alice.page.locator('.desktop-sidebar .channel-item').filter({ hasText: 'Sala Mesh' }).click();
    await expect(alice.page.locator('.room-header').getByRole('heading', { name: 'Sala Mesh' })).toBeVisible();
    await expectConnectedPeers(alice.page, 1);
    const carla = await person(browser, 'CarlaCall', { code, name: 'Sala Mesh' }); contexts.push(carla.context);
    expect(await alice.page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([]);
    expect(await bruno.page.evaluate(() => (window as unknown as InstrumentedWindow).__mediaRequests)).toEqual([]);
    await alice.page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
    await expect(alice.page.getByRole('button', { name: 'Silenciar microfone', exact: true })).toBeEnabled();
    await bruno.page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
    await expectRemoteAudio(bruno.page, 'AliceCall'); await expectRemoteAudio(alice.page, 'BrunoCall');
    await alice.page.getByRole('button', { name: 'Silenciar microfone', exact: true }).click();
    expect(await alice.page.evaluate(() => (window as unknown as InstrumentedWindow).__streams.flatMap(stream => stream.getAudioTracks()).every(track => !track.enabled))).toBe(true);
    await alice.page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
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
    await alice.context.setOffline(true);
    await expect(alice.page.getByText('Sua conexão caiu. Tentando reconectar…', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bruno.page.getByText('AliceCall perdeu a conexão. Aguardando reconexão…', { exact: true })).toBeVisible({ timeout: 30_000 });
    // The signaling socket is offline, but an already-established WebRTC path may
    // remain connected. The other participants must stay together either way.
    await expectConnectedPeersAtLeast(bruno.page, 1); await expectConnectedPeersAtLeast(carla.page, 1);
    await expect(bruno.page.getByText('AliceCall saiu da chamada.', { exact: true })).toHaveCount(0);
    await expect(carla.page.getByText('AliceCall saiu da chamada.', { exact: true })).toHaveCount(0);
    await alice.context.setOffline(false);
    await expect(alice.page.getByText('Conexão restabelecida.', { exact: true })).toBeVisible();
    await expect(bruno.page.getByText('AliceCall se reconectou.', { exact: true })).toBeVisible();
    await expectConnectedPeers(alice.page, 2); await expectConnectedPeers(bruno.page, 2); await expectConnectedPeers(carla.page, 2);
    await expect(alice.page.getByText('Conexão restabelecida.', { exact: true })).toHaveCount(0, { timeout: 7_000 });
    await expect(bruno.page.getByText('AliceCall se reconectou.', { exact: true })).toHaveCount(0, { timeout: 7_000 });
    await expect(carla.page.getByText('Compartilhando tela', { exact: true })).toBeVisible();
    await expectRemoteAudio(carla.page, 'AliceCall'); await expectRemoteAudio(bruno.page, 'AliceCall');
    await alice.page.getByRole('button', { name: 'Silenciar microfone', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Áudio e vídeo', exact: true }).click();
    await alice.page.getByRole('combobox', { name: /^Microfone/ }).selectOption('mic-test-2');
    await alice.page.getByRole('combobox', { name: /^Câmera/ }).selectOption('camera-test-2');
    await alice.page.getByRole('button', { name: 'Salvar dispositivos', exact: true }).click();
    await expect.poll(() => alice.page.evaluate(() => {
      const target = window as unknown as InstrumentedWindow;
      const tracks = target.__streams.flatMap(stream => stream.getAudioTracks());
      const latest = tracks.at(-1);
      return tracks.length === 2 && tracks[0].readyState === 'ended' && latest?.enabled === false && target.__peers.filter(peer => peer.connectionState === 'connected').every(peer => peer.getSenders().some(sender => sender.track === latest));
    })).toBe(true);
    await alice.page.getByRole('dialog', { name: 'Configurações' }).getByRole('button', { name: 'Fechar', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Ativar microfone', exact: true }).click();
    await expectRemoteAudio(carla.page, 'AliceCall');
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
    await expectRemoteAudio(carla.page, 'AliceCall');
    const disconnected = await alice.page.request.post('http://127.0.0.1:3355/__test/disconnect/AliceCall');
    expect(disconnected.ok()).toBe(true);
    await expect(alice.page.getByText('Conexão restabelecida.', { exact: true })).toBeVisible();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(carla.page, 1);
    await expect(alice.page.getByRole('button', { name: 'Silenciar microfone', exact: true })).toBeVisible();
    await expectRemoteAudio(carla.page, 'AliceCall');
    await Promise.all([alice.page, carla.page].map(page => page.evaluate(() => {
      (window as unknown as InstrumentedWindow).__peers.filter(peer => peer.connectionState === 'connected').forEach(peer => {
        peer.close(); peer.dispatchEvent(new Event('connectionstatechange'));
      });
    })));
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(carla.page, 1);
    await expect(alice.page.getByText('CarlaCall saiu da chamada.', { exact: true })).toHaveCount(0);
    await expect(carla.page.getByText('AliceCall saiu da chamada.', { exact: true })).toHaveCount(0);
    const simultaneous = await alice.page.request.post('http://127.0.0.1:3355/__test/disconnect-call', { data: { usernames: ['AliceCall', 'CarlaCall'] } });
    expect(simultaneous.ok()).toBe(true); expect((await simultaneous.json() as { disconnected: number }).disconnected).toBe(2);
    await expect(alice.page.getByText('Sua conexão caiu. Tentando reconectar…', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(carla.page.getByText('Sua conexão caiu. Tentando reconectar…', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(alice.page.getByText('Conexão restabelecida.', { exact: true })).toBeVisible();
    await expect(carla.page.getByText('Conexão restabelecida.', { exact: true })).toBeVisible();
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(carla.page, 1);
    await expect(alice.page.getByText('CarlaCall saiu da chamada.', { exact: true })).toHaveCount(0);
    await expect(carla.page.getByText('AliceCall saiu da chamada.', { exact: true })).toHaveCount(0);
    await alice.page.reload();
    await expect(alice.page.getByText('Conexão restabelecida.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expectConnectedPeers(alice.page, 1); await expectConnectedPeers(carla.page, 1);
    await alice.page.getByRole('button', { name: 'Encerrar chamada', exact: true }).click();
    await expect(carla.page.getByText('AliceCall saiu da chamada.', { exact: true })).toBeVisible();
    await expect(carla.page.getByText('Aguardando participantes', { exact: true })).toBeVisible();
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
      await page.goto('/login');
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
    const textBox = await attachment.locator(':scope > span:last-child').boundingBox();
    expect(imageBox && textBox && textBox.x >= imageBox.x + imageBox.width).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const composer = await page.locator('.composer').boundingBox();
    expect(composer && composer.x >= 0 && composer.x + composer.width <= 320).toBe(true);
  } finally { await context.close(); }
});

test('imagens reais, lightbox, download, fallback e bloqueio antecipado de uploads', async ({ browser }) => {
  const personA = await person(browser, `Images${Date.now()}`); const { page } = personA;
  try {
    await createRoom(page, 'Imagens');
    for (const [extension, mimeType] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
      const encoded = await page.evaluate(type => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
        canvas.getContext('2d')!.fillRect(0, 0, 32, 24); return canvas.toDataURL(type).split(',')[1];
      }, mimeType);
      const name = `preview.${extension}`;
      await page.locator('.attach-button input').setInputFiles({ name, mimeType, buffer: Buffer.from(encoded, 'base64') });
      await page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
      const button = page.getByRole('button', { name: `Visualizar imagem ${name}`, exact: true });
      await expect.poll(() => button.locator('img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth === 32))).toBe(true);
      await button.click();
      await expect.poll(() => page.locator('.image-lightbox-stage img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth === 32))).toBe(true);
      const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar imagem', exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe(name);
      await page.getByRole('button', { name: 'Fechar visualização' }).click();
    }
    let uploads = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/attachments')) uploads++; });
    for (const [name, mimeType, label] of [['large.mp4', 'video/mp4', 'O vídeo'], ['large.pdf', 'application/pdf', 'O arquivo']]) {
      await page.locator('.attach-button input').setInputFiles({ name, mimeType, buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
      await expect(page.getByRole('alert').filter({ hasText: label })).toContainText('4 MB');
      await expect(page.getByRole('button', { name: 'Enviar mensagem', exact: true })).toBeDisabled();
    }
    expect(uploads).toBe(0);
    await page.route('**/attachments/*/download', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.reload();
    await expect(page.getByText('Imagem indisponível', { exact: true })).toHaveCount(3);
    await page.getByRole('button', { name: 'Visualizar imagem preview.jpg', exact: true }).click();
    await expect(page.locator('.image-lightbox').getByRole('alert')).toContainText('Não foi possível carregar');
    await expect(page.getByRole('button', { name: 'Baixar imagem', exact: true })).toBeEnabled();
  } finally { await personA.context.close(); }
});
