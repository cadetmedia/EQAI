// Reads the EverQuest log the game already writes (requires /log on). We only
// tail NEW lines appended after we start, parse a conservative set of useful
// events, and keep a small rolling context the AI can use. No injection, no
// memory reads — same safe approach as the companion app.
//
// NOTE: EQ Legends mirrors classic EverQuest log formats, but exact message
// wording may need tuning against real logs. Everything here fails soft: if the
// folder is missing or a pattern doesn't match, the app works exactly as before.
const fs = require('fs');
const path = require('path');

let chokidar = null;
try { chokidar = require('chokidar'); } catch { /* feature disabled without it */ }

let watcher = null;
let offsets = new Map();
let onUpdateCb = null;

const ctx = resetCtx();

function resetCtx() {
  return {
    connected: false,
    dir: null,
    character: null,
    server: null,
    zone: null, // base zone name, difficulty marker stripped
    zoneRaw: null, // exactly as the log printed it
    zoneTier: null, // e.g. 'Awakened, difficulty d1', 'Group 3 instance', 'open world'
    level: null,
    loc: null,
    recentKills: [],
    recentLoot: [],
  };
}

function pushCapped(arr, val, cap) {
  if (!val) return;
  if (arr[arr.length - 1] === val) return; // dedupe consecutive
  arr.push(val);
  while (arr.length > cap) arr.shift();
}

// Common EQ log false-positive zone lines to ignore.
const NOT_A_ZONE = /(an area|the wrong|no-drop|PvP|a hostile|the housing)/i;

// EQ Legends puts the difficulty in the zone name itself: a trailing
// "(Awakened|Adaptive|Fused|Refined)" is d1-d4, a "- Solo" / "- Group N" suffix
// is the base instance (weekly lockout), and a bare name is the open world.
// Strip the marker so wiki lookups hit the zone page; keep the tier for the AI.
const ZONE_DIFFICULTY = ['Awakened', 'Adaptive', 'Fused', 'Refined'];
function splitZone(raw) {
  let name = raw.trim();
  let tier = 'open world';
  let mm;
  if ((mm = /^(.+?)\s*\((Awakened|Adaptive|Fused|Refined)\)$/i.exec(name))) {
    name = mm[1];
    const d = ZONE_DIFFICULTY.findIndex((x) => x.toLowerCase() === mm[2].toLowerCase()) + 1;
    tier = `${ZONE_DIFFICULTY[d - 1]}, difficulty d${d}`;
  }
  if ((mm = /^(.+?)\s+-\s+(Solo|Group(?:\s+\d+)?)$/i.exec(name))) {
    name = mm[1];
    if (tier === 'open world') tier = `${mm[2]} instance`;
  }
  return { name, tier };
}

function parseLine(line, fileChar, fileServer) {
  const m = /^\[[^\]]*\]\s*(.*)$/.exec(line);
  const msg = (m ? m[1] : line).trim();
  if (!msg) return false;
  let changed = false;
  let mm;

  if (fileChar && ctx.character !== fileChar) {
    ctx.character = fileChar;
    ctx.server = fileServer;
    changed = true;
  }

  if ((mm = /^You have entered (.+?)\.?$/.exec(msg)) && !NOT_A_ZONE.test(mm[1])) {
    const z = splitZone(mm[1]);
    ctx.zoneRaw = mm[1];
    ctx.zone = z.name;
    ctx.zoneTier = z.tier;
    changed = true;
  } else if ((mm = /Welcome to level (\d+)!/.exec(msg))) {
    ctx.level = Number(mm[1]); changed = true;
  } else if ((mm = /^You have slain (.+?)!$/.exec(msg))) {
    pushCapped(ctx.recentKills, mm[1], 5); changed = true;
  } else if ((mm = /--\s*You have looted (?:a |an |the |\d+ )?(.+?)(?: from .+? corpse)?\.?\s*--/.exec(msg))) {
    // "--You have looted a Bone Chip from a skeleton's corpse.--" -> "Bone Chip"
    pushCapped(ctx.recentLoot, mm[1], 5); changed = true;
  } else if ((mm = /^Your Location is\s+(.+)$/.exec(msg))) {
    ctx.loc = mm[1].trim(); changed = true;
  }
  return changed;
}

