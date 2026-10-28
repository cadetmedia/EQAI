// Settings window logic. Loads current values, toggles the provider block,
// and saves back through window.api.
const els = {
  provider: document.getElementById('provider'),
  claudeKey: document.getElementById('claude-key'),
  claudeModel: document.getElementById('claude-model'),
  openaiKey: document.getElementById('openai-key'),
  openaiModel: document.getElementById('openai-model'),
  geminiKey: document.getElementById('gemini-key'),
  geminiModel: document.getElementById('gemini-model'),
  hotkey: document.getElementById('hotkey'),
  eqlogdir: document.getElementById('eqlogdir'),
  usewiki: document.getElementById('usewiki'),
  sources: document.getElementById('sources'),
  closesources: document.getElementById('closesources'),
  persona: document.getElementById('persona'),
  feedurl: document.getElementById('feedurl'),
  ver: document.getElementById('ver'),
  updStatus: document.getElementById('upd-status'),
  status: document.getElementById('status'),
  blocks: {
    claude: document.getElementById('block-claude'),
    openai: document.getElementById('block-openai'),
    gemini: document.getElementById('block-gemini'),
  },
};

function syncProviderBlocks() {
  const p = els.provider.value;
  for (const [name, el] of Object.entries(els.blocks)) {
    el.classList.toggle('hidden', name !== p);
  }
}

(async () => {
  const s = await window.api.getSettings();
  els.provider.value = s.provider;
  // Keys are never sent to the renderer. Show a "saved" placeholder when one
  // exists; leaving the field blank on Save keeps the stored key unchanged.
  const markKey = (input, hasKey) => {
    input.value = '';
    input.placeholder = hasKey ? '•••••••••• (saved — leave blank to keep)' : input.placeholder;
  };
  markKey(els.claudeKey, s.claude.hasKey);
  els.claudeModel.value = s.claude.model || '';
  markKey(els.openaiKey, s.openai.hasKey);
  els.openaiModel.value = s.openai.model || '';
  markKey(els.geminiKey, s.gemini.hasKey);
  els.geminiModel.value = s.gemini.model || '';
  els.hotkey.value = s.captureHotkey || '';
  els.eqlogdir.value = s.eqLogDir || '';
  els.usewiki.checked = s.useWiki !== false;
  els.sources.value = (s.trustedSources || []).join('\n');
  els.closesources.value = (s.closeSources || []).join('\n');
  els.persona.value = s.personaPrompt || '';
  els.feedurl.value = s.updateFeedUrl || '';
  syncProviderBlocks();

  // Auto-refresh the model list for the active provider if it has a key, so a
  // stale/retired default gets corrected to a current model automatically.
  if (s[s.provider] && s[s.provider].hasKey) loadModels(s.provider, { auto: true });

  try {
    const v = await window.api.getVersion();
    els.ver.textContent = v.label;
  } catch { els.ver.textContent = '—'; }
})();

// Manual "Check for updates".
document.getElementById('check').addEventListener('click', async () => {
  els.updStatus.textContent = 'Checking…';
  const res = await window.api.checkUpdate();
  if (res.mode === 'auto') {
    els.updStatus.textContent = "Checking… you'll be prompted in the overlay to restart when an update is ready.";
  } else if (res.error) {
    els.updStatus.textContent = `⚠ ${res.error}`;
  } else if (res.updateAvailable) {
    els.updStatus.textContent = `⬆ ${res.latestLabel} available — `;
    if (res.url) {
      const dl = document.createElement('a');
      dl.href = '#';
      dl.textContent = 'Download';
      dl.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(res.url); });
      els.updStatus.appendChild(dl);
    } else {
      els.updStatus.appendChild(document.createTextNode('see release page'));
    }
  } else {
    els.updStatus.textContent = "✓ You're on the latest version";
  }
});

// --- Model picker: fetch current models and auto-correct a stale default -----
const KEY_EL = () => ({ gemini: els.geminiKey, claude: els.claudeKey, openai: els.openaiKey });
const MODEL_EL = () => ({ gemini: els.geminiModel, claude: els.claudeModel, openai: els.openaiModel });

function versionScore(id) {
  const m = String(id).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}
function pickBest(models, provider) {
  if (!models.length) return '';
  const prefer = provider === 'gemini' ? /flash/i : provider === 'claude' ? /sonnet/i : /^gpt-|^chatgpt-/i;
  let cands = models.filter((m) => prefer.test(m));
  const noisy = /(lite|thinking|preview|exp|-8b|-1b|instruct|audio|realtime|search)/i;
  const clean = cands.filter((m) => !noisy.test(m));
  if (clean.length) cands = clean;
  if (!cands.length) cands = models.slice();
  cands.sort((a, b) => versionScore(b) - versionScore(a) || a.length - b.length);
  return cands[0];
}

