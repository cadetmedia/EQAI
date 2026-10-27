// Renderer logic for the overlay panel. Talks to main only through window.api.
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const pendingThumb = document.getElementById('pending-thumb');
const thumbImg = document.getElementById('thumb');

let pendingImage = null; // data URL of a captured region waiting to be sent

function addMessage(role, text, imageDataUrl) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.src = imageDataUrl;
    el.appendChild(img);
  }
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function setPendingImage(dataUrl) {
  pendingImage = dataUrl;
  if (dataUrl) {
    thumbImg.src = dataUrl;
    pendingThumb.classList.remove('hidden');
  } else {
    pendingThumb.classList.add('hidden');
  }
}

async function send() {
  const text = inputEl.value.trim();
  if (!text && !pendingImage) return;

  // Make sure an account is linked before spending a (their) API call.
  if (!connected) {
    await checkConnection();
    if (!connected) {
      showConnectPrompt();
      return;
    }
  }

  addMessage('user', text, pendingImage);
  const imageToSend = pendingImage;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  setPendingImage(null);

  const thinking = addMessage('ai thinking', 'Searching EverQuest Legends sources…');
  const res = await window.api.ask({ text, imageDataUrl: imageToSend });
  thinking.remove();

  if (res.ok) {
    renderAnswer(res);
  } else {
    addMessage('error', `⚠ ${res.error}`);
  }
}

// Render an AI answer with a source-trust banner and clickable citations.
function renderAnswer(res) {
  const el = document.createElement('div');
  el.className = 'msg ai';

  // Banner: guaranteed by the app based on the cited domains.
  const banner = document.createElement('div');
  if (!res.searched || !res.citations.length) {
    banner.className = 'srcbanner warn';
    banner.textContent = '⚠ No sources cited — this may be general knowledge, not verified for EverQuest Legends.';
  } else if (res.usedOutside) {
    banner.className = 'srcbanner warn';
    banner.textContent = '⚠ Went OUTSIDE your trusted sources — see flagged links below.';
  } else {
    banner.className = 'srcbanner ok';
    banner.textContent = '✓ Answered from your trusted EverQuest Legends sources.';
  }
  el.appendChild(banner);

  const body = document.createElement('div');
  body.className = 'answer';
  body.textContent = res.answer || '(empty response)';
  el.appendChild(body);

  if (res.citations && res.citations.length) {
    const srcWrap = document.createElement('div');
    srcWrap.className = 'sources';
    const head = document.createElement('div');
    head.className = 'sources-head';
    head.textContent = 'Sources';
    srcWrap.appendChild(head);

    for (const c of res.citations) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const tag = document.createElement('span');
      tag.className = 'tag ' + (c.trusted ? 'trusted' : 'outside');
      tag.textContent = c.trusted ? 'trusted' : 'outside';
      const link = document.createElement('a');
      link.href = c.url;
      link.className = 'source-link';
      link.textContent = c.title || c.host || c.url;
      link.title = c.url;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openExternal(c.url);
      });
      row.appendChild(tag);
      row.appendChild(link);
      srcWrap.appendChild(row);
    }
    el.appendChild(srcWrap);
  }

  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function capture() {
  const dataUrl = await window.api.startCapture();
  if (dataUrl) {
    setPendingImage(dataUrl);
    inputEl.focus();
    if (!inputEl.value) inputEl.placeholder = 'Ask about this capture… (or just Send)';
  }
}

// --- Wiring ------------------------------------------------------------------
document.getElementById('btn-send').addEventListener('click', send);
document.getElementById('btn-capture').addEventListener('click', capture);
document.getElementById('btn-settings').addEventListener('click', () => window.api.openSettings());
document.getElementById('btn-clear').addEventListener('click', () => {
  messagesEl.innerHTML = '';
  setPendingImage(null);
});
document.getElementById('thumb-remove').addEventListener('click', () => setPendingImage(null));

// Click-through: when active, mouse events pass to the game. The title bar stays
// interactive via a short grace toggle (click the button again to regain control).
const ctBtn = document.getElementById('btn-clickthrough');
let clickThrough = false;
ctBtn.addEventListener('click', () => {
  clickThrough = !clickThrough;
  ctBtn.classList.toggle('active', clickThrough);
  window.api.setClickThrough(clickThrough);
});