function readAppended(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  let off = offsets.get(file) || 0;
  if (size < off) off = 0; // file was rotated/truncated
  if (size === off) return;

  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, size - off, off);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return; }
  offsets.set(file, size);

  const fm = /^eqlog_(.+?)_(.+)\.txt$/i.exec(path.basename(file));
  const fileChar = fm ? fm[1] : null;
  const fileServer = fm ? fm[2] : null;

  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) changed = parseLine(line, fileChar, fileServer) || changed;
  }
  if (changed && onUpdateCb) onUpdateCb(getContext());
}

function isLog(name) { return /^eqlog_.*\.txt$/i.test(name); }

function start(dir, onUpdate) {
  stop();
  onUpdateCb = onUpdate;
  Object.assign(ctx, resetCtx());
  ctx.dir = dir || null;

  if (!dir || !chokidar) {
    if (onUpdateCb) onUpdateCb(getContext());
    return;
  }
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) {
    if (onUpdateCb) onUpdateCb(getContext());
    return;
  }

  // Start reading only NEW lines (anchor offsets at current sizes).
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!isLog(f)) continue;
      const full = path.join(dir, f);
      try { offsets.set(full, fs.statSync(full).size); } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // chokidar v4 dropped glob patterns — watch the dir and filter names.
  watcher = chokidar.watch(dir, { depth: 0, ignoreInitial: true });
  const handle = (full) => { if (isLog(path.basename(full))) readAppended(full); };
  watcher.on('add', handle).on('change', handle);
  ctx.connected = true;
  if (onUpdateCb) onUpdateCb(getContext());
}

function stop() {
  if (watcher) { watcher.close().catch(() => {}); watcher = null; }
  offsets = new Map();
  ctx.connected = false;
}

function buildSummary() {
  if (!ctx.connected) return '';
  const parts = [];
  if (ctx.character) parts.push(`Character: ${ctx.character}${ctx.server ? ` (server ${ctx.server})` : ''}`);
  if (ctx.zone) parts.push(`Current zone: ${ctx.zone}${ctx.zoneTier ? ` (${ctx.zoneTier})` : ''}`);
  if (ctx.level) parts.push(`Level: ${ctx.level}`);
  if (ctx.recentKills.length) parts.push(`Recently killed: ${ctx.recentKills.slice(-3).join(', ')}`);
  if (ctx.recentLoot.length) parts.push(`Recently looted: ${ctx.recentLoot.slice(-3).join(', ')}`);
  if (ctx.loc) parts.push(`Last /loc: ${ctx.loc}`);
  return parts.join('. ') + (parts.length ? '.' : '');
}

function getContext() {
  return {
    connected: ctx.connected,
    character: ctx.character,
    server: ctx.server,
    zone: ctx.zone,
    zoneRaw: ctx.zoneRaw,
    zoneTier: ctx.zoneTier,
    level: ctx.level,
    recentKills: [...ctx.recentKills],
    recentLoot: [...ctx.recentLoot],
    loc: ctx.loc,
    summary: buildSummary(),
  };
}

// Candidate EQ Legends log folders to try when the user hasn't set one.
function autodiscoverDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs',
    'C:/Program Files/EverQuest Legends/Logs',
    'C:/Program Files (x86)/EverQuest Legends/Logs',
    path.join(home, 'Daybreak Game Company', 'Installed Games', 'EverQuest Legends', 'Logs'),
    path.join(home, 'EverQuest Legends', 'Logs'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch { /* next */ }
  }
  return '';
}

module.exports = { start, stop, getContext, autodiscoverDir };
