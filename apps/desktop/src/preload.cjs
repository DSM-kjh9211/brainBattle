/**
 * Preload (sandboxed): exposes a minimal, typed bridge to the shared web client.
 * The web app detects `window.brainbattleDesktop` (apps/web/src/core/platform.ts).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brainbattleDesktop', {
  isDesktop: true,
  platform: process.platform,
  openPresentation: (url) => ipcRenderer.invoke('bb:openPresentation', String(url)),
  closePresentation: () => ipcRenderer.invoke('bb:closePresentation'),
  listDisplays: () => ipcRenderer.invoke('bb:listDisplays'),
  toggleFullscreen: () => ipcRenderer.invoke('bb:toggleFullscreen'),
  setServerUrl: (url) => ipcRenderer.invoke('bb:setServerUrl', String(url)),
});
