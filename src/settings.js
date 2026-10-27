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
  sources: document.getElementById('sources'),
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
  els.claudeKey.value = s.claude.apiKey || '';
  els.claudeModel.value = s.claude.model || '';
  els.openaiKey.value = s.openai.apiKey || '';
  els.openaiModel.value = s.openai.model || '';
  els.geminiKey.value = s.gemini.apiKey || '';
  els.geminiModel.value = s.gemini.model || '';
  els.hotkey.value = s.captureHotkey || '';
  els.sources.value = (s.trustedSources || []).join('\n');
  els.persona.value = s.personaPrompt || '';
  els.feedurl.value = s.updateFeedUrl || '';
  syncProviderBlocks();

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
    els.updStatus.innerHTML =
      `⬆ ${res.latestLabel} available — ` +
      (res.url ? `<a href="#" id="dl">Download</a>` : 'see release page');
    const dl = document.getElementById('dl');
    if (dl) dl.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(res.url); });
  } else {
    els.updStatus.textContent = "✓ You're on the latest version";
  }
});

els.provider.addEventListener('change', syncProviderBlocks);

// "Get an API key" links open in the real browser.
for (const a of document.querySelectorAll('a.getkey')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(a.dataset.link);
  });
}

// Test connection using whatever is currently typed (no need to save first).
document.getElementById('test').addEventListener('click', async () => {
  const provider = els.provider.value;
  const cfgByProvider = {
    claude: { apiKey: els.claudeKey.value.trim(), model: els.claudeModel.value.trim() },
    openai: { apiKey: els.openaiKey.value.trim(), model: els.openaiModel.value.trim() },
    gemini: { apiKey: els.geminiKey.value.trim(), model: els.geminiModel.value.trim() },
  };
  const cfg = cfgByProvider[provider];
  if (!cfg.apiKey) {
    els.status.textContent = '⚠ Enter an API key first';
    return;
  }
  els.status.textContent = 'Testing…';
  const res = await window.api.testConnection({ provider, cfg });
  els.status.textContent = res.ok ? '✓ Account connected!' : `⚠ ${res.error}`;
  if (res.ok) setTimeout(() => (els.status.textContent = ''), 4000);
});

document.getElementById('save').addEventListener('click', async () => {
  // Keep an optional path (e.g. reddit.com/r/EQLegends); just strip the
  // protocol, any leading www., and a trailing slash.
  const trustedSources = els.sources.value
    .split('\n')
    .map((line) => line.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, ''))
    .filter(Boolean);
  await window.api.saveSettings({
    provider: els.provider.value,
    captureHotkey: els.hotkey.value.trim(),
    trustedSources,
    personaPrompt: els.persona.value,
    updateFeedUrl: els.feedurl.value.trim(),
    claude: { apiKey: els.claudeKey.value.trim(), model: els.claudeModel.value.trim() },
    openai: { apiKey: els.openaiKey.value.trim(), model: els.openaiModel.value.trim() },
    gemini: { apiKey: els.geminiKey.value.trim(), model: els.geminiModel.value.trim() },
  });
  els.status.textContent = 'Saved ✓';
  setTimeout(() => (els.status.textContent = ''), 2000);
});
