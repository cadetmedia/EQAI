// Main process: creates the overlay window, handles the global hotkey,
// performs the screen capture + region crop, and proxies AI requests so the
// API key never lives in the renderer.
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  screen,
  nativeImage,
  shell,
  Menu,
  dialog,
} = require('electron');
const path = require('path');

// Standard clipboard shortcuts (Ctrl+C/V/X/A) only work when an Edit menu with
// those roles exists. Our windows are frameless / menu-hidden, so register a
// minimal app menu for the accelerators and a right-click Paste menu for inputs.
function enableClipboard(win) {
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' });
      items.push({ type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// Security: never let a window navigate away from our bundled pages or spawn a
// new Electron window. External links are handed to the system browser instead.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

// Click-through state (shared by the 👆 button and a global toggle hotkey).
let clickThrough = false;
function setClickThrough(on) {
  clickThrough = !!on;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlayWin.webContents.send('clickthrough:state', clickThrough);
  }
}

let capturing = false; // guards against re-entrant captures

// Start/refresh the EQ log reader from settings (auto-discovers when unset).
function startLogReader() {
  const dir = loadSettings().eqLogDir || logReader.autodiscoverDir();
  logReader.start(dir, (c) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('log:context', c);
  });
}

const { loadSettings, saveSettings } = require('./settings-store');
const { askAI, testProvider, listModels } = require('./ai');
const { friendlyLabel, compareVersions } = require('./version');
const logReader = require('./log-reader');
const knowledge = require('./knowledge');
const { autoUpdater } = require('electron-updater');

// Silent auto-update only applies to the INSTALLED build. The portable exe can't
// replace itself, and dev runs aren't packaged, so those fall back to the
// lightweight latest.json check + a "download" link.
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const CAN_AUTO_UPDATE = app.isPackaged && !IS_PORTABLE;

let overlayWin = null;
let settingsWin = null;
let selectorWin = null;

// Use remembered bounds only if they still fall on a visible display.
function savedOverlayBounds() {
  const b = loadSettings().windowBounds;
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + 40 >= w.x && b.y + 20 >= w.y &&
      b.x + 40 <= w.x + w.width && b.y + 20 <= w.y + w.height;
  });
  return {
    width: Math.max(280, b.width),
    height: Math.max(200, b.height),
    ...(onScreen && typeof b.x === 'number' ? { x: b.x, y: b.y } : {}),
  };
}

let saveBoundsTimer = null;
function persistOverlayBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      saveSettings({ windowBounds: overlayWin.getBounds() });
    }
  }, 500);
}

// --- Overlay window ----------------------------------------------------------
function createOverlay() {
  const saved = savedOverlayBounds();
  overlayWin = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 280,
    minHeight: 200,
    x: 40,
    y: 40,
    ...saved, // remembered size/position, when valid
    frame: false, // no title bar; we draw our own
    transparent: true, // let the rounded corners / translucency show through
    resizable: true, // drag any edge to resize
    alwaysOnTop: true, // float above the game
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep it above full-screen-ish windows too.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  enableClipboard(overlayWin);
  hardenWindow(overlayWin);

  // Remember where the user puts it / sizes it.
  overlayWin.on('moved', persistOverlayBounds);
  overlayWin.on('resize', persistOverlayBounds);
}

// --- Settings window ---------------------------------------------------------
function openSettings() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 520,
    title: 'EQAI — Settings',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  enableClipboard(settingsWin);
  hardenWindow(settingsWin);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// --- Screen capture + region select -----------------------------------------
// Grab a full-resolution screenshot of the display the overlay is on, then show
// a frozen-frame selector the user drags a rectangle over. We crop from that
// exact captured image, so the selection maps 1:1 with no scale-factor drift.
async function captureRegion() {
  if (capturing || !overlayWin) return null; // ignore re-entrant triggers
  capturing = true;
  try {
    const display = screen.getDisplayMatching(overlayWin.getBounds());
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;

    // Hide our own UI so it isn't in the shot.
    const wasVisible = overlayWin.isVisible();
    overlayWin.hide();
    await new Promise((r) => setTimeout(r, 150));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (wasVisible) overlayWin.show();

    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) return null;

    const fullImage = source.thumbnail;
    const dataUrl = fullImage.toDataURL();

    const rect = await runSelector(display, dataUrl);
    if (!rect || rect.width < 4 || rect.height < 4) return null;

    const cropped = fullImage.crop({
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    });
    return cropped.toDataURL();
  } finally {
    capturing = false;
  }
}

