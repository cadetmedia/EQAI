// OpenAI provider (Responses API). Streams the answer, remembers prior turns,
// and uses the web_search tool for grounded citations.
const { streamSSE } = require('./stream');
const ENDPOINT = 'https://api.openai.com/v1/responses';

function buildInput(history, systemPrompt, userContent) {
  const input = [{ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] }];
  for (const h of history || []) {
    if (!h || !h.text) continue;
    if (h.role === 'assistant') input.push({ role: 'assistant', content: [{ type: 'output_text', text: h.text }] });
    else input.push({ role: 'user', content: [{ type: 'input_text', text: h.text }] });
  }
  input.push({ role: 'user', content: userContent });
  return input;
}

async function ask(cfg, { text, imageDataUrl, systemPrompt, history, signal }, onDelta) {
  const userContent = [{ type: 'input_text', text: text || 'What am I looking at in EverQuest Legends?' }];
  if (imageDataUrl) userContent.push({ type: 'input_image', image_url: imageDataUrl });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o',
      max_output_tokens: 1536,
      tools: [{ type: 'web_search_preview' }],
      stream: true,
      input: buildInput(history, systemPrompt, userContent),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 500)}`);
  }

  let answer = '';
  const citations = [];
  await streamSSE(res, (data) => {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      answer += ev.delta;
      if (onDelta) onDelta(ev.delta);
    } else if (ev.type === 'response.output_text.annotation.added' && ev.annotation &&
               ev.annotation.type === 'url_citation' && ev.annotation.url) {
      citations.push({ url: ev.annotation.url, title: ev.annotation.title });
    } else if (ev.type === 'response.completed' && ev.response && Array.isArray(ev.response.output)) {
      // Fallback if deltas/annotations weren't emitted incrementally.
      for (const item of ev.response.output) {
        if (item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part.type !== 'output_text') continue;
          if (!answer) answer += part.text || '';
          for (const ann of part.annotations || []) {
            if (ann.type === 'url_citation' && ann.url) citations.push({ url: ann.url, title: ann.title });
          }
        }
      }
    }
  });

  return { answer: answer.trim(), citations };
}

async function test(cfg) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'gpt-4o', max_output_tokens: 16, input: 'ping' }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

async function listModels(cfg) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  // Keep chat-capable models (gpt-* / o-series / chatgpt-*), drop embeddings etc.
  return (json.data || []).map((m) => m.id)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id))
    .filter((id) => !/(embedding|whisper|tts|audio|image|dall-e|moderation|realtime|transcribe)/i.test(id));
}

module.exports = { ask, test, listModels };
