// Google Gemini provider. Streams the answer, remembers prior turns, and uses
// Google Search grounding for citations. Has a free API tier (Google AI Studio).
const { streamSSE } = require('./stream');
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function splitDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

// Gemini grounding returns Google redirect URLs; resolve to the real source.
async function resolveFinal(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    return res.url || url;
  } catch {
    return url;
  }
}

async function ask(cfg, { text, imageDataUrl, systemPrompt, history }, onDelta) {
  const parts = [{ text: text || 'What am I looking at in EverQuest Legends?' }];
  if (imageDataUrl) {
    const img = splitDataUrl(imageDataUrl);
    if (img) parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
  }

  const contents = [];
  for (const h of history || []) {
    if (!h || !h.text) continue;
    contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] });
  }
  contents.push({ role: 'user', parts });

  const model = cfg.model || 'gemini-2.0-flash';
  const res = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 1536 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 500)}`);
  }

  let answer = '';
  const raw = [];
  await streamSSE(res, (data) => {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    const cand = (ev.candidates || [])[0];
    if (!cand) return;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.text) {
        answer += p.text;
        if (onDelta) onDelta(p.text);
      }
    }
    const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    for (const c of chunks) if (c.web && c.web.uri) raw.push({ url: c.web.uri, title: c.web.title });
  });

  const citations = await Promise.all(
    raw.slice(0, 8).map(async (c) => ({ url: await resolveFinal(c.url), title: c.title }))
  );
  return { answer: answer.trim(), citations };
}

async function test(cfg) {
  const model = cfg.model || 'gemini-2.0-flash';
  const res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { ask, test };
