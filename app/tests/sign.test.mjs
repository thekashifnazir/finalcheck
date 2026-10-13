import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReceipt, ed25519Signer, verifyReceipt, keyId, publicJwk } from '../public/lib/receipt.js';
import { handleConsole } from '../worker/console.js';
import { memoryKV } from '../worker/store.js';

const policy = JSON.parse(await readFile(new URL('../public/policies/uk.json', import.meta.url), 'utf8'));
const mandate = {
  currency: 'GBP', max_amount: 40, one_off: true, allow_recurring: false, category: 'gift',
  expires: new Date(Date.now() + 86_400_000).toISOString(), parsed_by: 'ruleset',
};
const cart = { merchant: 'Kettle Lane Tea Co.', items: [{ listing_id: 'lst_tea_set', name: 'Deluxe Tea Set', price: 3499 }] };
const verdict = { violations: [], rules_checked: 5, ok: true, policy_pack: 'uk-2026-10' };

async function keypair() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { priv: await crypto.subtle.exportKey('jwk', privateKey), pub: await crypto.subtle.exportKey('jwk', publicKey) };
}

test('Ed25519 receipt verifies; any edit or another key fails', async () => {
  const { priv, pub } = await keypair();
  const r = await buildReceipt(mandate, cart, verdict, policy, null, await ed25519Signer(priv), { agent_id: 'mcp' });
  assert.equal(r.sig.alg, 'Ed25519');
  assert.equal(r.sig.kid, await keyId(pub));
  assert.match(r.sig.value, /^0x[0-9a-f]{128}$/);
  assert.equal(r.agent_id, 'mcp');
  assert.deepEqual(await verifyReceipt(r, pub), { valid: true, alg: 'Ed25519', kid: r.sig.kid });

  const tampered = structuredClone(r);
  tampered.cart_mandate.total = '£3.49';
  assert.equal((await verifyReceipt(tampered, pub)).valid, false);
  const relabelled = { ...structuredClone(r), agent_id: 'rogue' };
  assert.equal((await verifyReceipt(relabelled, pub)).valid, false);

  const other = await keypair();
  const v = await verifyReceipt(r, other.pub);
  assert.equal(v.valid, false);
  assert.match(v.reason, /unknown key/);
  assert.equal((await verifyReceipt(r, null)).valid, false);
});

test('sha256-demo receipt verifies as integrity only', async () => {
  const r = await buildReceipt(mandate, cart, verdict, policy, null);
  const v = await verifyReceipt(r);
  assert.equal(v.valid, true);
  assert.match(v.reason, /integrity only/);
  assert.equal((await verifyReceipt({ ...r, expires: 'never' })).valid, false);
  assert.equal((await verifyReceipt({ nosig: true })).valid, false);
});

test('baseline receipt (mandate null) records mode, not a cap', async () => {
  const r = await buildReceipt(null, cart, { ...verdict, mode: 'baseline' }, policy, null);
  assert.deepEqual(r.intent_mandate, { mode: 'baseline', policy_pack: 'uk-2026-10', max: null });
  assert.equal(r.checks.mode, 'baseline');
  assert.equal(r.expires, null);
  assert.equal((await verifyReceipt(r)).valid, true);
});

function api(env) {
  return async (method, path, body) => {
    const url = new URL(path, 'http://local');
    const init = { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    const res = await handleConsole(new Request(url, init), env, url);
    return { status: res.status, body: await res.json() };
  };
}

test('/api/sign signs with the env key; /api/keys and /api/verify agree', async () => {
  const { priv, pub } = await keypair();
  const call = api({ FC_STORE: memoryKV(), FC_SIGNING_PRIVATE_JWK: JSON.stringify(priv), FC_SIGNING_PUBLIC_JWK: JSON.stringify(pub) });
  const keys = (await call('GET', '/api/keys')).body;
  assert.equal(keys.alg, 'Ed25519');
  assert.deepEqual(keys.public_key, publicJwk(pub));
  assert.equal(keys.public_key.d, undefined); // never leak the private part

  const s = (await call('POST', '/api/sign', { mandate, cart })).body;
  assert.equal(s.ok, true);
  assert.equal(s.receipt.sig.alg, 'Ed25519');
  assert.equal(s.receipt.sig.kid, keys.kid);
  assert.equal((await call('POST', '/api/verify', { receipt: s.receipt })).body.valid, true);
  s.receipt.cart_mandate.total = '£0.01';
  assert.equal((await call('POST', '/api/verify', { receipt: s.receipt })).body.valid, false);
});

test('without a key: /api/keys says so and receipts fall back to sha256-demo', async () => {
  const call = api({ FC_STORE: memoryKV() });
  const keys = (await call('GET', '/api/keys')).body;
  assert.equal(keys.signing, false);
  const s = (await call('POST', '/api/sign', { mandate, cart })).body;
  assert.match(s.receipt.sig.alg, /^sha256-demo/);
  assert.equal((await call('POST', '/api/verify', { receipt: s.receipt })).body.valid, true);
});

test('gen-keys prints two loadable JWK lines', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [new URL('../scripts/gen-keys.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  const vars = Object.fromEntries(out.trim().split('\n').map((l) => l.match(/^(\w+)='(.*)'$/).slice(1)));
  assert.deepEqual(Object.keys(vars), ['FC_SIGNING_PRIVATE_JWK', 'FC_SIGNING_PUBLIC_JWK']);
  const priv = JSON.parse(vars.FC_SIGNING_PRIVATE_JWK);
  const pub = JSON.parse(vars.FC_SIGNING_PUBLIC_JWK);
  assert.ok(priv.d && !pub.d);
  const r = await buildReceipt(mandate, cart, verdict, policy, null, await ed25519Signer(priv));
  assert.equal((await verifyReceipt(r, pub)).valid, true);
});
