// Settings store in Electron's userData dir. API keys are encrypted at rest with
// the OS keystore (safeStorage / Windows DPAPI) and written atomically so a crash
// mid-write can't corrupt the file and wipe the user's keys.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'settings.json');
const KEY_FIELDS = ['claude', 'openai', 'gemini'];
const ENC_PREFIX = 'enc:v1:';

const DEFAULTS = {
  provider: 'gemini', // 'gemini' | 'claude' | 'openai' — default to the free tier
  captureHotkey: 'CommandOrControl+Shift+A',
  claude: { apiKey: '', model: 'claude-sonnet-4-5' },
  openai: { apiKey: '', model: 'gpt-4o' },
  gemini: { apiKey: '', model: 'gemini-2.0-flash' },
  windowBounds: null,
  // EQ log folder (requires /log on in-game). '' = try to auto-discover.
  eqLogDir: '',
  // Ground answers with eqlwiki page extracts (experimental).
  useWiki: true,
  trustedSources: [
    'everquestlegends.com',
    'eqlwiki.com',
    'daybreakgames.com',
    'eqprogression.com',
    'reddit.com/r/EQLegends',
  ],
  // Classic-EQ sources that are usually (not always) correct for Legends. Used
  // only when no trusted EQL source has the answer; flagged "close", not trusted.
  closeSources: [
    'wiki.project1999.com',
  ],
  personaPrompt:
    'Be concise and practical, like a helpful high-level EverQuest player ' +
    'giving another player a straight answer.',
};

function encKey(v) {
  if (!v) return v || '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(v).toString('base64');
    }
  } catch { /* fall back to plaintext below */ }
  return v;
}

function decKey(v) {
  if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      return '';
    }
  }
  return v || '';
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  const merged = {
    ...DEFAULTS,
    ...raw,
    claude: { ...DEFAULTS.claude, ...(raw.claude || {}) },
    openai: { ...DEFAULTS.openai, ...(raw.openai || {}) },
    gemini: { ...DEFAULTS.gemini, ...(raw.gemini || {}) },
    trustedSources: Array.isArray(raw.trustedSources) ? raw.trustedSources : DEFAULTS.trustedSources,
    closeSources: Array.isArray(raw.closeSources) ? raw.closeSources : DEFAULTS.closeSources,
  };
  for (const p of KEY_FIELDS) merged[p].apiKey = decKey(merged[p].apiKey);
  delete merged.updateFeedUrl; // retired: the feed URL is compiled in (main.js)
  return merged;
}

function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  for (const p of KEY_FIELDS) {
    merged[p] = { ...(merged[p] || DEFAULTS[p]) };
    // Keys never contain whitespace — strip any that slipped in on paste.
    if (typeof merged[p].apiKey === 'string') merged[p].apiKey = merged[p].apiKey.replace(/\s+/g, '');
  }

  // Encrypt key fields only for the on-disk copy.
  const onDisk = { ...merged };
  for (const p of KEY_FIELDS) onDisk[p] = { ...merged[p], apiKey: encKey(merged[p].apiKey) };
  atomicWrite(FILE, JSON.stringify(onDisk, null, 2));
  return merged; // decrypted, for in-process use
}

module.exports = { loadSettings, saveSettings };
