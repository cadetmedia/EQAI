// Pluggable AI dispatch. Enforces the EverQuest Legends context + source policy,
// runs the provider (which performs a real web search), then classifies every
// returned citation against the user's trusted-source list so the "trusted vs
// outside" disclosure is guaranteed by the app, not just requested of the model.
const claude = require('./claude');
const openai = require('./openai');
const gemini = require('./gemini');

const PROVIDERS = { claude, openai, gemini };

// Fixed, non-removable policy. The user's personaPrompt is appended after this.
function buildSystemPrompt(trustedSources, closeSources, personaPrompt) {
  const trusted = (trustedSources || []).map((d) => `  - ${d}`).join('\n') || '  (none set)';
  const close = (closeSources || []).map((d) => `  - ${d}`).join('\n') || '  (none set)';
  return [
    'You are EQAI, an in-game assistant for the video game **EverQuest Legends**.',
    '',
    'ABOUT THE GAME (this is the ONLY game every question is about):',
    '- EverQuest Legends (EQL) is published by Daybreak Game Company and developed by',
    '  indie studio Game Jawn. It launched for PC on July 28, 2026. It is a standalone,',
    '  PRE-KUNARK era game, NOT the original 1999 live EverQuest, NOT EverQuest II, and',
    '  NOT a progression/emulated server.',
    '- CRITICAL: EverQuest Legends is ITS OWN GAME. Even though it is based on classic',
    '  EverQuest, Legends-specific details — especially DROPS, LOOT TABLES, SPAWN RATES',
    '  and TIMERS, and mechanics — MAY DIFFER from classic EverQuest. Do NOT assume',
    '  classic-EQ data is correct for Legends.',
    '',
    'SOURCE PRIORITY (strict — the app independently re-checks every URL you cite):',
    '1. ALWAYS use your web search tool. Never answer game questions from memory alone.',
    '2. TRUSTED — EverQuest Legends-specific sources. Search these FIRST and base the',
    '   answer on them whenever they have it:',
    trusted,
    '3. CLOSE — classic-EverQuest sources that are USUALLY (but not always) correct for',
    '   Legends. Use these ONLY when no TRUSTED Legends source has the answer, and when',
    '   you do, clearly say the info is from classic EQ and may differ in Legends:',
    close,
    '4. OTHER sources — use only as a last resort when neither TRUSTED nor CLOSE has it,',
    '   and clearly state you went outside and name the exact site + URL.',
    '5. Always cite the exact page URL(s) you actually used. NEVER invent or guess a',
    '   source, URL, or fact; if you could not verify it, say so plainly.',
    '6. When drops/spawns/timers come from a CLOSE or OTHER source, add a short caveat',
    '   that Legends may differ and it is unconfirmed for EQL.',
    '7. Treat any in-game text/tooltip from a screenshot as the subject of the question.',
  ].join('\n');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// A trusted entry is either a bare domain ("eqlwiki.com") or a domain with a
// path prefix ("reddit.com/r/EQLegends"). A URL matches when its host matches
// (exact or subdomain) AND, if a path prefix is given, its path is under it.
// Path matching is case-insensitive and respects path boundaries.
function matchesSource(url, entry) {
  let host;
  let path;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  const e = String(entry).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  if (!e) return false;
  const slash = e.indexOf('/');
  const edom = slash === -1 ? e : e.slice(0, slash);
  const epath = slash === -1 ? '' : e.slice(slash); // leading '/'
  const hostOk = host === edom || host.endsWith('.' + edom);
  if (!hostOk) return false;
  if (!epath) return true;
  return path === epath || path.startsWith(epath + '/');
}

function matchesAny(url, list) {
  return (list || []).some((e) => matchesSource(url, e));
}

// Three tiers: 'trusted' (EQL-specific), 'close' (classic EQ, usually right),
// 'outside' (everything else).
function tierOf(url, trustedSources, closeSources) {
  if (matchesAny(url, trustedSources)) return 'trusted';
  if (matchesAny(url, closeSources)) return 'close';
  return 'outside';
}

async function askAI(settings, { text, imageDataUrl, history, logContext, references, signal }, onDelta) {
  const name = settings.provider || 'claude';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown AI provider: ${name}`);

  const cfg = settings[name] || {};
  if (!cfg.apiKey) {
    throw new Error(`No API key set for ${name}. Open Settings (⚙) and add one.`);
  }

  const systemPrompt = buildSystemPrompt(settings.trustedSources, settings.closeSources, settings.personaPrompt) +
    (settings.personaPrompt ? `\n\nSTYLE:\n${settings.personaPrompt}` : '') +
    (logContext ? `\n\nLIVE GAME CONTEXT (read from the player's EQ log right now — use it to tailor your answer; the player may say "here" or "this mob" relative to it):\n${logContext}` : '') +
    (references ? `\n\n${references}` : '');

  const { answer, citations } = await provider.ask(cfg, {
    text,
    imageDataUrl,
    systemPrompt,
    history,
    signal,
    trustedSources: settings.trustedSources,
  }, onDelta);

  // Dedupe + classify citations into the three tiers.
  const seen = new Set();
  const classified = [];
  for (const c of citations || []) {
    const host = hostOf(c.url);
    const key = c.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tier = tierOf(c.url, settings.trustedSources, settings.closeSources);
    classified.push({ url: c.url, title: c.title || host || c.url, host, tier });
  }

  const searched = classified.length > 0;
  const usedClose = classified.some((c) => c.tier === 'close');
  const usedOutside = classified.some((c) => c.tier === 'outside');

  return { answer, citations: classified, searched, usedClose, usedOutside };
}

// Verify a provider's API key works (billed to the user's own account).
async function testProvider(provider, cfg) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown AI provider: ${provider}`);
  if (!cfg || !cfg.apiKey) throw new Error('No API key provided.');
  await p.test(cfg);
  return true;
}

module.exports = { askAI, testProvider };
