// Pluggable AI dispatch. Enforces the EverQuest Legends context + source policy,
// runs the provider (which performs a real web search), then classifies every
// returned citation against the user's trusted-source list so the "trusted vs
// outside" disclosure is guaranteed by the app, not just requested of the model.
const claude = require('./claude');
const openai = require('./openai');
const gemini = require('./gemini');

const PROVIDERS = { claude, openai, gemini };

// Fixed, non-removable policy. The user's personaPrompt is appended after this.
function buildSystemPrompt(trustedSources, personaPrompt) {
  const list = (trustedSources || []).map((d) => `  - ${d}`).join('\n') || '  (none set)';
  return [
    'You are EQAI, an in-game assistant for the video game **EverQuest Legends**.',
    '',
    'ABOUT THE GAME (this is the ONLY game every question is about):',
    '- EverQuest Legends is a reimagined, solo-friendly version of CLASSIC EverQuest,',
    '  published by Daybreak Game Company and developed by indie studio Game Jawn.',
    '- It launched for PC on July 28, 2026. It is a standalone, PRE-KUNARK era game',
    '  (classic zones, races, spells and loot), NOT the original 1999 live EverQuest,',
    '  NOT EverQuest II, and NOT a progression/emulated server.',
    '- Because it mirrors classic pre-Kunark EverQuest, classic-EQ information is often',
    '  (but not always) correct for Legends. When you rely on general classic-EQ',
    '  knowledge rather than a Legends-specific source, say so explicitly.',
    '',
    'HOW TO ANSWER:',
    '1. ALWAYS use your web search tool to answer. Do not answer game questions from',
    '   memory alone.',
    '2. Prefer these TRUSTED SOURCES for EverQuest Legends and search them first:',
    list,
    '3. If you find the answer in a trusted source, base your answer on it and cite the',
    '   exact page URL(s) you used.',
    '4. If you CANNOT find the answer in a trusted source and must use another site, you',
    '   MUST (a) still answer if you can, (b) clearly state that you went OUTSIDE the',
    '   trusted sources, and (c) name the exact source/site and URL where you found it.',
    '5. NEVER invent, guess, or fabricate a source, URL, or fact. If you are not',
    '   confident and could not verify via search, say so plainly.',
    '6. Keep in-game text/tooltips from any screenshot in mind as the subject of the',
    '   question.',
    '',
    'The application will independently label each source you cite as trusted or outside,',
    'so always cite the real pages you actually used.',
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

function isTrusted(url, trustedSources) {
  return (trustedSources || []).some((e) => matchesSource(url, e));
}

async function askAI(settings, { text, imageDataUrl, history, logContext, signal }, onDelta) {
  const name = settings.provider || 'claude';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown AI provider: ${name}`);

  const cfg = settings[name] || {};
  if (!cfg.apiKey) {
    throw new Error(`No API key set for ${name}. Open Settings (⚙) and add one.`);
  }

  const systemPrompt = buildSystemPrompt(settings.trustedSources, settings.personaPrompt) +
    (settings.personaPrompt ? `\n\nSTYLE:\n${settings.personaPrompt}` : '') +
    (logContext ? `\n\nLIVE GAME CONTEXT (read from the player's EQ log right now — use it to tailor your answer; the player may say "here" or "this mob" relative to it):\n${logContext}` : '');

  const { answer, citations } = await provider.ask(cfg, {
    text,
    imageDataUrl,
    systemPrompt,
    history,
    signal,
    trustedSources: settings.trustedSources,
  }, onDelta);

  // Dedupe + classify citations against the trusted list.
  const seen = new Set();
  const classified = [];
  for (const c of citations || []) {
    const host = hostOf(c.url);
    const key = c.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    classified.push({ url: c.url, title: c.title || host || c.url, host, trusted: isTrusted(c.url, settings.trustedSources) });
  }

  const searched = classified.length > 0;
  const usedOutside = classified.some((c) => !c.trusted);

  return { answer, citations: classified, searched, usedOutside };
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
