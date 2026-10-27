// OpenAI provider. Uses the Responses API with the web_search tool so answers
// are grounded in real pages, and returns the URL citations (annotations).
const ENDPOINT = 'https://api.openai.com/v1/responses';

async function ask(cfg, { text, imageDataUrl, systemPrompt }) {
  const userContent = [
    { type: 'input_text', text: text || 'What am I looking at in EverQuest Legends?' },
  ];
  if (imageDataUrl) {
    userContent.push({ type: 'input_image', image_url: imageDataUrl });
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o',
      max_output_tokens: 1536,
      tools: [{ type: 'web_search_preview' }],
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 500)}`);
  }
  const json = await res.json();

  // Walk the output: collect assistant text and any url_citation annotations.
  let answer = '';
  const citations = [];
  for (const item of json.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          answer += part.text || '';
          for (const ann of part.annotations || []) {
            if (ann.type === 'url_citation' && ann.url) {
              citations.push({ url: ann.url, title: ann.title });
            }
          }
        }
      }
    }
  }

  // Fallback for SDKs/versions that expose a flattened output_text.
  if (!answer && typeof json.output_text === 'string') answer = json.output_text;

  return { answer: answer.trim(), citations };
}

// Lightweight auth check: a tiny response with no tools.
async function test(cfg) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o',
      max_output_tokens: 16,
      input: 'ping',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { ask, test };
