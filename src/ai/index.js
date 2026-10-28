// Pluggable AI dispatch. Enforces the EverQuest Legends context + source policy,
// runs the provider (which performs a real web search), then classifies every
// returned citation against the user's trusted-source list so the "trusted vs
// outside" disclosure is guaranteed by the app, not just requested of the model.
const claude = require('./claude');
const openai = require('./openai');
const gemini = require('./gemini');

const PROVIDERS = { claude, openai, gemini };

// When the model can't answer within the allowed sources, it returns ONLY this.
const NO_ANSWER = 'NO_ANSWER_IN_SCOPE';

// Scope-aware policy. 'trusted' and 'close' hard-restrict the search; 'outside'
// opens it up. The user's personaPrompt is appended after this.
function buildSystemPrompt(scope, trustedSources, closeSources, personaPrompt) {
  const trusted = (trustedSources || []).map((d) => `  - ${d}`).join('\n') || '  (none set)';
  const close = (closeSources || []).map((d) => `  - ${d}`).join('\n') || '  (none set)';
  const head = [
    'You are EQAI, an in-game assistant for the video game **EverQuest Legends**.',
    '',
    'ABOUT THE GAME (this is the ONLY game every question is about):',
    '- EverQuest Legends (EQL) is published by Daybreak Game Company and developed by',
    '  indie studio Game Jawn. It launched for PC on July 28, 2026. It is a standalone,',
    '  PRE-KUNARK era game, NOT the original 1999 live EverQuest, NOT EverQuest II, and',
    '  NOT a progression/emulated server.',
    '- CRITICAL: EverQuest Legends is ITS OWN GAME. Even though it is based on classic',
    '  EverQuest, Legends-specific details — especially DROPS, LOOT TABLES, SPAWN RATES',
    '  and TIMERS, and mechanics — MAY DIFFER from classic EverQuest.',
    '',
  ];
  let rules;
  if (scope === 'trusted') {
    rules = [
      'SEARCH SCOPE — TRUSTED ONLY (strict):',
      '1. Use your web search tool, but search ONLY these EverQuest Legends sources:',
      trusted,
      '2. Base your answer SOLELY on these sources. Do NOT use, mention, or blend in any',
      '   other website, and do NOT fall back on general/classic-EQ knowledge.',
      `3. If the answer is NOT available on these sources, reply with EXACTLY \`${NO_ANSWER}\``,
      '   and nothing else. Do not guess, and do not partially answer from memory.',
      '4. Cite the exact page URL(s) you used. Never invent a source, URL, or fact.',
    ];
  } else if (scope === 'close') {
    rules = [
      'SEARCH SCOPE — TRUSTED + CLOSE (no trusted answer was found):',
      '1. Use your web search tool, searching ONLY these sources:',
      '   TRUSTED (EverQuest Legends):',
      trusted,
      '   CLOSE (classic EverQuest — usually right for Legends, but may differ):',
      close,
      '2. Prefer the TRUSTED sources. Do NOT use any website outside the lists above.',
      `3. If the answer is on none of them, reply with EXACTLY \`${NO_ANSWER}\` and nothing else.`,
      '4. When the answer comes from a CLOSE (classic-EQ) source, clearly state it is from',
      '   classic EverQuest and that drops/spawns/timers MAY DIFFER in Legends.',
      '5. Cite the exact page URL(s) you used. Never invent a source, URL, or fact.',
    ];
  } else {
    rules = [
      'SEARCH SCOPE — OPEN WEB (no trusted or close source had the answer):',
      '1. You may search the whole web. Still PREFER EverQuest Legends sources when present.',
      '2. Clearly flag which facts come from non-Legends sources, and warn that Legends may',
      '   differ (especially drops, spawns, and timers). This info is UNCONFIRMED for EQL.',
      '3. Cite the exact page URL(s) you used. Never invent a source, URL, or fact.',
    ];
  }
  return head.concat(rules,
    ['', 'Treat any in-game text/tooltip from a screenshot as the subject of the question.']).join('\n');
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

// The source ENTRIES allowed for a scope (used for allow-listing + filtering).
function allowedEntries(settings, scope) {
  const t = settings.trustedSources || [];
  const c = settings.closeSources || [];
  if (scope === 'trusted') return t;
  if (scope === 'close') return [...t, ...c];
  return null; // outside = no restriction
}
// Bare domains for a provider's allowed_domains list (strip any path).
function bareDomains(entries) {
  return [...new Set((entries || []).map((e) => String(e).toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]).filter(Boolean))];
}
function looksLikeNotFound(answer) {
  const a = String(answer || '').trim();
  return a === NO_ANSWER || a.startsWith(NO_ANSWER) || (a.length <= 40 && a.includes(NO_ANSWER));
}

