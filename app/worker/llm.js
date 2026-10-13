// The optional LLM read of a person's words. The keyword ruleset is always the floor;
// the model may only tighten it (mergeMandate). Any failure falls back to the ruleset.
import { parseIntent, mergeMandate, CATEGORIES } from '../public/lib/parse.js';

const SYSTEM = `You turn a shopper's plain-English instruction into a spending mandate.
Reply with ONLY a JSON object, no prose:
{"max_amount": number|null, "one_off": boolean, "allow_recurring": boolean, "category": "gift"|"general", "expires_hint": string|null}
max_amount is the number exactly as the user wrote it, in their own currency — never convert between currencies. allow_recurring is true only if the user explicitly says subscriptions are fine.`;

export function llmProvider(env) {
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
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const data = await r.json();
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
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
  if (!m) throw new Error(`no JSON in model reply: ${String(s).slice(0, 120)}`);
  const o = JSON.parse(m[0]);
  const out = {};
  if (typeof o.max_amount === 'number' && Number.isFinite(o.max_amount)) out.max_amount = o.max_amount;
  if (typeof o.one_off === 'boolean') out.one_off = o.one_off;
  if (typeof o.allow_recurring === 'boolean') out.allow_recurring = o.allow_recurring;
  if (CATEGORIES.includes(o.category)) out.category = o.category;
  return out;
}

export async function aiParse(env, text, currency) {
  const floor = parseIntent(text, new Date(), currency === 'SGD' ? { currency } : {});
  const provider = llmProvider(env);
  if (!provider) return { mandate: floor, fallback_reason: 'no LLM key configured' };
  try {
    const reply = provider === 'anthropic' ? await callAnthropic(env, text) : await callOpenAI(env, text);
    return { mandate: mergeMandate(floor, extractJSON(reply), provider) };
  } catch (e) {
    console.warn('llm parse failed:', e.message);
    return { mandate: floor, fallback_reason: 'LLM unavailable — used keyword ruleset' };
  }
}
