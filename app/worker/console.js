// Stateful console API (prefs, policy, mandate, events, sign, keys, verify).
// handleConsole returns a Response, or null if the route isn't ours.
// The server is the authority: signing rebuilds the cart from the fixtures and re-runs check().
// The sign path here is shared with the MCP tools (worker/mcp.js).
import listings from '../public/fixtures/listings.json' with { type: 'json' };
import uk from '../public/policies/uk.json' with { type: 'json' };
import sg from '../public/policies/sg.json' with { type: 'json' };
import { check, formatPence } from '../public/lib/rules.js';
import { parseIntent, validateMandate, toChips } from '../public/lib/parse.js';
import { buildReceipt, ed25519Signer, keyId, publicJwk, verifyReceipt } from '../public/lib/receipt.js';
import { makeStore } from './store.js';

export const POLICIES = { uk, sg };
export const LISTINGS = Object.fromEntries(listings.map((l) => [l.id, l]));
export { listings };
const MAX_ITEMS = 20;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export class BadRequest extends Error {}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRequest('body must be JSON');
  }
}

const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');

// Client sends listing ids and which lines are recurring; names, prices and merchant
// always come from the fixtures, so a tampered price can't slip under the cap.
export function rebuildCart(cart) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) throw new BadRequest('cart.items is required');
  if (cart.items.length > MAX_ITEMS) throw new BadRequest(`cart holds at most ${MAX_ITEMS} items`);
  const items = cart.items.map((it) => {
    const l = LISTINGS[it?.listing_id];
    if (!l) throw new BadRequest(`unknown listing ${JSON.stringify(it?.listing_id)}`);
    if (!it.recurring) return { listing_id: l.id, name: l.name, price: l.price };
    if (!l.recurring_addon) throw new BadRequest(`${l.name} has no recurring add-on`);
    const a = l.recurring_addon;
    return { listing_id: l.id, name: a.name, price: a.price, recurring: a.interval };
  });
  return { merchant: LISTINGS[items[0].listing_id].merchant, items };
}

// Only the fields check() and the receipt read; anything else the client sent is dropped.
export function cleanMandate(m) {
  if (m == null) return null;
  if (typeof m !== 'object') throw new BadRequest('mandate must be an object or null');
  const out = {
    raw: String(m.raw ?? '').slice(0, 500),
    currency: m.currency ?? 'GBP',
    max_amount: Number(m.max_amount),
    one_off: m.one_off !== false,
    allow_recurring: m.allow_recurring === true,
    category: m.category,
    expires: m.expires,
    parsed_by: m.parsed_by ?? 'ruleset',
  };
  try {
    return validateMandate(out);
  } catch (e) {
    throw new BadRequest(`mandate: ${e.message}`);
  }
}

export function policyFor(region) {
  const policy = POLICIES[region];
  if (!policy) throw new BadRequest(`unknown region ${JSON.stringify(region)}`);
  return policy;
}

// ---- signing key (Ed25519 when configured, else the sha256-demo hash) ----
const keyCache = new Map();
export async function signingKey(env) {
  const raw = env.FC_SIGNING_PRIVATE_JWK;
  if (!raw) return null;
  if (!keyCache.has(raw)) {
    keyCache.set(raw, (async () => {
      let priv;
      try {
        priv = JSON.parse(raw);
      } catch {
        throw new Error('FC_SIGNING_PRIVATE_JWK is not valid JSON');
      }
      const pub = env.FC_SIGNING_PUBLIC_JWK ? JSON.parse(env.FC_SIGNING_PUBLIC_JWK) : publicJwk(priv);
      return { signer: await ed25519Signer(priv), publicKey: publicJwk(pub), kid: await keyId(pub) };
    })());
  }
  return keyCache.get(raw);
}

// ---- standing mandate (set by the user or an agent; one per demo user) ----
export async function setMandateFromText(store, text, agent) {
  if (typeof text !== 'string' || !text.trim()) throw new BadRequest('text is required');
  if (text.length > 500) throw new BadRequest('text must be 500 characters or fewer');
  let mandate;
  try {
    mandate = validateMandate(parseIntent(text, new Date()));
  } catch (e) {
    throw new BadRequest(e.message);
  }
  return store.setStandingMandate({
    id: 'mdt_' + randHex(4), mandate, status: 'active', created_at: new Date().toISOString(), agent,
  });
}

export const mandateChips = (m) => toChips(m);