async function loadModels(provider, opts = {}) {
  const modelEl = MODEL_EL()[provider];
  const dl = document.getElementById(`${provider}-models`);
  const hint = document.getElementById(`${provider}-model-hint`);
  if (!modelEl || !dl) return;
  if (!opts.auto) hint.textContent = 'Loading models…';
  const res = await window.api.listModels({ provider, cfg: { apiKey: cleanKey(KEY_EL()[provider].value) } });
  if (!res.ok) { hint.textContent = opts.auto ? '' : `⚠ ${res.error}`; return; }
  const models = res.models || [];
  dl.innerHTML = '';
  for (const m of models) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
  const cur = modelEl.value.trim();
  if (!cur || !models.includes(cur)) {
    const best = pickBest(models, provider);
    if (best) { modelEl.value = best; hint.textContent = `${models.length} models available — selected ${best}`; return; }
  }
  hint.textContent = `${models.length} models available`;
}

for (const p of ['gemini', 'claude', 'openai']) {
  document.getElementById(`${p}-loadmodels`).addEventListener('click', () => loadModels(p));
  // When a key is entered/changed, fetch models and auto-correct a stale default.
  KEY_EL()[p].addEventListener('change', () => { if (cleanKey(KEY_EL()[p].value)) loadModels(p, { auto: true }); });
}

els.provider.addEventListener('change', () => {
  syncProviderBlocks();
  loadModels(els.provider.value, { auto: true }); // refresh list for the newly shown provider
});

// Browse for the EQ log folder.
document.getElementById('browse-log').addEventListener('click', async () => {
  const dir = await window.api.pickFolder();
  if (dir) els.eqlogdir.value = dir;
});

// "Get an API key" links open in the real browser.
for (const a of document.querySelectorAll('a.getkey')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(a.dataset.link);
  });
}

// API keys never contain whitespace — strip any that sneaks in on paste
// (stray space, trailing newline, wrapped copy) so it can't cause a 401.
const cleanKey = (v) => String(v || '').replace(/\s+/g, '');

// Test connection using whatever is currently typed (no need to save first).
document.getElementById('test').addEventListener('click', async () => {
  const provider = els.provider.value;
  const cfgByProvider = {
    claude: { apiKey: cleanKey(els.claudeKey.value), model: els.claudeModel.value.trim() },
    openai: { apiKey: cleanKey(els.openaiKey.value), model: els.openaiModel.value.trim() },
    gemini: { apiKey: cleanKey(els.geminiKey.value), model: els.geminiModel.value.trim() },
  };
  const cfg = cfgByProvider[provider];
  if (!cfg.apiKey) {
    els.status.textContent = '⚠ Enter an API key first';
    return;
  }
  els.status.textContent = 'Testing…';
  const res = await window.api.testConnection({ provider, cfg });
  if (res.ok) {
    els.status.textContent = '✓ Account connected!';
    setTimeout(() => (els.status.textContent = ''), 4000);
  } else if (/model|not found|404|deprecat|unsupported/i.test(res.error || '')) {
    els.status.textContent = `⚠ ${res.error} — click “↻ Models” to pick a current model.`;
  } else {
    els.status.textContent = `⚠ ${res.error}`;
  }
});

document.getElementById('save').addEventListener('click', async () => {
  // Keep an optional path (e.g. reddit.com/r/EQLegends); just strip the
  // protocol, any leading www., and a trailing slash.
  const cleanSources = (v) => v
    .split('\n')
    .map((line) => line.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const trustedSources = cleanSources(els.sources.value);
  const closeSources = cleanSources(els.closesources.value);
  await window.api.saveSettings({
    provider: els.provider.value,
    captureHotkey: els.hotkey.value.trim(),
    trustedSources,
    closeSources,
    personaPrompt: els.persona.value,
    eqLogDir: els.eqlogdir.value.trim(),
    useWiki: els.usewiki.checked,
    updateFeedUrl: els.feedurl.value.trim(),
    claude: { apiKey: cleanKey(els.claudeKey.value), model: els.claudeModel.value.trim() },
    openai: { apiKey: cleanKey(els.openaiKey.value), model: els.openaiModel.value.trim() },
    gemini: { apiKey: cleanKey(els.geminiKey.value), model: els.geminiModel.value.trim() },
  });
  els.status.textContent = 'Saved ✓';
  setTimeout(() => (els.status.textContent = ''), 2000);
});
