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
} = require('electron');
const path = require('path');

const { loadSettings, saveSettings } = require('./settings-store');
const { askAI, testProvider } = require('./ai');
const { friendlyLabel, compareVersions } = require('./version');

let overlayWin = null;
let settingsWin = null;
let selectorWin = null;

// --- Overlay window ----------------------------------------------------------
function createOverlay() {
  overlayWin = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 280,
    minHeight: 200,
    x: 40,
    y: 40,
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
    title: 'EQ AI Overlay — Settings',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// --- Screen capture + region select -----------------------------------------
// Grab a full-resolution screenshot of the display the overlay is on, then show
// a frozen-frame selector the user drags a rectangle over. We crop from that
// exact captured image, so the selection maps 1:1 with no scale-factor drift.
async function captureRegion() {
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

  // Match the captured source to our display when possible.
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) return null;

  const fullImage = source.thumbnail; // NativeImage at full res
  const dataUrl = fullImage.toDataURL();

  // Show the selector with the frozen screenshot as its backdrop.
  const rect = await runSelector(display, dataUrl);
  if (!rect || rect.width < 4 || rect.height < 4) return null;

  // rect comes back in CSS pixels of the display; convert to image pixels.
  const cropped = fullImage.crop({
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  });
  return cropped.toDataURL();
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

    let settled = false;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('selector:image');
      ipcMain.removeListener('selector:done', onDone);
      if (selectorWin) {
        selectorWin.close();
        selectorWin = null;
      }
      resolve(rect);
    };

    // The selector asks for its backdrop image once loaded.
    ipcMain.handle('selector:image', () => backgroundDataUrl);
    const onDone = (_evt, rect) => finish(rect);
    ipcMain.on('selector:done', onDone);
  });
}

// --- IPC ---------------------------------------------------------------------
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, next) => {
  saveSettings(next);
  return loadSettings();
});

ipcMain.handle('capture:start', () => captureRegion());

ipcMain.handle('ai:ask', async (_e, { text, imageDataUrl }) => {
  const settings = loadSettings();
  try {
    const result = await askAI(settings, { text, imageDataUrl });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('ai:test', async (_e, { provider, cfg }) => {
  try {
    await testProvider(provider, cfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Current app version + friendly label.
ipcMain.handle('app:version', () => {
  const version = app.getVersion();
  return { version, label: friendlyLabel(version) };
});

// Check the update feed for a newer release.
ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  const base = { current, currentLabel: friendlyLabel(current) };
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
});

// Open cited source links in the user's real browser, not inside the overlay.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on('overlay:open-settings', () => openSettings());
ipcMain.on('overlay:toggle-clickthrough', (_e, enabled) => {
  if (overlayWin) overlayWin.setIgnoreMouseEvents(enabled, { forward: true });
});

// --- Lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
  createOverlay();

  const settings = loadSettings();
  const hotkey = settings.captureHotkey || 'CommandOrControl+Shift+A';
  globalShortcut.register(hotkey, async () => {
    if (!overlayWin) return;
    const img = await captureRegion();
    if (img) overlayWin.webContents.send('capture:result', img);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
