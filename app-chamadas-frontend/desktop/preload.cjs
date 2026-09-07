const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('nexaDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
}));
