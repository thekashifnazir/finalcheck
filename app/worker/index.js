// FinalCheck Worker: /api/* routes, everything else is static assets.
// The LLM parse is optional — any failure falls back to the keyword ruleset.
import { validateMandate } from '../public/lib/parse.js';
import { aiParse, llmProvider } from './llm.js';
import { handleConsole } from './console.js';
import { handleMcp } from './mcp.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

async function handleParse(request, env) {
  let text, currency;
  try {
    ({ text, currency } = await request.json());
  } catch {
    return json({ error: 'body must be JSON {text}' }, 400);
  }
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'text is required' }, 400);
  if (text.length > 500) return json({ error: 'text must be 500 characters or fewer' }, 400);

  const { mandate, fallback_reason } = await aiParse(env, text, currency);

  try {
    validateMandate(mandate);
  } catch (e) {
    return json({ error: e.message, mandate }, 422);
  }
  return json(fallback_reason ? { mandate, fallback_reason } : { mandate });
}

// Cross-site request guard for every state-changing call. A JSON content-type can't be sent
// cross-origin without a CORS preflight (which this Worker never answers), and a browser's
// Origin header must match this host. Non-browser clients (agents, curl) send no Origin.
function rejectCrossSite(request, url) {
  if (request.method !== 'POST') return null;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'cross-site request refused' }, 403);
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/api/')) {
      const refused = rejectCrossSite(request, url);
      if (refused) return refused;
    }
    if (url.pathname === '/mcp') return handleMcp(request, env, url);
    if (url.pathname === '/api/health') return json({ ok: true, llm: llmProvider(env) ?? 'ruleset' });
    if (url.pathname === '/api/parse') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return handleParse(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      const res = await handleConsole(request, env, url);
      return res ?? json({ error: 'not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