function runSelector(display, backgroundDataUrl) {
  return new Promise((resolve) => {
    selectorWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    selectorWin.setAlwaysOnTop(true, 'screen-saver');
    selectorWin.loadFile(path.join(__dirname, 'selector.html'));
    hardenWindow(selectorWin);

    let settled = false;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('selector:image');
      ipcMain.removeListener('selector:done', onDone);
      if (selectorWin && !selectorWin.isDestroyed()) {
        selectorWin.removeListener('closed', onClosed);
        selectorWin.close();
      }
      selectorWin = null;
      resolve(rect);
    };

    // The selector asks for its backdrop image once loaded.
    ipcMain.handle('selector:image', () => backgroundDataUrl);
    const onDone = (_evt, rect) => finish(rect);
    ipcMain.on('selector:done', onDone);
    // Closing the selector (Alt+F4 / Esc) must still resolve the promise.
    const onClosed = () => finish(null);
    selectorWin.on('closed', onClosed);
  });
}

// --- IPC ---------------------------------------------------------------------
const PROVIDER_NAMES = ['claude', 'openai', 'gemini'];

// Return settings WITHOUT the raw keys: each provider gets a boolean hasKey and
// an empty apiKey, so no renderer ever receives a secret.
function maskedSettings(s) {
  const m = JSON.parse(JSON.stringify(s));
  for (const p of PROVIDER_NAMES) {
    m[p].hasKey = !!s[p].apiKey;
    m[p].apiKey = '';
  }
  return m;
}

ipcMain.handle('settings:get', () => maskedSettings(loadSettings()));

// Overlay only needs a yes/no — never the key material.
ipcMain.handle('app:connected', () => {
  const s = loadSettings();
  const cfg = s[s.provider] || {};
  return { connected: !!cfg.apiKey, provider: s.provider };
});

ipcMain.handle('settings:set', (_e, next) => {
  const current = loadSettings();
  const merged = { ...next };
  // A blank key field means "unchanged" (the renderer never had the real key).
  for (const p of PROVIDER_NAMES) {
    if (merged[p] && !merged[p].apiKey) {
      merged[p] = { ...merged[p], apiKey: current[p].apiKey };
    }
  }
  const saved = saveSettings(merged);
  if (next.captureHotkey && next.captureHotkey !== current.captureHotkey) {
    registerCaptureHotkey(saved.captureHotkey);
  }
  if (next.eqLogDir !== undefined && next.eqLogDir !== current.eqLogDir) {
    startLogReader();
  }
  return maskedSettings(saved);
});

ipcMain.handle('log:get', () => logReader.getContext());

