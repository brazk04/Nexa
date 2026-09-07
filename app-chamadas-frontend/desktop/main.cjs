const { app, BrowserWindow, desktopCapturer, session, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const DEV_URL = process.env.NEXA_DEV_URL || 'http://127.0.0.1:5175';
const DESKTOP_PORT = Number(process.env.NEXA_DESKTOP_PORT || 5173);
let staticServer;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveDist(root, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(url.parse(request.url || '/').pathname || '/');
      const requested = pathname === '/' ? '/index.html' : pathname;
      const candidate = path.resolve(root, '.' + requested);
      const safeRoot = path.resolve(root);
      const filePath = candidate.startsWith(safeRoot) ? candidate : path.join(safeRoot, 'index.html');
      const fallback = path.join(safeRoot, 'index.html');
      const send = target => {
        fs.readFile(target, (error, data) => {
          if (error) { response.writeHead(404); response.end('Not found'); return; }
          response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          response.end(data);
        });
      };
      fs.stat(filePath, (error, stats) => send(!error && stats.isFile() ? filePath : fallback));
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function createWindow() {
  const packagedRoot = path.join(__dirname, '..', 'dist');
  const isDevelopment = Boolean(process.env.NEXA_DEV_URL) || !app.isPackaged;
  let target = DEV_URL;
  if (!isDevelopment) {
    staticServer = await serveDist(packagedRoot, DESKTOP_PORT);
    target = 'http://127.0.0.1:' + DESKTOP_PORT + '/';
  }
  const iconPath = path.join(packagedRoot, 'nexa-logo.png');
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 360,
    minHeight: 600,
    show: false,
    backgroundColor: '#101116',
    icon: iconPath,
    title: 'Nexa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
    if (/^https?:\/\//i.test(externalUrl)) void shell.openExternal(externalUrl);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, nextUrl) => {
    if (!nextUrl.startsWith(target)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(nextUrl)) void shell.openExternal(nextUrl);
    }
  });
  await window.loadURL(target);
  return window;
}

function configurePermissions() {
  const allowed = new Set(['media', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
  if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      callback(sources[0] ? { video: sources[0] } : {});
    });
  }
}

app.whenReady().then(async () => {
  configurePermissions();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch(error => {
  console.error('Nexa desktop failed to start:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (staticServer) staticServer.close();
  if (process.platform !== 'darwin') app.quit();
});
