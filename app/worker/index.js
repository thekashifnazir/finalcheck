// FinalCheck Worker: /api/* routes, everything else is static assets.
// The LLM parse is optional — any failure falls back to the keyword ruleset.
import { parseIntent, validateMandate, mergeMandate, CATEGORIES } from '../public/lib/parse.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const SYSTEM = `You turn a shopper's plain-English instruction into a spending mandate.
Reply with ONLY a JSON object, no prose:
{"max_amount": number|null, "one_off": boolean, "allow_recurring": boolean, "category": "gift"|"general", "expires_hint": string|null}
max_amount is in pounds. allow_recurring is true only if the user explicitly says subscriptions are fine.`;

function llmProvider(env) {
  if (env.APP_ANTHROPIC_API_KEY) return 'anthropic';
  if (env.APP_OPENAI_API_KEY) return 'openai';
  return null;
}

async function callAnthropic(env, text) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.APP_ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.APP_LLM_MODEL || 'claude-haiku-5-5',
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const data = await r.json();
  return data.content?.map((c) => c.text ?? '').join('') ?? '';
}

async function callOpenAI(env, text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.APP_OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// First {...} block, tolerating code fences; then keep only known, well-typed fields.
function extractJSON(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model reply');
  const o = JSON.parse(m[0]);
  const out = {};
  if (typeof o.max_amount === 'number' && Number.isFinite(o.max_amount)) out.max_amount = o.max_amount;
  if (typeof o.one_off === 'boolean') out.one_off = o.one_off;
  if (typeof o.allow_recurring === 'boolean') out.allow_recurring = o.allow_recurring;
  if (CATEGORIES.includes(o.category)) out.category = o.category;
  return out;
}

async function handleParse(request, env) {
  let text;
  try {
    ({ text } = await request.json());
  } catch {
    return json({ error: 'body must be JSON {text}' }, 400);
  }
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'text is required' }, 400);
  if (text.length > 500) return json({ error: 'text must be 500 characters or fewer' }, 400);

  const floor = parseIntent(text);
  const provider = llmProvider(env);
  let fallback_reason = provider ? null : 'no LLM key configured';
  let mandate = floor;

  if (provider) {
    try {
      const reply = provider === 'anthropic' ? await callAnthropic(env, text) : await callOpenAI(env, text);
      mandate = mergeMandate(floor, extractJSON(reply), provider);
    } catch (e) {
      console.warn('llm parse failed:', e.message);
      fallback_reason = 'LLM unavailable — used keyword ruleset';
      mandate = floor;
    }
  }

  try {
    validateMandate(mandate);
  } catch (e) {
    return json({ error: e.message, mandate }, 422);
  }
  return json(fallback_reason ? { mandate, fallback_reason } : { mandate });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, llm: llmProvider(env) ?? 'ruleset' });
    if (url.pathname === '/api/parse') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return handleParse(request, env);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
