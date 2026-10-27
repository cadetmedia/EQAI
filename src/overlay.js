// Renderer logic for the overlay panel. Talks to main only through window.api.
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const pendingThumb = document.getElementById('pending-thumb');
const thumbImg = document.getElementById('thumb');

let pendingImage = null; // data URL of a captured region waiting to be sent

// Conversation memory: prior turns sent with each question so follow-ups keep
// context. Capped to keep token use reasonable. Reset by the Clear button.
let history = [];
const MAX_HISTORY = 12;

// The answer element currently being streamed into (receives ai:delta chunks).
let activeAnswerSpan = null;

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

// --- Minimal, safe markdown -> HTML (escapes first, then adds our own tags) ---
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function inlineMd(s) {
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="#" data-url="${u}">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_m, pre, u) => `${pre}<a href="#" data-url="${u}">${u}</a>`);
  return s;
}
function renderMarkdown(text) {
  const lines = escapeHtml(text || '').split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeBuf = [];
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) { html += `<pre><code>${codeBuf.join('\n')}</code></pre>`; codeBuf = []; inCode = false; }
      else { closeLists(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeLists(); html += `<div class="md-h">${inlineMd(h[2])}</div>`; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += `<li>${inlineMd(ul[1])}</li>`; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += `<li>${inlineMd(ol[1])}</li>`; continue; }
    if (line.trim() === '') { closeLists(); html += '<div class="md-gap"></div>'; continue; }
    closeLists();
    html += `<div>${inlineMd(line)}</div>`;
  }
  if (inCode) html += `<pre><code>${codeBuf.join('\n')}</code></pre>`;
  closeLists();
  return html;
}

// Cited/markdown links open in the real browser.
messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); window.api.openExternal(a.dataset.url); }
});

function setPendingImage(dataUrl) {
  pendingImage = dataUrl;
  if (dataUrl) {
    thumbImg.src = dataUrl;
    pendingThumb.classList.remove('hidden');
  } else {
    pendingThumb.classList.add('hidden');
  }
}

async function send(presetText) {
  const text = (presetText != null ? presetText : inputEl.value).trim();
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
  if (presetText == null) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }
  setPendingImage(null);

  // Create the answer bubble; streamed tokens land in `body` as they arrive.
  const el = document.createElement('div');
  el.className = 'msg ai';
  const body = document.createElement('div');
  body.className = 'answer';
  body.textContent = 'Searching EverQuest Legends sources…';
  el.appendChild(body);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  activeAnswerSpan = body;

  const res = await window.api.ask({ text, imageDataUrl: imageToSend, history });
  activeAnswerSpan = null;

  if (res.ok) {
    finishAnswer(el, body, res);
    history.push({ role: 'user', text });
    history.push({ role: 'assistant', text: res.answer || '' });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  } else {
    el.className = 'msg error';
    el.textContent = `⚠ ${res.error}`;
  }
}

// Finalize a streamed answer: authoritative text, source-trust banner, citations.
function finishAnswer(el, body, res) {
  // Prefer the authoritative final text (rendered as markdown); otherwise keep
  // whatever streamed in as plain text.
  if (res.answer) body.innerHTML = renderMarkdown(res.answer);
  else if (body.dataset.started !== '1') body.textContent = '(empty response)';

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
  el.insertBefore(banner, body);

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

  // Copy-answer button.
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '⧉ Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(res.answer || '');
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1500);
    } catch { /* ignore */ }
  });
  el.appendChild(copyBtn);

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Streamed tokens from the main process append into the active answer bubble.
window.api.onAiDelta((chunk) => {
  if (!activeAnswerSpan) return;
  if (activeAnswerSpan.dataset.started !== '1') {
    activeAnswerSpan.textContent = '';
    activeAnswerSpan.dataset.started = '1';
  }
  activeAnswerSpan.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

async function capture() {
  const dataUrl = await window.api.startCapture();
  if (dataUrl) {
    setPendingImage(dataUrl);
    inputEl.focus();
    if (!inputEl.value) inputEl.placeholder = 'Ask about this capture… (or just Send)';
  }
}

// --- Wiring ------------------------------------------------------------------
document.getElementById('btn-send').addEventListener('click', () => send());
document.getElementById('btn-capture').addEventListener('click', capture);
document.getElementById('btn-settings').addEventListener('click', () => window.api.openSettings());
document.getElementById('btn-clear').addEventListener('click', () => {
  messagesEl.innerHTML = '';
  setPendingImage(null);
  history = []; // forget the conversation
});

// Quick-prompt chips: one tap sends a common question (using any pending capture).
document.querySelectorAll('#quickbar .chip').forEach((chip) => {
  chip.addEventListener('click', () => send(chip.dataset.prompt));
});
document.getElementById('thumb-remove').addEventListener('click', () => setPendingImage(null));

// Transparency slider: fades the panel background (text stays readable).
// Remembered per-machine via localStorage.
const opacityPop = document.getElementById('opacity-pop');
const opacityRange = document.getElementById('opacity-range');

function applyPanelAlpha(pct) {
  const alpha = Math.max(15, Math.min(100, pct)) / 100;
  document.documentElement.style.setProperty('--panel-alpha', String(alpha));
}
try {
  const saved = localStorage.getItem('panelOpacity');
  if (saved) { opacityRange.value = saved; applyPanelAlpha(Number(saved)); }
} catch { /* ignore */ }

document.getElementById('btn-opacity').addEventListener('click', () => {
  opacityPop.classList.toggle('hidden');
});
opacityRange.addEventListener('input', () => {
  applyPanelAlpha(Number(opacityRange.value));
  try { localStorage.setItem('panelOpacity', opacityRange.value); } catch { /* ignore */ }
});

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

// Visible resize grip: drag the bottom-right corner to resize the frameless
// window. Uses screen coordinates + pointer capture so it keeps tracking even if
// the cursor briefly leaves the window.
const grip = document.getElementById('resize-grip');
let resizing = false;
let startX = 0;
let startY = 0;
let startW = 0;
let startH = 0;
let pending = null;
let rafId = 0;

function applyResize() {
  rafId = 0;
  if (pending) {
    window.api.resizeTo(pending.w, pending.h);
    pending = null;
  }
}

grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizing = true;
  startX = e.screenX;
  startY = e.screenY;
  startW = window.innerWidth;
  startH = window.innerHeight;
  grip.setPointerCapture(e.pointerId);
  document.body.style.userSelect = 'none';
});
grip.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  pending = { w: startW + (e.screenX - startX), h: startH + (e.screenY - startY) };
  if (!rafId) rafId = requestAnimationFrame(applyResize);
});
grip.addEventListener('pointerup', (e) => {
  resizing = false;
  try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  document.body.style.userSelect = '';
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