// Enter sends; Shift+Enter makes a newline. Auto-grow the textarea.
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// Captures triggered by the global hotkey land here.
window.api.onCaptureResult((dataUrl) => {
  setPendingImage(dataUrl);
  inputEl.focus();
});

// --- Account connection state -----------------------------------------------
let connected = false;

async function checkConnection() {
  try {
    const s = await window.api.getSettings();
    const cfg = (s && s[s.provider]) || {};
    connected = Boolean(cfg.apiKey);
  } catch {
    connected = false;
  }
  return connected;
}

function showConnectPrompt() {
  const el = document.createElement('div');
  el.className = 'msg ai';
  const p = document.createElement('div');
  p.textContent =
    'Welcome to EQAI! To start, connect your own AI account — your key stays on this ' +
    'PC and all usage is billed to your account. Click below, pick a provider, paste a ' +
    'key, then hit "Test connection".';
  el.appendChild(p);
  const btn = document.createElement('button');
  btn.textContent = '⚙ Connect your AI account';
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => window.api.openSettings());
  el.appendChild(btn);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showReady() {
  addMessage('ai', 'EQAI is ready, traveler. Ask a question about EverQuest Legends, or hit 📷 (Ctrl+Shift+A) to capture part of the screen and ask about it. Every answer is searched from your trusted sources and cited.');
}

// Show an "update available" banner with a Download button.
function showUpdateBanner(res) {
  const el = document.createElement('div');
  el.className = 'msg ai update';
  const p = document.createElement('div');
  p.innerHTML =
    `⬆ <b>Update available:</b> ${res.latestLabel} ` +
    `<span style="color:var(--amber-dim)">(you have ${res.currentLabel})</span>`;
  el.appendChild(p);
  if (res.notes) {
    const n = document.createElement('div');
    n.style.cssText = 'margin-top:4px;color:var(--amber-dim);font-size:12px;';
    n.textContent = res.notes;
    el.appendChild(n);
  }
  if (res.url) {
    const btn = document.createElement('button');
    btn.textContent = '⬇ Download update';
    btn.addEventListener('click', () => window.api.openExternal(res.url));
    el.appendChild(btn);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function autoCheckUpdate() {
  try {
    const res = await window.api.checkUpdate();
    if (res && res.updateAvailable) showUpdateBanner(res);
  } catch {
    /* silent on launch — the manual button in Settings reports errors */
  }
}

// A single reusable banner for the installed build's silent-update progress.
let updBannerEl = null;
function updBanner() {
  if (!updBannerEl || updBannerEl.parentNode !== messagesEl) {
    updBannerEl = document.createElement('div');
    updBannerEl.className = 'msg ai update';
    messagesEl.appendChild(updBannerEl);
  }
  updBannerEl.innerHTML = '';
  return updBannerEl;
}

function handleUpdateEvent(ev) {
  if (!ev) return;
  if (ev.state === 'downloading') {
    const el = updBanner();
    const p = document.createElement('div');
    p.textContent = `⬇ Downloading update${ev.label ? ' ' + ev.label : ''}…`;
    el.appendChild(p);
  } else if (ev.state === 'ready') {
    const el = updBanner();
    const p = document.createElement('div');
    p.innerHTML = `✅ <b>Update ready${ev.label ? ': ' + ev.label : ''}</b> — restart to apply.`;
    el.appendChild(p);
    const btn = document.createElement('button');
    btn.textContent = '↻ Restart & install';
    btn.addEventListener('click', () => window.api.installUpdate());
    el.appendChild(btn);
  }
  // 'none' / 'error' are surfaced by the manual check in Settings, not here.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

(async () => {
  let autoUpdate = false;
  try {
    const v = await window.api.getVersion();
    document.getElementById('version').textContent = v.label;
    autoUpdate = !!v.autoUpdate;
  } catch { /* ignore */ }

  await checkConnection();
  if (connected) showReady();
  else showConnectPrompt();

  if (autoUpdate) {
    // Installed build: electron-updater downloads in the background and emits
    // events; we just listen and prompt to restart when it's ready.
    window.api.onUpdateEvent(handleUpdateEvent);
  } else {
    // Portable / dev: lightweight latest.json check with a download link.
    autoCheckUpdate();
  }
})();

// After connecting in Settings, returning focus to the overlay refreshes state.
window.addEventListener('focus', async () => {
  if (connected) return;
  const was = connected;
  await checkConnection();
  if (connected && !was) {
    messagesEl.innerHTML = '';
    showReady();
  }
});