ipcMain.handle('dialog:pick-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('capture:start', () => captureRegion());

// The next wider search tier the user can choose to escalate to.
function nextScope(scope, settings) {
  if (scope === 'trusted') return (settings.closeSources && settings.closeSources.length) ? 'close' : 'outside';
  if (scope === 'close') return 'outside';
  return null;
}

ipcMain.handle('ai:ask', async (e, { text, imageDataUrl, history, reqId, forceFresh, scope = 'trusted' }) => {
  const settings = loadSettings();
  const lc = logReader.getContext();
  const zone = lc.zone || '';

  // Instant, free repeats from the local cache (only the initial trusted ask).
  if (scope === 'trusted' && !imageDataUrl && !forceFresh) {
    const cached = knowledge.getCachedAnswer(text, zone);
    if (cached) return { ok: true, ...cached, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const onDelta = (chunk) => {
      try { e.sender.send('ai:delta', { id: reqId, chunk }); } catch { /* window gone */ }
    };
    const references = await knowledge.groundingFor(text, lc, settings.useWiki !== false);
    const result = await askAI(
      settings,
      { text, imageDataUrl, history, logContext: lc.summary, references, scope, signal: controller.signal },
      onDelta
    );
    const escalateTo = result.notFound ? nextScope(scope, settings) : null;
    if (!result.notFound && !imageDataUrl && result.answer) knowledge.putCachedAnswer(text, zone, result);
    return { ok: true, ...result, escalateTo };
  } catch (err) {
    const msg = controller.signal.aborted ? 'Request timed out (90s).' : (err.message || String(err));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('ai:test', async (_e, { provider, cfg }) => {
  try {
    const c = { ...cfg };
    // Fall back to the saved key/model when the field was left blank (masked).
    const saved = loadSettings()[provider] || {};
    if (!c.apiKey) c.apiKey = saved.apiKey || '';
    if (!c.model) c.model = saved.model || '';
    await testProvider(provider, c);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('ai:models', async (_e, { provider, cfg }) => {
  try {
    const c = { ...cfg };
    if (!c.apiKey) c.apiKey = (loadSettings()[provider] || {}).apiKey || '';
    const models = await listModels(provider, c);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Current app version + friendly label + which update mode is in effect.
ipcMain.handle('app:version', () => {
  const version = app.getVersion();
  return { version, label: friendlyLabel(version), autoUpdate: CAN_AUTO_UPDATE, portable: IS_PORTABLE };
});

// Portable / dev fallback: read latest.json and compare versions ourselves.
async function checkLatestJson() {
  const current = app.getVersion();
  const base = { current, currentLabel: friendlyLabel(current), mode: 'manual' };
  const url = loadSettings().updateFeedUrl;
  if (!url) return { ...base, error: 'No update server is configured.' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return { ...base, error: `Update check failed (${res.status}).` };
    const feed = await res.json();
    if (!feed || !feed.version) return { ...base, error: 'Update server returned no version.' };
    const updateAvailable = compareVersions(feed.version, current) > 0;
    return {
      ...base,
      latest: feed.version,
      latestLabel: feed.label || friendlyLabel(feed.version),
      updateAvailable,
      url: feed.url || '',
      notes: feed.notes || '',
    };
  } catch {
    return { ...base, error: 'Could not reach the update server.' };
  }
}

// Manual "Check for updates". Installed build hands off to electron-updater
// (which downloads silently and emits events); everything else uses latest.json.
ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  if (CAN_AUTO_UPDATE) {
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      sendUpdateEvent({ state: 'error', error: err.message || String(err) });
    }
    return { mode: 'auto', current, currentLabel: friendlyLabel(current) };
  }
  return checkLatestJson();
});

// Installed build: apply the downloaded update now. (true, true) = silent
// install (no wizard/UAC thanks to the per-user one-click installer) then relaunch.
ipcMain.on('update:install', () => {
  if (CAN_AUTO_UPDATE) autoUpdater.quitAndInstall(true, true);
});

function sendUpdateEvent(ev) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('update:event', ev);
  }
}

// Wire electron-updater for the installed build: download silently, then prompt
// the user to restart to apply.
function setupAutoUpdater() {
  if (!CAN_AUTO_UPDATE) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    sendUpdateEvent({ state: 'downloading', version: info.version, label: friendlyLabel(info.version) });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateEvent({ state: 'none' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent({ state: 'ready', version: info.version, label: friendlyLabel(info.version) });
  });
  autoUpdater.on('error', (err) => {
    sendUpdateEvent({ state: 'error', error: (err && err.message) || String(err) });
  });

  // Check shortly after launch (give the overlay time to attach its listener).
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
}

// Open cited source links in the user's real browser, not inside the overlay.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on('overlay:open-settings', () => openSettings());
ipcMain.on('overlay:toggle-clickthrough', () => setClickThrough(!clickThrough));

// Resize driven by the in-UI corner grip. Clamp to the window's minimums.
ipcMain.on('overlay:resize', (_e, { w, h }) => {
  if (!overlayWin) return;
  overlayWin.setSize(Math.max(280, Math.round(w)), Math.max(200, Math.round(h)));
});

// (Re)register the capture hotkey; returns false if the OS rejected it.
let captureHotkeyAccel = null;
function registerCaptureHotkey(accel) {
  if (captureHotkeyAccel) {
    try { globalShortcut.unregister(captureHotkeyAccel); } catch { /* ignore */ }
    captureHotkeyAccel = null;
  }
  const target = accel || 'CommandOrControl+Shift+A';
  let ok = false;
  try {
    ok = globalShortcut.register(target, async () => {
      if (!overlayWin) return;
      const img = await captureRegion();
      if (img) overlayWin.webContents.send('capture:result', img);
    });
  } catch { ok = false; }
  if (ok) captureHotkeyAccel = target;
  if (!ok && overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('hotkey:failed', target);
  }
  return ok;
}

// --- Lifecycle ---------------------------------------------------------------
// Single-instance lock: a second launch just focuses the existing overlay.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (overlayWin.isMinimized()) overlayWin.restore();
      overlayWin.show();
      overlayWin.focus();
    }
  });

  app.whenReady().then(() => {
    // A minimal menu with edit roles registers the Ctrl+C/V/X/A accelerators.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));

    createOverlay();
    setupAutoUpdater();
    startLogReader();

    registerCaptureHotkey(loadSettings().captureHotkey);
    // Toggle click-through from anywhere, so it can never trap the user.
    globalShortcut.register('CommandOrControl+Shift+X', () => setClickThrough(!clickThrough));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createOverlay();
    });
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); logReader.stop(); });
  app.on('window-all-closed', () => app.quit());
}