async function askAI(settings, { text, imageDataUrl, history, logContext, references, scope = 'trusted', signal }, onDelta) {
  const name = settings.provider || 'claude';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown AI provider: ${name}`);

  const cfg = settings[name] || {};
  if (!cfg.apiKey) {
    throw new Error(`No API key set for ${name}. Open Settings (⚙) and add one.`);
  }

  const entries = allowedEntries(settings, scope);
  const allowedDomains = entries ? bareDomains(entries) : null;

  const systemPrompt = buildSystemPrompt(scope, settings.trustedSources, settings.closeSources, settings.personaPrompt) +
    (settings.personaPrompt ? `\n\nSTYLE:\n${settings.personaPrompt}` : '') +
    (logContext ? `\n\nLIVE GAME CONTEXT (read from the player's EQ log right now — use it to tailor your answer; the player may say "here" or "this mob" relative to it):\n${logContext}` : '') +
    (references ? `\n\n${references}` : '');

  const { answer, citations } = await provider.ask(cfg, {
    text,
    imageDataUrl,
    systemPrompt,
    history,
    allowedDomains, // hard-restricts the search where the provider supports it
    signal,
  }, onDelta);

  // "Not found in scope" — surface the escalation choice instead of an answer.
  if (looksLikeNotFound(answer)) {
    return { answer: '', citations: [], searched: false, notFound: true, scope };
  }

  // Dedupe + classify; for a restricted scope, DROP any out-of-scope citation so
  // trusted answers never show blended-in untrusted sources.
  const seen = new Set();
  const classified = [];
  for (const c of citations || []) {
    const host = hostOf(c.url);
    const key = c.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (entries && !matchesAny(c.url, entries)) continue; // out of scope
    const tier = tierOf(c.url, settings.trustedSources, settings.closeSources);
    classified.push({ url: c.url, title: c.title || host || c.url, host, tier });
  }

  // In a restricted scope, an answer with NO in-scope citation isn't grounded in
  // the allowed sources — treat it as not found so we never show an ungrounded or
  // blended answer. (Providers without domain restriction are enforced here.)
  if (entries && classified.length === 0) {
    return { answer: '', citations: [], searched: false, notFound: true, scope };
  }

  const searched = classified.length > 0;
  const usedClose = classified.some((c) => c.tier === 'close');
  const usedOutside = classified.some((c) => c.tier === 'outside');

  return { answer, citations: classified, searched, usedClose, usedOutside, notFound: false, scope };
}

// Verify a provider's API key works (billed to the user's own account).
async function testProvider(provider, cfg) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown AI provider: ${provider}`);
  if (!cfg || !cfg.apiKey) throw new Error('No API key provided.');
  await p.test(cfg);
  return true;
}

// List the currently-available model ids for a provider.
async function listModels(provider, cfg) {
  const p = PROVIDERS[provider];
  if (!p || !p.listModels) throw new Error(`Unknown provider: ${provider}`);
  if (!cfg || !cfg.apiKey) throw new Error('No API key provided.');
  return p.listModels(cfg);
}

module.exports = { askAI, testProvider, listModels };
