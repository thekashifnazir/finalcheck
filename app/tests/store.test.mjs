import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryKV, makeStore, EVENTS_CAP } from '../worker/store.js';
import { handleConsole } from '../worker/console.js';
import { canonicalize, sha256Hex } from '../public/lib/receipt.js';

const mandate = {
  raw: 'Buy a birthday gift for my mum, under £40, one-off, no subscriptions',
  currency: 'GBP', max_amount: 40, one_off: true, allow_recurring: false, category: 'gift',
  expires: new Date(Date.now() + 86_400_000).toISOString(), parsed_by: 'ruleset',
};
const teaCart = { merchant: 'Kettle Lane Tea Co.', items: [{ listing_id: 'lst_tea_set', name: 'Deluxe Tea Set', price: 3499 }] };
const hamperCart = {
  merchant: 'Hamper & Hearth',
  items: [
    { listing_id: 'lst_hamper_pro', name: 'Luxury Hamper Pro', price: 5200 },
    { listing_id: 'lst_hamper_pro', name: 'Gift Club', price: 499, recurring: 'month' },
  ],
};

// Calls the console API the way the router does, against an in-memory KV.
function api(env = { FC_STORE: memoryKV() }) {
  const call = async (method, path, body) => {
    const url = new URL(path, 'http://local');
    const init = { method };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
    const res = await handleConsole(new Request(url, init), env, url);
    return res && { status: res.status, body: await res.json() };
  };
  return { env, call };
}

test('prefs default, partial patch, and reject bad values', async () => {
  const s = makeStore(memoryKV());
  assert.deepEqual(await s.getPrefs(), { region: 'uk', mandate_choice: 'ask', agents_paused: false });
  assert.deepEqual(await s.setPrefs({ region: 'sg' }), { region: 'sg', mandate_choice: 'ask', agents_paused: false });
  assert.deepEqual(await s.setPrefs({ mandate_choice: 'baseline' }), { region: 'sg', mandate_choice: 'baseline', agents_paused: false });
  await assert.rejects(s.setPrefs({ region: 'fr' }), /region/);
  await assert.rejects(s.setPrefs({ mandate_choice: 'always' }), /mandate_choice/);
});

test('events: newest first, grouped writes keep order, capped, reset clears', async () => {
  const s = makeStore(memoryKV());
  await s.addEvents({ n: 1 });
  await s.addEvents({ n: 2 }, { n: 3 });
  assert.deepEqual((await s.listEvents()).map((e) => e.n), [3, 2, 1]);
  for (let i = 0; i < EVENTS_CAP + 5; i++) await s.addEvents({ n: 100 + i });
  const all = await s.listEvents();
  assert.equal(all.length, EVENTS_CAP);
  assert.equal(all[0].n, 100 + EVENTS_CAP + 4);
  await s.resetEvents();
  assert.deepEqual(await s.listEvents(), []);
});

test('GET/POST /api/prefs and /api/policy', async () => {
  const { call } = api();
  assert.deepEqual((await call('GET', '/api/prefs')).body, { region: 'uk', mandate_choice: 'ask', agents_paused: false });
  assert.equal((await call('POST', '/api/prefs', { region: 'sg' })).body.region, 'sg');
  assert.equal((await call('POST', '/api/prefs', { region: 'fr' })).status, 400);
  assert.equal((await call('GET', '/api/policy?region=uk')).body.id, 'uk-2026-10');
  assert.equal((await call('GET', '/api/policy')).body.id, 'sg-2026-10'); // follows prefs
  assert.equal((await call('GET', '/api/policy?region=fr')).status, 404);
  assert.equal(await call('GET', '/api/nope'), null);
  assert.equal((await call('GET', '/api/sign')).status, 405);
});