// ---- events ----
const eventItems = (cart) =>
  cart.items.map((i) => ({ name: i.name, price: formatPence(i.price) + (i.recurring ? `/${i.recurring}` : '') }));

export function eventBase(cart, verdict, mandate, agent) {
  const base = {
    agent,
    at: new Date().toISOString(),
    merchant: cart.merchant,
    total: formatPence(verdict.pending_total),
    items: eventItems(cart),
  };
  if (mandate) base.cap = formatPence(Math.round(mandate.max_amount * 100));
  return base;
}

export const refusalEvent = (cart, verdict, mandate, agent) =>
  ({ kind: 'refusal', ...eventBase(cart, verdict, mandate, agent), violations: verdict.violations.map((v) => v.code) });

// The one signing path (UI and MCP). Re-checks server-side; a refusal is a normal
// result ({ok:false}), not an HTTP error. `extra` lands in the signed receipt.
export async function signCart(store, env, { mandate, cart: rawCart, region, agent, extra = null }) {
  const policy = policyFor(region ?? (await store.getPrefs()).region);
  const cart = rebuildCart(rawCart);
  const verdict = check(mandate, cart, listings, new Date(), policy);

  if (!verdict.ok) {
    await store.addEvents(refusalEvent(cart, verdict, mandate, agent));
    return { ok: false, verdict };
  }

  const key = await signingKey(env);
  const receipt = await buildReceipt(mandate, cart, verdict, policy, LISTINGS[cart.items[0].listing_id], key?.signer ?? null, extra);
  const order_id = 'ord_' + randHex(4);
  const base = eventBase(cart, verdict, mandate, agent);
  await store.addEvents(
    { kind: 'receipt', ...base, sig: receipt.sig.value },
    { kind: 'order', ...base, at: new Date().toISOString(), order_id },
  );
  return { ok: true, receipt, order_id, verdict };
}

async function handleSign(request, env, store) {
  const body = await readJSON(request);
  const agent = typeof body.agent === 'string' && body.agent ? body.agent.slice(0, 40) : 'console';
  return json(await signCart(store, env, { mandate: cleanMandate(body.mandate), cart: body.cart, region: body.region, agent }));
}

export async function publicKeyInfo(env) {
  const key = await signingKey(env);
  return key
    ? { signing: true, alg: 'Ed25519', kid: key.kid, public_key: key.publicKey }
    : { signing: false, alg: 'sha256-demo', public_key: null, note: 'no signing key configured — receipts carry a hash, not a key signature' };
}

export async function verify(env, receipt) {
  return verifyReceipt(receipt, (await signingKey(env))?.publicKey ?? null);
}

const ROUTES = ['/api/prefs', '/api/policy', '/api/mandate', '/api/mandate/revoke', '/api/events', '/api/events/reset', '/api/sign', '/api/keys', '/api/verify'];

export async function handleConsole(request, env, url) {
  const store = makeStore(env.FC_STORE);
  const route = `${request.method} ${url.pathname}`;
  try {
    switch (route) {
      case 'GET /api/prefs':
        return json(await store.getPrefs());
      case 'POST /api/prefs':
        try {
          return json(await store.setPrefs(await readJSON(request)));
        } catch (e) {
          throw e instanceof BadRequest ? e : new BadRequest(e.message);
        }
      case 'GET /api/policy': {
        const region = url.searchParams.get('region') ?? (await store.getPrefs()).region;
        const policy = POLICIES[region];
        return policy ? json(policy) : json({ error: `unknown region ${JSON.stringify(region)}` }, 404);
      }
      case 'GET /api/mandate': {
        const rec = await store.getStandingMandate();
        return json({ mandate: rec?.status === 'active' ? rec : null, last: rec ?? null });
      }
      case 'POST /api/mandate': {
        const { text } = await readJSON(request);
        return json({ mandate: await setMandateFromText(store, text, 'user') });
      }
      case 'POST /api/mandate/revoke':
        return json({ ok: true, mandate: await store.setMandateStatus('revoked') });
      case 'GET /api/events':
        return json({ events: await store.listEvents() });
      case 'POST /api/events/reset':
        await store.resetEvents();
        return json({ ok: true });
      case 'POST /api/sign':
        return await handleSign(request, env, store);
      case 'GET /api/keys':
        return json(await publicKeyInfo(env));
      case 'POST /api/verify': {
        const { receipt } = await readJSON(request);
        return json(await verify(env, receipt));
      }
    }
    if (ROUTES.includes(url.pathname)) return json({ error: `${request.method} not allowed` }, 405);
    return null;
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    throw e;
  }
}
