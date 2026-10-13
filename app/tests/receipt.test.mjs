import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalize, sha256Hex, buildReceipt } from '../public/lib/receipt.js';

const policy = JSON.parse(await readFile(new URL('../public/policies/uk.json', import.meta.url), 'utf8'));

const mandate = {
  raw: 'Buy a birthday gift for my mum, under £40, one-off, no subscriptions, by Friday',
  currency: 'GBP',
  max_amount: 40,
  one_off: true,
  allow_recurring: false,
  category: 'gift',
  expires: '2026-10-16T22:59:00.000Z',
  parsed_by: 'ruleset',
};
const listing = { id: 'tea-set', name: 'Deluxe Tea Set', merchant: 'Kettle Lane Tea Co.', price: 3499, category: 'gift' };
const cart = { merchant: 'Kettle Lane Tea Co.', items: [{ listing_id: 'tea-set', name: 'Deluxe Tea Set', price: 3499 }] };
const verdict = { violations: [], rules_checked: 5, ok: true, policy_pack: 'uk-2026-10' };

test('sha256Hex is deterministic and 0x-prefixed', async () => {
  const a = await sha256Hex('finalcheck');
  assert.equal(a, await sha256Hex('finalcheck'));
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, await sha256Hex('finalcheck!'));
});

test('canonicalize sorts keys at every depth, whatever the input order', () => {
  const x = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } };
  const y = { a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalize(x), canonicalize(y));
  assert.equal(canonicalize(x), '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('intent hash is the same for a mandate with reordered keys', async () => {
  const reordered = Object.fromEntries(Object.entries(mandate).reverse());
  const r1 = await buildReceipt(mandate, cart, verdict, policy, listing);
  const r2 = await buildReceipt(reordered, cart, verdict, policy, listing);
  assert.equal(r1.intent_mandate.hash, r2.intent_mandate.hash);
  assert.match(r1.intent_mandate.hash, /^0x[0-9a-f]{64}$/);
});

test('Deluxe Tea Set receipt: shape, money strings, demo sig', async () => {
  const r = await buildReceipt(mandate, cart, verdict, policy, listing);
  assert.equal(r.type, 'finalcheck/cart-mandate-receipt');
  assert.equal(r.version, '0.1');
  assert.equal(r.intent_mandate.max, '£40.00');
  assert.equal(r.cart_mandate.merchant, 'Kettle Lane Tea Co.');
  assert.deepEqual(r.cart_mandate.items, [{ name: 'Deluxe Tea Set', price: '£34.99' }]);
  assert.equal(r.cart_mandate.total, '£34.99');
  assert.equal(r.checks.policy_pack, 'uk-2026-10');
  assert.equal(r.checks.rules, 5);
  assert.equal(r.checks.violations, 0);
  assert.equal(r.checks.basis, policy.receipt.ref);
  assert.equal(r.expires, mandate.expires);
  assert.match(r.sig.alg, /^sha256-demo/);
  assert.ok(r.sig.value.startsWith('0x'));

  // The demo sig is recomputable: hash of the canonical receipt without sig.
  const { sig, ...body } = r;
  assert.equal(sig.value, await sha256Hex(canonicalize(body)));
});

test('signer hook is used when passed, with the canonical body', async () => {
  let seen = null;
  const signer = async (canonicalJson) => {
    seen = canonicalJson;
    return { alg: 'ES256', value: '0xsigned', kid: 'demo-key-1' };
  };
  const r = await buildReceipt(mandate, cart, verdict, policy, listing, signer);
  assert.deepEqual(r.sig, { alg: 'ES256', value: '0xsigned', kid: 'demo-key-1' });
  const { sig, ...body } = r;
  assert.equal(seen, canonicalize(body));
});

test('recurring items render per-period and count toward total', async () => {
  const hamperCart = {
    merchant: 'Hamper & Hearth',
    items: [
      { listing_id: 'hamper-pro', name: 'Luxury Hamper Pro', price: 5200 },
      { listing_id: 'gift-club', name: 'Gift Club', price: 499, recurring: 'month' },
    ],
  };
  const r = await buildReceipt(mandate, hamperCart, { violations: [{}, {}, {}], rules_checked: 5, ok: false }, policy, null);
  assert.equal(r.cart_mandate.items[1].price, '£4.99/month');
  assert.equal(r.cart_mandate.total, '£56.99');
  assert.equal(r.checks.violations, 3);
  assert.equal(r.checks.policy_pack, 'uk-2026-10'); // falls back to policy.id
});

test('total counts quantity and checkout fees', async () => {
  const c = {
    merchant: 'X',
    items: [{ listing_id: 'a', name: 'Mug', price: 1000, quantity: 2, fees: [{ label: 'Service', amount: 250 }, { label: 'P&P', amount: 199 }] }],
  };
  const r = await buildReceipt(mandate, c, verdict, policy, null);
  assert.equal(r.cart_mandate.total, '£24.49');
  assert.deepEqual(r.cart_mandate.items, [{ name: 'Mug', price: '£10.00', quantity: 2, fees: '£4.49' }]);
});
