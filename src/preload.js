// Secure bridge between the renderer windows and the main process.
// The renderer never gets Node or the API key — only these named channels.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Overlay
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (next) => ipcRenderer.invoke('settings:set', next),
  getConnected: () => ipcRenderer.invoke('app:connected'),
  ask: (payload) => ipcRenderer.invoke('ai:ask', payload),
  onAiDelta: (cb) => ipcRenderer.on('ai:delta', (_e, ev) => cb(ev)),
  testConnection: (payload) => ipcRenderer.invoke('ai:test', payload),
  startCapture: () => ipcRenderer.invoke('capture:start'),
  onCaptureResult: (cb) =>
    ipcRenderer.on('capture:result', (_e, dataUrl) => cb(dataUrl)),
  openSettings: () => ipcRenderer.send('overlay:open-settings'),
  toggleClickThrough: () => ipcRenderer.send('overlay:toggle-clickthrough'),
  onClickThroughState: (cb) => ipcRenderer.on('clickthrough:state', (_e, on) => cb(on)),
  onHotkeyFailed: (cb) => ipcRenderer.on('hotkey:failed', (_e, accel) => cb(accel)),
  resizeTo: (w, h) => ipcRenderer.send('overlay:resize', { w, h }),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateEvent: (cb) => ipcRenderer.on('update:event', (_e, ev) => cb(ev)),

  // Selector window
  getSelectorImage: () => ipcRenderer.invoke('selector:image'),
  submitSelection: (rect) => ipcRenderer.send('selector:done', rect),
});
