// Anthropic (Claude) provider. Uses the server-side web_search tool so answers
// are grounded in real pages, and returns the citations Claude actually used.
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function splitDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

async function ask(cfg, { text, imageDataUrl, systemPrompt }) {
  const content = [];
  if (imageDataUrl) {
    const img = splitDataUrl(imageDataUrl);
    if (img) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
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
      // Server-side web search: Anthropic runs the searches and returns results
      // + citations inline. max_uses caps how many searches per answer.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 500)}`);
  }
  const json = await res.json();

  // Assemble the answer text. Prefer the citations Claude actually attached to
  // its text (the sources it really used). Only if it cited nothing do we fall
  // back to the raw search results, so the trusted/outside flag reflects usage.
  let answer = '';
  const cited = [];
  const searchResults = [];
  for (const block of json.content || []) {
    if (block.type === 'text') {
      answer += block.text;
      for (const cit of block.citations || []) {
        if (cit.url) cited.push({ url: cit.url, title: cit.title });
      }
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && r.url) {
          searchResults.push({ url: r.url, title: r.title });
        }
      }
    }
  }

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