test('sign tea set → receipt + order events, verifiable demo sig', async () => {
  const { call } = api();
  const r = await call('POST', '/api/sign', { mandate, cart: teaCart, agent: 'claude' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.order_id, /^ord_[0-9a-f]{8}$/);
  assert.equal(r.body.receipt.cart_mandate.total, '£34.99');
  const { sig, ...body } = r.body.receipt;
  assert.equal(sig.value, await sha256Hex(canonicalize(body)));

  const { events } = (await call('GET', '/api/events')).body;
  assert.deepEqual(events.map((e) => e.kind), ['order', 'receipt']);
  const [order, receipt] = events;
  assert.equal(receipt.merchant, 'Kettle Lane Tea Co.');
  assert.equal(receipt.total, '£34.99');
  assert.equal(receipt.cap, '£40.00');
  assert.equal(receipt.agent, 'claude');
  assert.equal(receipt.sig, sig.value);
  assert.deepEqual(receipt.items, [{ name: 'Deluxe Tea Set', price: '£34.99' }]);
  assert.equal(order.order_id, r.body.order_id);
});

test('hamper + Gift Club → 200 {ok:false} and a refusal event with codes', async () => {
  const { call } = api();
  const r = await call('POST', '/api/sign', { mandate, cart: hamperCart });
  assert.equal(r.status, 200); assert.equal(r.body.ok, false);
  assert.equal(r.body.ok, false);
  const [ev] = (await call('GET', '/api/events')).body.events;
  assert.equal(ev.kind, 'refusal');
  assert.equal(ev.total, '£56.99');
  assert.equal(ev.cap, '£40.00');
  assert.ok(ev.violations.includes('OVER_BUDGET'));
  assert.ok(ev.violations.includes('UNDISCLOSED_RECURRING'));
  assert.deepEqual(ev.items[1], { name: 'Gift Club', price: '£4.99/month' });
});

test('server ignores client prices and verdicts', async () => {
  const { call } = api();
  const tampered = {
    merchant: 'Hamper & Hearth',
    items: [{ listing_id: 'lst_hamper_pro', name: 'Cheap thing', price: 1 }],
  };
  const r = await call('POST', '/api/sign', { mandate, cart: tampered, verdict: { ok: true, violations: [] } });
  assert.equal(r.status, 200); assert.equal(r.body.ok, false);
  assert.equal(r.body.verdict.one_off_total, 5200);
  assert.equal((await call('POST', '/api/sign', { mandate, cart: { items: [{ listing_id: 'lst_fake' }] } })).status, 400);
  assert.equal((await call('POST', '/api/sign', { mandate: { ...mandate, max_amount: -5 }, cart: teaCart })).status, 400);
});

test('baseline sign (mandate null): receipt records baseline mode, hamper still refused', async () => {
  const { call } = api();
  const ok = await call('POST', '/api/sign', { mandate: null, cart: teaCart });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.receipt.intent_mandate, { mode: 'baseline', policy_pack: 'uk-2026-10', max: null });
  assert.equal(ok.body.receipt.checks.mode, 'baseline');
  const { sig, ...body } = ok.body.receipt;
  assert.equal(sig.value, await sha256Hex(canonicalize(body)));

  const bad = await call('POST', '/api/sign', { mandate: null, cart: hamperCart });
  assert.equal(bad.status, 200); assert.equal(bad.body.ok, false);
  assert.ok(!bad.body.verdict.violations.some((v) => v.code === 'OVER_BUDGET'));
  const [ev] = (await call('GET', '/api/events')).body.events;
  assert.equal(ev.cap, undefined);
});

test('POST /api/events/reset clears the feed', async () => {
  const { call } = api();
  await call('POST', '/api/sign', { mandate, cart: teaCart });
  assert.equal((await call('POST', '/api/events/reset')).body.ok, true);
  assert.deepEqual((await call('GET', '/api/events')).body.events, []);
});

// Brief 5 scenarios through the server path (trust fixture, fees, quantity, notes).
const PAN = '4532 0151 1283 0366';

test('scenario B guard-off → 5 fraud codes, card number never echoed in full', async () => {
  const { call } = api();
  const r = await call('POST', '/api/sign', {
    mandate,
    cart: { items: [{ listing_id: 'lst_afternoon_tea_deals', notes: `Deliver Friday. Card ${PAN} exp 09/28` }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.verdict.violations.map((v) => v.code).sort(),
    ['DATA_EXFIL', 'FIRST_TIME_PAYEE', 'MERCHANT_UNVERIFIED', 'OVER_BUDGET', 'PRICE_DRIFT']);
  const { events } = (await call('GET', '/api/events')).body;
  for (const blob of [JSON.stringify(r.body), JSON.stringify(events)]) {
    assert.ok(!blob.includes(PAN) && !blob.includes(PAN.replace(/ /g, '')), 'full card number leaked');
  }
});

test('scenario C (3 gift cards) refused; B rebuild signs with the exact total', async () => {
  const { call } = api();
  // Scenario C's own mandate: "£300 of Apple gift cards" — 3 × £100 is within the cap.
  const c = await call('POST', '/api/sign', { mandate: { ...mandate, max_amount: 300 }, cart: { items: [{ listing_id: 'lst_apple_gift_card', quantity: 3 }] } });
  assert.equal(c.body.ok, false);
  assert.deepEqual(c.body.verdict.violations.map((v) => v.code).sort(),
    ['FIRST_TIME_PAYEE', 'PRESSURE_CUE', 'QUANTITY_ANOMALY', 'RESTRICTED_CATEGORY']);
  const [ev] = (await call('GET', '/api/events')).body.events;
  assert.match(ev.items[0].name, /^3 × /);

  const b = await call('POST', '/api/sign', { mandate, cart: { items: [{ listing_id: 'lst_afternoon_tea' }] } });
  assert.equal(b.body.ok, true);
  assert.equal(b.body.receipt.cart_mandate.total, (await import('../public/lib/rules.js')).formatPence(b.body.verdict.pending_total));
});

test('agents_paused must be a boolean', async () => {
  const { validatePrefsPatch } = await import('../worker/store.js');
  assert.deepEqual(validatePrefsPatch({ agents_paused: true }), { agents_paused: true });
  assert.throws(() => validatePrefsPatch({ agents_paused: 'yes' }), /true or false/);
});
