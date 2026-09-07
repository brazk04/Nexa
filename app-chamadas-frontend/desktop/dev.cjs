const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vite = spawn(npmCommand, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5175'], { stdio: 'inherit' });
const electronBinary = require('electron');
let electronProcess;
let stopped = false;

function waitForVite(attempt = 0) {
  if (attempt > 50) {
    console.error('Vite não respondeu em http://127.0.0.1:5175');
    shutdown(1);
    return;
  }
  const request = http.get('http://127.0.0.1:5175/', response => {
    response.resume();
    if (response.statusCode && response.statusCode < 500) launchElectron();
    else setTimeout(() => waitForVite(attempt + 1), 200);
  });
  request.on('error', () => setTimeout(() => waitForVite(attempt + 1), 200));
}

function launchElectron() {
  if (electronProcess || stopped) return;
  electronProcess = spawn(electronBinary, [path.join(__dirname, 'main.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, NEXA_DEV_URL: 'http://127.0.0.1:5175' },
  });
  electronProcess.on('close', code => shutdown(code || 0));
}

function shutdown(code) {
  if (stopped) return;
  stopped = true;
  if (electronProcess && !electronProcess.killed) electronProcess.kill();
  if (!vite.killed) vite.kill();
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
vite.on('error', () => shutdown(1));
waitForVite();
