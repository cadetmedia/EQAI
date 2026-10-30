// Local knowledge base (main process):
//  1) Answer cache — remembers past Q&A so repeats are instant and free.
//  2) eqlwiki MediaWiki client — fetches/caches real wiki extracts to ground
//     answers. The API endpoint is auto-detected at runtime (so it works on the
//     user's machine even though we can't reach eqlwiki from the build sandbox).
// Everything fails soft: no network / no match just means no grounding.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'knowledge.json');
const DAY = 24 * 60 * 60 * 1000;
const ANSWER_TTL = 14 * DAY;
const WIKI_TTL = 30 * DAY;
const NEG_TTL = 1 * DAY;
const MAX_ANSWERS = 300;

// Candidate MediaWiki API endpoints, tried in order until one responds.
const WIKI_CANDIDATES = [
  'https://eqlwiki.com/api.php',
  'https://eqlwiki.com/w/api.php',
  'https://www.eqlwiki.com/api.php',
];

let store = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { answers: {}, wiki: {}, wikiBase: '' };
  }
}
function save() {
  try {
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

// --- Answer cache ------------------------------------------------------------
function normalizeQ(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function answerKey(text, zone) {
  return `${normalizeQ(text)}::${String(zone || '').toLowerCase()}`;
}
function getCachedAnswer(text, zone) {
  const q = normalizeQ(text);
  if (q.length < 6) return null; // don't cache trivial inputs
  const hit = store.answers[answerKey(text, zone)];
  if (!hit) return null;
  if (Date.now() - hit.at > ANSWER_TTL) return null;
  return { answer: hit.answer, citations: hit.citations || [], searched: hit.searched, usedOutside: hit.usedOutside };
}
function putCachedAnswer(text, zone, result) {
  const q = normalizeQ(text);
  if (q.length < 6 || !result || !result.answer) return;
  store.answers[answerKey(text, zone)] = {
    at: Date.now(),
    answer: result.answer,
    citations: result.citations || [],
    searched: result.searched,
    usedOutside: result.usedOutside,
  };
  const keys = Object.keys(store.answers);
  if (keys.length > MAX_ANSWERS) {
    keys.map((k) => [k, store.answers[k].at]).sort((a, b) => a[1] - b[1])
      .slice(0, keys.length - MAX_ANSWERS).forEach(([k]) => delete store.answers[k]);
  }
  save();
}

// --- eqlwiki MediaWiki client ------------------------------------------------
let lastWikiReq = 0;
async function politeFetch(url) {
  const wait = 1000 - (Date.now() - lastWikiReq); // >= 1 req/sec
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWikiReq = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'EQAI (https://github.com/cadetmedia/EQAI)' } });
  } finally {
    clearTimeout(t);
  }
}

// A busy wiki answers maxlag with HTTP 200 + an error body (and Retry-After),
// so res.ok alone can't tell "no such page" from "try later". Retry once on
// maxlag / 429 / 5xx; anything still failing throws, so callers never cache a
// transient refusal as a negative result.
function retryDelay(res) {
  const s = Number(res.headers.get('retry-after'));
  return Math.min(Number.isFinite(s) && s > 0 ? s * 1000 : 2000, 5000);
}
async function wikiJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await politeFetch(url);
    let busy = res.status === 429 || res.status >= 500;
    let body = null;
    if (!busy) {
      if (!res.ok) throw new Error(`wiki HTTP ${res.status}`);
      body = await res.json();
      busy = !!(body && body.error && body.error.code === 'maxlag');
      if (!busy && body && body.error) throw new Error(`wiki error ${body.error.code}`);
    }
    if (!busy) return body;
    if (attempt >= 1) throw new Error('wiki busy');
    await new Promise((r) => setTimeout(r, retryDelay(res)));
  }
}

async function detectWikiBase() {
  if (store.wikiBase) return store.wikiBase;
  for (const base of WIKI_CANDIDATES) {
    try {
      const res = await politeFetch(`${base}?action=query&meta=siteinfo&format=json&maxlag=5`);
      if (res.ok) {
        const j = await res.json();
        if (j && (j.query || j.batchcomplete !== undefined)) { store.wikiBase = base; save(); return base; }
      }
    } catch { /* try next */ }
  }
  return '';
}

async function wikiLookup(term) {
  const key = normalizeQ(term);
  if (!key) return null;
  const cached = store.wiki[key];
  if (cached) {
    const ttl = cached.negative ? NEG_TTL : WIKI_TTL;
    if (Date.now() - cached.at < ttl) return cached.negative ? null : cached;
  }
  const base = await detectWikiBase();
  if (!base) return null;
  try {
    const sj = await wikiJson(`${base}?action=opensearch&limit=1&format=json&maxlag=5&search=${encodeURIComponent(term)}`);
    const title = Array.isArray(sj) && sj[1] && sj[1][0];
    if (!title) { store.wiki[key] = { at: Date.now(), negative: true }; save(); return null; }
    const ej = await wikiJson(`${base}?action=query&prop=extracts&explaintext=1&redirects=1&format=json&maxlag=5&titles=${encodeURIComponent(title)}`);
    const pages = ej && ej.query && ej.query.pages;
    const page = pages && Object.values(pages)[0];
    const extract = page && page.extract ? String(page.extract).slice(0, 1200) : '';
    const pageUrl = (sj[3] && sj[3][0]) || '';
    const entry = { at: Date.now(), title, extract, url: pageUrl };
    store.wiki[key] = entry; save();
    return entry;
  } catch {
    return null;
  }
}

// Build a short reference block for the current question + live context.
// Bounded to a couple of lookups and only when the question refers to context.
async function groundingFor(text, ctx, useWiki) {
  if (!useWiki) return '';
  const q = String(text || '').toLowerCase();
  const terms = [];
  if (/\b(here|this (zone|area|camp)|camps?|spawn)\b/.test(q) && ctx && ctx.zone) terms.push(ctx.zone);
  if (/\b(this|that|it)\b/.test(q) && ctx) {
    const recent = (ctx.recentLoot && ctx.recentLoot[ctx.recentLoot.length - 1]) ||
                   (ctx.recentKills && ctx.recentKills[ctx.recentKills.length - 1]);
    if (recent) terms.push(recent);
  }
  const uniq = [...new Set(terms)].slice(0, 2);
  if (!uniq.length) return '';
  const entries = [];
  await Promise.race([
    (async () => {
      for (const t of uniq) {
        const e = await wikiLookup(t);
        if (e && e.extract) entries.push(e);
      }
    })(),
    new Promise((r) => setTimeout(r, 3500)), // don't delay the answer too long
  ]);
  if (!entries.length) return '';
  return 'REFERENCE FROM EQLWIKI (may help; cite the page if you use it):\n' +
    entries.map((e) => `- ${e.title}: ${e.extract}`).join('\n');
}

module.exports = { getCachedAnswer, putCachedAnswer, groundingFor };
