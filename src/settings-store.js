// Tiny JSON-file settings store in Electron's userData dir. Keeps API keys and
// preferences local to the machine; no external dependency needed.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  provider: 'gemini', // 'gemini' | 'claude' | 'openai' — default to the free tier
  captureHotkey: 'CommandOrControl+Shift+A',
  claude: {
    apiKey: '',
    // Configurable so you can point it at whatever model your account offers.
    // Must be a model that supports the web search tool.
    model: 'claude-sonnet-4-5',
  },
  openai: {
    apiKey: '',
    model: 'gpt-4o',
  },
  gemini: {
    apiKey: '',
    model: 'gemini-2.0-flash',
  },
  // Remembered overlay window position/size ({x,y,width,height} or null).
  windowBounds: null,
  // Where the app checks for a newer release. Should return JSON like:
  //   { "version": "1.0.0-alpha.1", "label": "Alpha 1.1",
  //     "url": "https://.../EQAI-portable-1.0.0-alpha.1.exe", "notes": "..." }
  // Stable URL that always redirects to the newest release's latest.json asset,
  // published by the GitHub Actions release workflow.
  updateFeedUrl: 'https://github.com/cadetmedia/EQAI/releases/latest/download/latest.json',
  // Credible sources for EverQuest Legends. Answers citing these are tagged
  // "trusted"; anything else is flagged as outside your trusted sources.
  // Bare domains (subdomains match automatically). Editable in Settings.
  trustedSources: [
    'everquestlegends.com',
    'eqlwiki.com',
    'daybreakgames.com',
    'eqprogression.com',
    'reddit.com/r/EQLegends',
  ],
  // Optional extra persona/tone instructions. The core policy (game identity +
  // source rules) is always enforced on top of this and cannot be removed here.
  personaPrompt:
    'Be concise and practical, like a helpful high-level EverQuest player ' +
    'giving another player a straight answer.',
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      claude: { ...DEFAULTS.claude, ...(raw.claude || {}) },
      openai: { ...DEFAULTS.openai, ...(raw.openai || {}) },
      gemini: { ...DEFAULTS.gemini, ...(raw.gemini || {}) },
      trustedSources: Array.isArray(raw.trustedSources)
        ? raw.trustedSources
        : DEFAULTS.trustedSources,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { loadSettings, saveSettings };
