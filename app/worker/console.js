// Stateful console API (prefs, policy, events, sign). Returns a Response, or null if the route isn't ours.
// The server is the authority: /api/sign rebuilds the cart from the fixtures and re-runs check().
import listings from '../public/fixtures/listings.json' with { type: 'json' };
import uk from '../public/policies/uk.json' with { type: 'json' };
import sg from '../public/policies/sg.json' with { type: 'json' };
import { check, formatPence } from '../public/lib/rules.js';
import { validateMandate } from '../public/lib/parse.js';
import { buildReceipt, canonicalize, sha256Hex } from '../public/lib/receipt.js';
import { makeStore } from './store.js';

const POLICIES = { uk, sg };
const LISTINGS = Object.fromEntries(listings.map((l) => [l.id, l]));
const MAX_ITEMS = 20;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

class BadRequest extends Error {}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRequest('body must be JSON');
  }
}

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
function cleanMandate(m) {
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

const eventItems = (cart) =>
  cart.items.map((i) => ({ name: i.name, price: formatPence(i.price) + (i.recurring ? `/${i.recurring}` : '') }));

function orderId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return 'ord_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// buildReceipt needs a mandate; with none, the intent block records baseline mode
// instead, and the demo sig is recomputed over the final body.
async function baselineReceipt(cart, verdict, policy, listing) {
  const pseudo = { currency: policy.currency, max_amount: 0, one_off: true, allow_recurring: false, category: null, expires: null };
  const r = await buildReceipt(pseudo, cart, verdict, policy, listing);
  const { sig, ...body } = r;
  body.intent_mandate = { mode: 'baseline', policy_pack: policy.id, max: null };
  body.checks = { ...body.checks, mode: 'baseline' };
  return { ...body, sig: { alg: sig.alg, value: await sha256Hex(canonicalize(body)) } };
}

async function handleSign(request, store) {
  const body = await readJSON(request);
  const prefs = await store.getPrefs();
  const region = body.region ?? prefs.region;
  const policy = POLICIES[region];
  if (!policy) throw new BadRequest(`unknown region ${JSON.stringify(region)}`);
  const mandate = cleanMandate(body.mandate);
  const cart = rebuildCart(body.cart);
  const agent = typeof body.agent === 'string' && body.agent ? body.agent.slice(0, 40) : 'console';

  const verdict = check(mandate, cart, listings, new Date(), policy);
  const base = {
    agent,
    at: new Date().toISOString(),
    merchant: cart.merchant,
    total: formatPence(verdict.pending_total),
    items: eventItems(cart),
  };
  if (mandate) base.cap = formatPence(Math.round(mandate.max_amount * 100));

  if (!verdict.ok) {
    await store.addEvents({ kind: 'refusal', ...base, violations: verdict.violations.map((v) => v.code) });
    return json({ ok: false, verdict }, 409);
  }

  const listing = LISTINGS[cart.items[0].listing_id];
  const receipt = mandate
    ? await buildReceipt(mandate, cart, verdict, policy, listing)
    : await baselineReceipt(cart, verdict, policy, listing);
  const order_id = orderId();
  await store.addEvents(
    { kind: 'receipt', ...base, sig: receipt.sig.value },
    { kind: 'order', ...base, at: new Date().toISOString(), order_id },
  );
  return json({ ok: true, receipt, order_id, verdict });
}

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
      case 'GET /api/events':
        return json({ events: await store.listEvents() });
      case 'POST /api/events/reset':
        await store.resetEvents();
        return json({ ok: true });
      case 'POST /api/sign':
        return await handleSign(request, store);
    }
    if (['/api/prefs', '/api/policy', '/api/events', '/api/events/reset', '/api/sign'].includes(url.pathname)) {
      return json({ error: `${request.method} not allowed` }, 405);
    }
    return null;
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    throw e;
  }
}
