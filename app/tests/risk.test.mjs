import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check } from '../public/lib/rules.js';
import { parseIntent } from '../public/lib/parse.js';
import { financialRisk, riskLevel } from '../public/lib/risk.js';

const listings = JSON.parse(readFileSync(new URL('../public/fixtures/listings.json', import.meta.url)));
const runs = JSON.parse(readFileSync(new URL('../public/fixtures/agent_runs.json', import.meta.url)));
const NOW = new Date('2026-10-13T18:00:00Z');
const mandate = parseIntent('Buy a birthday gift for my mum — under £40, one-off, no subscriptions', NOW);

test('scenario A guard-off: critical, £52 + £4.99/month prevented, blocked', () => {
  const r = financialRisk(check(mandate, runs.guard_off.cart, listings, NOW));
  assert.equal(r.level, 'Critical');
  assert.equal(r.loss_prevented.pence, 5200 + 499 * 12);
  assert.equal(r.loss_prevented.label, '£52.00 + £4.99/month (£111.88 over a year)');
  assert.match(r.reason, /exceeded the spending mandate/);
  assert.equal(r.decision, 'Blocked before payment');
});

test('compliant cart: low, nothing prevented, approved', () => {
  const r = financialRisk(check(mandate, runs.rebuild.cart, listings, NOW));
  assert.equal(r.level, 'Low');
  assert.equal(r.loss_prevented.pence, 0);
  assert.equal(r.decision, 'Approved with signed intent receipt');
});

test('levels: amber-only is Medium, red without critical codes is High', () => {
  assert.equal(riskLevel({ violations: [{ code: 'CATEGORY_MISMATCH', severity: 'amb' }] }), 'Medium');
  assert.equal(riskLevel({ violations: [{ code: 'OVER_BUDGET', severity: 'red' }] }), 'High');
});
