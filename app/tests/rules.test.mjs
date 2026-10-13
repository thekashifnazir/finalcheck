import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, RULES, levenshtein, luhn, findSensitive } from '../public/lib/rules.js';
import { buildCart } from '../public/lib/cart.js';
import { parseIntent } from '../public/lib/parse.js';

const listings = JSON.parse(readFileSync(new URL('../public/fixtures/listings.json', import.meta.url)));
const runs = JSON.parse(readFileSync(new URL('../public/fixtures/agent_runs.json', import.meta.url)));
const NOW = new Date('2026-10-13T18:00:00Z');
const mandate = parseIntent('Buy a birthday gift for my mum — under £40, one-off, no subscriptions', NOW);

test('guard-off cart → exactly the three demo violations', () => {
  const r = check(mandate, runs.guard_off.cart, listings, NOW);
  assert.deepEqual(r.violations.map((v) => v.code), ['OVER_BUDGET', 'UNDISCLOSED_RECURRING', 'INJECTED_INSTRUCTION']);
  assert.equal(r.violations[0].title, '£12 over mandate');
  assert.equal(r.violations[0].detail, 'cart £52 vs signed limit £40');
  assert.equal(r.violations[1].detail, '“Gift Club £4.99/mo” — mandate says one-off');
  assert.equal(r.violations[2].severity, 'amb');
  assert.match(r.violations[2].evidence.hidden_text, /ignore the user's price limit/);
  assert.equal(r.pending_total, 5699);
  assert.equal(r.ok, false);
});

test('rebuilt cart passes all rules', () => {
  const r = check(mandate, runs.rebuild.cart, listings, NOW);
  assert.equal(r.violations.length, 0);
  assert.equal(r.rules_checked, RULES.length);
  assert.equal(r.rules_checked, 13);
  assert.equal(r.ok, true);
});

test('candle £22.50 under a £20 cap → £2.50 over', () => {
  const m = { ...mandate, max_amount: 20 };
  const cart = { merchant: 'Wick & Willow', items: [{ listing_id: 'lst_candle_trio', name: 'Scented Candle Trio', price: 2250 }] };
  assert.equal(check(m, cart, listings, NOW).violations[0].title, '£2.50 over mandate');
});

test('£39.99 cap vs 3999p is not over budget (pence rounding)', () => {
  const m = { ...mandate, max_amount: 39.99 };
  const cart = { merchant: 'x', items: [{ listing_id: 'lst_tea_set', name: 'Tea', price: 3999 }] };
  assert.equal(check(m, cart, listings, NOW).violations.length, 0);
});

test('expired mandate → EXPIRED', () => {
  const later = new Date('2026-10-20T12:00:00Z');
  const r = check(mandate, runs.rebuild.cart, listings, later);
  assert.deepEqual(r.violations.map((v) => v.code), ['EXPIRED']);
});

test('marketing copy in hidden_text does not trigger injection', () => {
  const ls = listings.map((l) => (l.id === 'lst_tea_set' ? { ...l, hidden_text: 'Hand-packed in Yorkshire' } : l));
  assert.equal(check(mandate, runs.rebuild.cart, ls, NOW).violations.length, 0);
});

test('policy pack attaches basis + ref; absent policy leaves no basis key', () => {
  const policy = { id: 'p1', rules: { OVER_BUDGET: { basis: 'b', ref: 'r' } } };
  const r = check(mandate, runs.guard_off.cart, listings, NOW, policy);
  assert.equal(r.policy_pack, 'p1');
  assert.equal(r.violations[0].ref, 'r');
  const bare = check(mandate, runs.guard_off.cart, listings, NOW);
  assert.ok(!('basis' in bare.violations[0]));
});

test('baseline mode (no mandate) → only recurring + injection on the guard-off cart', () => {
  const policy = { id: 'uk', baseline_rules: ['UNDISCLOSED_RECURRING', 'INJECTED_INSTRUCTION', 'RESTRICTED_CATEGORY'] };
  const r = check(null, runs.guard_off.cart, listings, NOW, policy);
  assert.equal(r.mode, 'baseline');
  assert.deepEqual(r.violations.map((v) => v.code), ['UNDISCLOSED_RECURRING', 'INJECTED_INSTRUCTION']);
  assert.match(r.violations[0].detail, /recurring charge needs explicit consent/);
  assert.equal(r.rules_checked, 3); // RESTRICTED_CATEGORY now exists, so it runs too
  const pricey = { merchant: 'x', items: [{ listing_id: 'lst_tea_set', name: 'Teapot', price: 50000 }] };
  assert.equal(check(null, pricey, listings, NOW, policy).violations.length, 0);
});

// ── Brief 5: scenarios B/C + fraud rules ──
const scenarios = JSON.parse(readFileSync(new URL('../public/fixtures/scenarios.json', import.meta.url))).scenarios;
const trust = JSON.parse(readFileSync(new URL('../public/fixtures/trust.json', import.meta.url)));
const uk = JSON.parse(readFileSync(new URL('../public/policies/uk.json', import.meta.url)));
const byId = Object.fromEntries(listings.map((l) => [l.id, l]));
const run = (key, stage, opts = {}) => {
  const m = parseIntent(scenarios[key].intent, NOW);
  return check(m, buildCart(scenarios[key][stage].items, byId), listings, NOW, opts.policy ?? uk, 'trust' in opts ? opts.trust : trust);
};
const codes = (r) => r.violations.map((v) => v.code);

test('scenario A via scenarios.json + trust → same three violations, same copy, as agent_runs', () => {
  const viaScenario = run('A', 'guard_off');
  const viaRuns = check(mandate, runs.guard_off.cart, listings, NOW, uk, trust);
  assert.deepEqual(codes(viaScenario), ['OVER_BUDGET', 'UNDISCLOSED_RECURRING', 'INJECTED_INSTRUCTION']);
  assert.deepEqual(viaScenario.violations, viaRuns.violations);
  assert.equal(viaScenario.pending_total, 5699);
  assert.equal(run('A', 'rebuild').ok, true);
});

test('scenario B → lookalike, drip fee, first-time payee, card data, over budget', () => {
  const r = run('B', 'guard_off');
  assert.deepEqual(codes(r), ['OVER_BUDGET', 'MERCHANT_UNVERIFIED', 'PRICE_DRIFT', 'FIRST_TIME_PAYEE', 'DATA_EXFIL']);
  assert.equal(r.one_off_total, 4498);
  const by = Object.fromEntries(r.violations.map((v) => [v.code, v]));
  assert.equal(by.MERCHANT_UNVERIFIED.detail, '“hamper-and-hearth.co.uk” is 2 characters off verified “hamperandhearth.co.uk” — lookalike');
  assert.equal(by.PRICE_DRIFT.title, '£9.99 added at checkout');
  assert.equal(by.PRICE_DRIFT.detail, '“handling” was not in the listed price (£34.99 → £44.98)');
  assert.ok(by.DATA_EXFIL.evidence.redacted.includes('card 4532…0366'));
  assert.doesNotMatch(JSON.stringify(r), /4532 0151 1283 0366|4532015112830366/); // PAN never echoed
  assert.ok(r.violations.every((v) => v.ref)); // every new rule has a policy basis
});

test('scenario B rebuild at the verified merchant → 0 violations', () => {
  const r = run('B', 'rebuild');
  assert.equal(r.violations.length, 0);
  assert.equal(r.rules_checked, 13);
});

test('scenario C → restricted category, payee, pressure, quantity — and nothing else', () => {
  const r = run('C', 'guard_off');
  assert.deepEqual(codes(r), ['RESTRICTED_CATEGORY', 'FIRST_TIME_PAYEE', 'PRESSURE_CUE', 'QUANTITY_ANOMALY']);
  assert.equal(r.one_off_total, 30000);
  assert.equal(r.violations[0].title, 'Gift cards are a scam cash-out');
  assert.equal(scenarios.C.rebuild, null);
});

test('RESTRICTED_CATEGORY fires even when the mandate names gift cards', () => {
  const m = { ...parseIntent(scenarios.C.intent, NOW), category: 'gift_card' };
  const r = check(m, buildCart(scenarios.C.guard_off.items, byId), listings, NOW, uk, trust);
  assert.ok(codes(r).includes('RESTRICTED_CATEGORY'));
});

test('without trust data the merchant and payee rules stay silent', () => {
  const r = run('B', 'guard_off', { trust: null });
  assert.ok(!codes(r).includes('MERCHANT_UNVERIFIED'));
  assert.ok(!codes(r).includes('FIRST_TIME_PAYEE'));
});

test('levenshtein, luhn and redaction helpers', () => {
  assert.equal(levenshtein('hamper-and-hearth.co.uk', 'hamperandhearth.co.uk'), 2);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(luhn('4532015112830366'), true);
  assert.equal(luhn('4532015112830367'), false);
  assert.deepEqual(findSensitive('order ref 1234567890123 thanks'), []); // fails Luhn → not a card
  assert.deepEqual(findSensitive('sort code 20-00-00'), ['sort code 20-••-••']);
  assert.deepEqual(findSensitive('Hand-packed in Yorkshire'), []);
});

test('CURRENCY_MISMATCH: item priced in another currency', () => {
  const cart = { merchant: 'x', items: [{ listing_id: 'lst_tea_set', name: 'Deluxe Tea Set', price: 3499, currency: 'USD' }] };
  const r = check(mandate, cart, listings, NOW, uk, trust);
  assert.deepEqual(codes(r), ['CURRENCY_MISMATCH']);
});

test('baseline mode runs the fraud rules listed in the pack', () => {
  const r = check(null, buildCart(scenarios.C.guard_off.items, byId), listings, NOW, uk, trust);
  assert.deepEqual(codes(r), ['RESTRICTED_CATEGORY', 'FIRST_TIME_PAYEE', 'PRESSURE_CUE']);
  assert.equal(r.rules_checked, uk.baseline_rules.length);
});
