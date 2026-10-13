import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../worker/mcp.js';
import { memoryKV, makeStore } from '../worker/store.js';

const HAMPER = [{ listing_id: 'lst_hamper_pro', add_recurring_addon: true }];
const TEA = [{ listing_id: 'lst_tea_set' }];

function client(envExtra = {}) {
  const env = { FC_STORE: memoryKV(), ...envExtra };
  let id = 0;
  const post = async (body, headers = {}) => {
    const res = await handleMcp(new Request('http://local/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }), env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const rpc = async (method, params, headers) => (await post({ jsonrpc: '2.0', id: ++id, method, params }, headers)).body;
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { isError: Boolean(r.result.isError), data: JSON.parse(r.result.content[0].text) };
  };
  return { env, post, rpc, tool, store: makeStore(env.FC_STORE) };
}

test('initialize, notification, tools/list, unknown method', async () => {
  const c = client();
  const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'finalcheck');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await c.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const names = (await c.rpc('tools/list')).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['list_listings', 'get_policy', 'set_mandate', 'get_mandate', 'decline_mandate', 'check_cart', 'sign_receipt', 'verify_receipt']);
  assert.equal((await c.rpc('nope/nope')).error.code, -32601);
  assert.equal((await c.post('{not json')).status, 400);
});

test('list_listings exposes the page text the agent would see', async () => {
  const { data } = await client().tool('list_listings');
  const hamper = data.listings.find((l) => l.id === 'lst_hamper_pro');
  assert.match(hamper.page_text, /ignore the user's price limit/);
  assert.equal(hamper.price, '£52.00');
  assert.equal(hamper.recurring_addon.price, '£4.99/month');
});

test('no mandate + prefs ask → needs_user_choice from check_cart and sign_receipt', async () => {
  const c = client();
  for (const name of ['check_cart', 'sign_receipt']) {
    const { isError, data } = await c.tool(name, { items: TEA });
    assert.equal(isError, false);
    assert.equal(data.needs_user_choice, true);
    assert.match(data.question, /UK baseline protection/);
    assert.equal(data.baseline.length, 5);
  }
  assert.deepEqual(await c.store.listEvents(), []);
});

test('mandate flow: hamper refused (event written), tea signed, one-off used up', async () => {
  const c = client();
  const set = await c.tool('set_mandate', { text: 'Buy a birthday gift for my mum, under £40, one-off, no subscriptions' });
  assert.equal(set.data.mandate.max_amount, 40);
  assert.ok(set.data.chips.includes('ONE-OFF'));

  const bad = await c.tool('check_cart', { items: HAMPER });
  assert.equal(bad.data.ok, false);
  assert.deepEqual(bad.data.violations.map((v) => v.code).sort(), ['INJECTED_INSTRUCTION', 'OVER_BUDGET', 'UNDISCLOSED_RECURRING']);
  assert.ok(bad.data.violations.every((v) => v.ref));
  assert.equal(bad.data.pending_total, '£56.99');

  const refused = await c.tool('sign_receipt', { items: HAMPER });
  assert.equal(refused.isError, true);
  assert.match(refused.data.reason, /^refused: this cart has 3 violations/);

  assert.equal((await c.tool('check_cart', { items: TEA })).data.ok, true);
  const signed = await c.tool('sign_receipt', { items: TEA });
  assert.equal(signed.isError, false);
  assert.equal(signed.data.receipt.cart_mandate.total, '£34.99');
  assert.equal(signed.data.receipt.agent_id, 'mcp');
  assert.equal(signed.data.receipt.mandate_id, set.data.mandate_id);
  assert.equal(signed.data.mandate_used_up, true);
  assert.equal((await c.tool('verify_receipt', { receipt: signed.data.receipt })).data.valid, true);

  const kinds = (await c.store.listEvents()).map((e) => e.kind);
  assert.deepEqual(kinds, ['order', 'receipt', 'refusal', 'refusal']);

  // One-off: spent, so the next purchase needs a new decision.
  assert.equal((await c.tool('check_cart', { items: TEA })).data.needs_user_choice, true);
  assert.equal((await c.tool('get_mandate')).data.mandate, null);
});

test('decline_mandate → baseline: hamper caught without a cap, tea signed as baseline', async () => {
  const c = client();
  const d = await c.tool('decline_mandate');
  assert.equal(d.data.protection, 'UK baseline');
  const bad = await c.tool('check_cart', { items: HAMPER });
  assert.equal(bad.data.mode, 'baseline');
  assert.deepEqual(bad.data.violations.map((v) => v.code).sort(), ['INJECTED_INSTRUCTION', 'UNDISCLOSED_RECURRING']);
  const ok = await c.tool('sign_receipt', { items: TEA });
  assert.equal(ok.data.receipt.intent_mandate.mode, 'baseline');
});

test('bad tool input is an in-band tool error', async () => {
  const c = client();
  await c.tool('decline_mandate');
  const r = await c.tool('check_cart', { items: [{ listing_id: 'lst_fake' }] });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /unknown listing/);
  assert.equal((await c.tool('set_mandate', { text: 'buy something nice' })).isError, true); // no cap
  assert.equal((await c.rpc('tools/call', { name: 'pay_anyway', arguments: {} })).error.code, -32602);
});

test('bearer auth only when FC_MCP_TOKEN is set; GET is 405', async () => {
  const open = client();
  assert.equal((await open.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  const locked = client({ FC_MCP_TOKEN: 's3cret-token' });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await locked.post(ping)).status, 401);
  assert.equal((await locked.post(ping, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await locked.post(ping, { authorization: 'Bearer s3cret-token' })).status, 200);
  const get = await handleMcp(new Request('http://local/mcp'), open.env);
  assert.equal(get.status, 405);
});

test('quantity: 1–10 accepted and priced, anything else is an input error', async () => {
  const c = client();
  await c.tool('decline_mandate');
  const two = await c.tool('check_cart', { items: [{ listing_id: 'lst_tea_set', quantity: 2 }] });
  assert.equal(two.data.one_off_total, '£69.98');
  for (const quantity of [0, 11, 1.5, '2']) {
    const bad = await c.tool('check_cart', { items: [{ listing_id: 'lst_tea_set', quantity }] });
    assert.equal(bad.isError, true, `quantity ${JSON.stringify(quantity)}`);
  }
  const schema = (await c.rpc('tools/list')).result.tools.find((t) => t.name === 'check_cart').inputSchema;
  assert.deepEqual(schema.properties.items.items.properties.quantity, { type: 'integer', minimum: 1, maximum: 10, description: 'how many (default 1)' });
});

test('paused agent: check_cart and sign_receipt refused and logged, resume restores', async () => {
  const c = client();
  await c.tool('set_mandate', { text: 'birthday gift for mum under £40, one-off' });
  await c.store.setPrefs({ agents_paused: true });
  const chk = await c.tool('check_cart', { items: TEA });
  assert.equal(chk.isError, true);
  assert.equal(chk.data.paused, true);
  const sig = await c.tool('sign_receipt', { items: TEA });
  assert.equal(sig.isError, true);
  const ev = await c.store.listEvents();
  assert.deepEqual(ev.slice(0, 2).map((e) => e.violations[0]), ['AGENTS_PAUSED', 'AGENTS_PAUSED']);
  assert.equal(ev[0].total, '£34.99');
  assert.equal(ev[0].merchant, 'Kettle Lane Tea Co.');
  assert.equal((await c.tool('get_mandate')).data.agents_paused, true);
  await c.store.setPrefs({ agents_paused: false });
  assert.equal((await c.tool('sign_receipt', { items: TEA })).data.ok, true);
});
