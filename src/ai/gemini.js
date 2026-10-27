// Google Gemini provider. Uses Google Search grounding so answers are backed by
// real pages, and returns the grounding citations. Gemini has a free API tier
// (keys from Google AI Studio), which makes it the no-cost option for users.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function splitDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

// Gemini grounding returns Google redirect URLs. Resolve them to the real source
// so trusted/outside tagging and the clickable link point at the actual site.
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

async function ask(cfg, { text, imageDataUrl, systemPrompt }) {
  const parts = [{ text: text || 'What am I looking at in EverQuest Legends?' }];
  if (imageDataUrl) {
    const img = splitDataUrl(imageDataUrl);
    if (img) parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
  }

  const model = cfg.model || 'gemini-2.0-flash';
  const res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts }],
      tools: [{ google_search: {} }], // web-search grounding
      generationConfig: { maxOutputTokens: 1536 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 500)}`);
  }
  const json = await res.json();
  const cand = (json.candidates || [])[0] || {};
  const answer = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || '')
    .join('');

  const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const raw = chunks
    .filter((c) => c.web && c.web.uri)
    .map((c) => ({ url: c.web.uri, title: c.web.title }));
  const citations = await Promise.all(
    raw.slice(0, 8).map(async (c) => ({ url: await resolveFinal(c.url), title: c.title }))
  );

  return { answer: answer.trim(), citations };
}

// Lightweight auth check.
async function test(cfg) {
  const model = cfg.model || 'gemini-2.0-flash';
  const res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 8 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { ask, test };
