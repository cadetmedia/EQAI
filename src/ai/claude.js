// Anthropic (Claude) provider. Streams the answer, remembers prior turns, and
// uses the server-side web_search tool so answers are grounded with citations.
const { streamSSE } = require('./stream');
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function splitDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

// Prior turns are sent as plain text; the current turn carries any image.
function buildMessages(history, currentContent) {
  const msgs = [];
  for (const h of history || []) {
    if (h && h.text) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text });
  }
  msgs.push({ role: 'user', content: currentContent });
  return msgs;
}

async function ask(cfg, { text, imageDataUrl, systemPrompt, history }, onDelta) {
  const content = [];
  if (imageDataUrl) {
    const img = splitDataUrl(imageDataUrl);
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: 'text', text: text || 'What am I looking at in EverQuest Legends?' });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-sonnet-4-5',
      max_tokens: 1536,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      stream: true,
      messages: buildMessages(history, content),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 500)}`);
  }

  let answer = '';
  const cited = [];
  const searchResults = [];
  await streamSSE(res, (data) => {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) {
        answer += ev.delta.text;
        if (onDelta) onDelta(ev.delta.text);
      } else if (ev.delta.type === 'citations_delta' && ev.delta.citation && ev.delta.citation.url) {
        cited.push({ url: ev.delta.citation.url, title: ev.delta.citation.title });
      }
    } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'web_search_tool_result') {
      const c = ev.content_block.content;
      if (Array.isArray(c)) for (const r of c) if (r && r.url) searchResults.push({ url: r.url, title: r.title });
    }
  });

  return { answer: answer.trim(), citations: cited.length ? cited : searchResults };
}

// Lightweight auth check: a tiny completion with no tools.
async function test(cfg) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-sonnet-4-5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { ask, test };
