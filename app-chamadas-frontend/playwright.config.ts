import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    launchOptions: { args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--allow-http-screen-capture',
    ] },
  },
  webServer: [
    { command: 'node --require ./tests/windows-user-shim.cjs --import tsx ./tests/e2e-server.ts', cwd: '../app-chamadas-backend', url: 'http://127.0.0.1:3355/health',
      env: { CORS_ORIGIN: 'http://127.0.0.1:5175', FRONTEND_URL: 'http://127.0.0.1:5175' }, reuseExistingServer: true },
    { command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175 --strictPort', url: 'http://127.0.0.1:5175',
      env: { VITE_API_URL: 'http://127.0.0.1:3355', VITE_SOCKET_URL: 'http://127.0.0.1:3355' }, reuseExistingServer: true },
  ],
});
