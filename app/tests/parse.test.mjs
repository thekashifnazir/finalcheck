import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, validateMandate, mergeMandate, toChips } from '../public/lib/parse.js';

const NOW = new Date('2026-10-13T18:00:00Z'); // Tue, BST
const DEMO = 'Buy a birthday gift for my mum — under £40, one-off, no subscriptions';

test('demo sentence → £40 one-off gift, expires Fri 23:59 London', () => {
  const m = parseIntent(DEMO, NOW);
  assert.equal(m.max_amount, 40);
  assert.equal(m.one_off, true);
  assert.equal(m.allow_recurring, false);
  assert.equal(m.category, 'gift');
  assert.equal(m.expires, '2026-10-16T22:59:00.000Z'); // 23:59 BST
  assert.equal(m.parsed_by, 'ruleset');
});

test('subscriptions ok → recurring allowed', () => {
  const m = parseIntent('up to £75 for a present, subscriptions ok', NOW);
  assert.equal(m.max_amount, 75);
  assert.equal(m.allow_recurring, true);
  assert.equal(m.one_off, false);
});

test('expiry after the clocks change uses GMT', () => {
  const m = parseIntent('gift under £10', new Date('2026-10-27T09:00:00Z'));
  assert.equal(m.expires, '2026-10-30T23:59:00.000Z');
});

test('"by Wednesday" overrides the Friday default', () => {
  assert.equal(parseIntent('gift under £10 by Wednesday', NOW).expires, '2026-10-14T22:59:00.000Z');
});

test('no amount → validate throws the friendly message', () => {
  assert.throws(() => validateMandate(parseIntent('buy mum something nice', NOW)), /couldn’t find a spending cap/);
});

test('chips in order', () => {
  assert.deepEqual(toChips(parseIntent(DEMO, NOW)), ['MAX £40', 'ONE-OFF', 'CATEGORY: GIFT', 'EXPIRES FRI 23:59', 'NO RECURRING']);
});

test('merge: LLM cannot loosen', () => {
  const floor = parseIntent(DEMO, NOW);
  const m = mergeMandate(floor, { max_amount: 90, allow_recurring: true, one_off: false });
  assert.equal(m.max_amount, 40);
  assert.equal(m.allow_recurring, false);
  assert.equal(m.one_off, true);
});

test('merge: LLM can tighten', () => {
  assert.equal(mergeMandate(parseIntent(DEMO, NOW), { max_amount: 35 }).max_amount, 35);
});

test('merge: LLM fills a missing cap', () => {
  const m = mergeMandate(parseIntent('buy mum something nice', NOW), { max_amount: 60 });
  assert.equal(m.max_amount, 60);
  assert.equal(validateMandate(m), m);
});
