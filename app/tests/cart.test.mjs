import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCart, cartTotals } from '../public/lib/cart.js';

const listings = JSON.parse(readFileSync(new URL('../public/fixtures/listings.json', import.meta.url)));
const runs = JSON.parse(readFileSync(new URL('../public/fixtures/agent_runs.json', import.meta.url)));
const byId = Object.fromEntries(listings.map((l) => [l.id, l]));

test('scenario A items rebuild the agent_runs guard-off cart', () => {
  const cart = buildCart([{ listing_id: 'lst_hamper_pro', add_recurring_addon: true }], byId);
  assert.equal(cart.merchant, runs.guard_off.cart.merchant);
  assert.deepEqual(cart.items.map(({ quantity, ...rest }) => rest), runs.guard_off.cart.items);
  assert.deepEqual(cartTotals(cart), { one_off_total: 5200, recurring_total: 499, pending_total: 5699 });
});

test('quantity, fees and notes carry through; one_off_total = Σ price × qty + Σ fees', () => {
  const cart = buildCart([
    { listing_id: 'lst_afternoon_tea_deals', notes: 'for Mum x' },
    { listing_id: 'lst_apple_gift_card', quantity: 3 },
  ], byId);
  assert.deepEqual(cart.items[0].fees, [{ label: 'handling', amount: 999 }]);
  assert.equal(cart.items[0].notes, 'for Mum x');
  assert.equal(cart.items[1].quantity, 3);
  assert.equal(cartTotals(cart).one_off_total, 3499 + 999 + 30000);
});

test('bad quantity falls back to 1; unknown listing throws', () => {
  assert.equal(buildCart([{ listing_id: 'lst_tea_set', quantity: -2 }], byId).items[0].quantity, 1);
  assert.throws(() => buildCart([{ listing_id: 'nope' }], byId), /unknown listing_id/);
});
