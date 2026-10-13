// FinalCheck ops console — IDLE → MANDATE_ARMED → AGENT_SHOPPING → VIOLATIONS → CART_COMPLIANT → SIGNED.
// Element IDs/classes are load-bearing: demo/record_ui.ts drives the video through them.
import { parseIntent, validateMandate, toChips, expiryLabel } from '/lib/parse.js';
import { check, formatPence } from '/lib/rules.js';
import { buildReceipt } from '/lib/receipt.js';

const $ = (id) => document.getElementById(id);
const STAGGER_MS = 350;
const PARSED_BY = { ruleset: 'ruleset', anthropic: 'claude', openai: 'openai' };

let state = 'IDLE';
let data = null;          // { listings, runs, policy }
let mandate = null;
let fixVerdict = null;

const gbp = (p) => formatPence(p);
const gbpShort = (pounds) => '£' + (Number.isInteger(pounds) ? pounds : pounds.toFixed(2));
const hex0x = (v) => (String(v).startsWith('0x') ? String(v) : '0x' + v);
const shortHash = (v) => { const h = hex0x(v); return h.slice(0, 6) + '…' + h.slice(-4); };

function setPill(text, cls) {
  const pill = $('status-pill');
  pill.textContent = text;
  pill.className = 'pill ' + cls;
}

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  $('btn-run').disabled = !(state === 'MANDATE_ARMED' && data);
}

function show(id) {
  $(id).style.display = 'block';
  $(id).dataset.state = 'shown';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Steps come from our own fixtures (agent_runs.json) and carry <b> markup, so innerHTML is
// acceptable here. Merchant-supplied listing text below always goes through textContent.
function renderSteps(container, steps) {
  container.replaceChildren();
  const rows = steps.map((s) => {
    const row = el('li', `frow fade ${s.tone || ''}`.trim());
    row.append(el('span', 't', s.t));
    const body = el('span');
    body.innerHTML = s.text;
    row.append(body);
    container.append(row);
    return row;
  });
  // Layout is fixed up-front; only opacity staggers, so nothing shifts under the recorder's highlight ring.
  rows.forEach((row, i) => setTimeout(() => row.classList.add('on'), i * STAGGER_MS));
}

function renderCart(container, cart, totalLabel) {
  container.replaceChildren();
  let total = 0;
  for (const it of cart.items) {
    total += it.price;
    const row = el('div', it.recurring ? 'row sneak' : 'row');
    row.append(
      el('span', null, it.recurring ? `${it.name} — recurring` : it.name),
      el('span', null, it.recurring ? `${gbp(it.price)}/${it.recurring === 'month' ? 'mo' : it.recurring}` : gbp(it.price)),
    );
    container.append(row);
  }
  const row = el('div', 'row total');
  row.append(el('span', null, totalLabel), el('span', null, gbp(total)));
  container.append(row);
}

function renderListings(cart) {
  const box = $('listings');
  box.replaceChildren();
  const picked = new Set(cart.items.map((i) => i.listing_id));
  let inj = 0;
  for (const l of data.listings) {
    const card = el('div', picked.has(l.id) ? 'listing picked' : 'listing');
    card.append(document.createTextNode(l.name + ' '));
    card.append(el('span', 'merchant', '· ' + l.merchant));
    card.append(el('span', 'price', gbp(l.price)));
    if (l.hidden_text) {
      inj += 1;
      // What the merchant page actually serves: white-on-white, 1px — invisible to the human.
      const raw = el('span', 'hidden-raw', ' ' + l.hidden_text);
      raw.setAttribute('style', l.hidden_style || '');
      raw.setAttribute('aria-hidden', 'true');
      card.append(raw);
      // Revealed by the guard. Displayed as data only — never interpreted.
      const q = el('div', 'hidden-inj', `▸ agent-only text: “${l.hidden_text}”`);
      q.id = 'inj' + inj;
      card.append(q);
    }
    box.append(card);
  }
}

function renderMandate(m, note) {
  mandate = m;
  $('chips').replaceChildren(...toChips(m).map((c) => el('div', 'chip', c)));
  const by = PARSED_BY[m.parsed_by] || m.parsed_by || 'ruleset';
  $('parsed-by').textContent = `parsed by: ${by}` + (note ? ` · ${note}` : '');
  $('mandate-card').classList.add('on');
  $('mandate-card').dataset.state = 'armed';
  if (state === 'IDLE' || state === 'MANDATE_ARMED') {
    setPill('MANDATE ARMED', 'armed');
    setState('MANDATE_ARMED');
  }
}

function showErr(msg) {
  const e = $('mandate-err');
  e.textContent = msg;
  e.classList.toggle('on', !!msg);
}

// 1 — mandate. Client ruleset arms instantly (the floor); /api/parse may then tighten it.
async function onMandate() {
  const btn = $('btn-mandate');
  const text = $('intent').value.trim();
  btn.disabled = true;
  showErr('');
  let local = null;
  let localErr = null;
  try { local = validateMandate(parseIntent(text, new Date())); } catch (e) { localErr = e; }
  if (local) renderMandate(local, 'checking with LLM…');
  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('non-JSON response');
    const body = await res.json();
    if (body.mandate) {
      renderMandate(validateMandate(body.mandate), body.fallback_reason ? 'LLM unavailable, ruleset used' : '');
    } else if (!local) {
      showErr(body.error || localErr?.message || 'could not parse that mandate');
    } else {
      renderMandate(local, '');
    }
  } catch (e) {
    console.warn('[finalcheck] /api/parse unavailable, using client ruleset:', e.message);
    if (local) renderMandate(local, 'parsed in browser');
    else showErr(localErr?.message || e.message);
  } finally {
    btn.disabled = false;
  }
}

// 2 — agent shops with the guard off.
function onRun() {
  if (state !== 'MANDATE_ARMED' || !data) return;
  const run = data.runs.guard_off;
  renderSteps($('feed2'), run.steps);
  renderListings(run.cart);
  renderCart($('cart1'), run.cart, 'Pending checkout');
  show('stage2');
  $('btn-mandate').disabled = true;
  setPill('AGENT SHOPPING', 'armed');
  setState('AGENT_SHOPPING');
}

// POST /api/sign is best-effort: a 404, timeout or bad body returns null and the client flow
// carries on exactly as without it. 409 {ok:false, verdict} = refused; 200 {ok:true, receipt, order_id}.
async function postSign(cart) {
  try {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mandate, cart, region: 'uk', agent: 'console' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!(res.headers.get('content-type') || '').includes('json')) return null;
    return { status: res.status, body: await res.json() };
  } catch (e) {
    console.warn('[finalcheck] /api/sign unavailable:', e.message);
    return null;
  }
}

// 3 — FinalCheck runs every rule against the signed mandate.
function onGuard() {
  if (state !== 'AGENT_SHOPPING') return;
  const v = check(mandate, data.runs.guard_off.cart, data.listings, new Date(), data.policy);
  const flags = $('flags');
  flags.replaceChildren();
  for (const f of v.violations) {
    const red = f.severity === 'red';
    const row = el('li', red ? 'flag red' : 'flag amb');
    row.dataset.severity = red ? 'red' : 'amber';
    row.dataset.code = f.code;
    row.append(el('span', 'ic', red ? '⛔' : '⚠️'));
    const body = el('div');
    body.append(el('b', null, f.title), el('span', null, f.detail));
    if (f.basis || f.ref) body.append(el('span', 'basis', `basis: ${f.basis ?? ''} · ${f.ref ?? ''}`));
    row.append(body);
    flags.append(row);
  }
  const k = v.violations.length;
  const pack = v.policy_pack || data.policy?.id;
  $('vmeta').textContent = `${v.rules_checked} rules checked · ${k} violation${k === 1 ? '' : 's'}` + (pack ? ` · policy: ${pack}` : '');
  document.querySelectorAll('.hidden-inj').forEach((n) => n.classList.add('on'));
  $('verdict').classList.add('on');
  $('verdict').dataset.state = 'shown';
  $('verdict-hint').style.display = 'none';
  $('btn-guard').disabled = true;
  setPill(`${k} VIOLATION${k === 1 ? '' : 'S'} BLOCKED`, k ? 'fired' : 'armed');
  setState('VIOLATIONS');
  // Log the refusal server-side too; the on-screen verdict never waits for it.
  postSign(data.runs.guard_off.cart).then((r) => {
    if (r?.status === 409 && r.body?.ok === false) {
      $('verdict').dataset.server = 'refused';
      $('vmeta').textContent += ' · refusal logged';
    }
  });
}

// 4 — rejected cart goes back; the agent rebuilds and FinalCheck re-checks.
function onFix() {
  if (state !== 'VIOLATIONS') return;
  const run = data.runs.rebuild;
  fixVerdict = check(mandate, run.cart, data.listings, new Date(), data.policy);
  renderSteps($('feed4'), run.steps);
  renderCart($('cart2'), run.cart, 'Checkout');
  const n = fixVerdict.violations.length;
  const pack = fixVerdict.policy_pack || data.policy?.id;
  const ok = $('okline');
  ok.textContent = `${n ? '✗' : '✓'} re-checked: ${n} violation${n === 1 ? '' : 's'} · ${fixVerdict.rules_checked} rules` + (pack ? ` · policy ${pack}` : '');
  ok.classList.toggle('bad', n > 0);
  $('btn-approve').disabled = n > 0;
  show('stage4');
  $('btn-fix').disabled = true;
  setPill(n ? `${n} VIOLATIONS BLOCKED` : 'CART COMPLIANT', n ? 'fired' : 'armed');
  setState('CART_COMPLIANT');
}

// 5 — approve: build the AP2-style receipt and hash it.
async function onApprove() {
  if (state !== 'CART_COMPLIANT' || !fixVerdict?.ok) return;
  const btn = $('btn-approve');
  btn.disabled = true;
  const cart = data.runs.rebuild.cart;
  const listing = data.listings.find((l) => l.id === cart.items[0]?.listing_id) ?? null;
  try {
    const pending = postSign(cart); // in flight while the client receipt renders
    renderReceipt(await buildReceipt(mandate, cart, fixVerdict, data.policy, listing));
    setPill(`SIGNED · ${window.__receipt.cart_mandate.total} RELEASED`, 'signed');
    setState('SIGNED');
    const r = await pending;
    if (r?.body?.ok === true && r.body.receipt?.sig?.value) {
      const client = window.__receipt;
      try {
        renderReceipt(r.body.receipt, r.body.order_id);
        $('receipt').dataset.source = 'server';
      } catch (e) {
        console.warn('[finalcheck] server receipt unreadable, keeping client receipt:', e.message);
        renderReceipt(client);
      }
    }
  } catch (e) {
    console.error('[finalcheck] receipt failed:', e);
    btn.disabled = false;
    $('okline').textContent = '✗ could not build the receipt — ' + e.message;
    $('okline').classList.add('bad');
  }
}

function renderReceipt(receipt, orderId = null) {
  window.__receipt = orderId ? { ...receipt, order_id: orderId } : receipt;
  const flags = [mandate.category, `≤${gbpShort(Number(mandate.max_amount))}`, mandate.one_off ? 'one-off' : 'recurring ok'];
  const items = receipt.cart_mandate.items.map((i) => `${i.name} ${i.price}`).join(', ');
  $('receipt-pre').textContent = [
    '{',
    `  "mandate": "${flags.join(' · ')}",`,
    `  "cart":    "${items}",`,
    `  "checked": "${receipt.checks.rules} rules · ${receipt.checks.violations} violations",`,
    `  "intent":  "${shortHash(receipt.intent_mandate.hash)}",`,
    `  "sig":     "${shortHash(receipt.sig.value)}",`,
    `  "expires": "${expiryLabel(receipt.expires)}"` + (orderId ? ',' : ''),
    ...(orderId ? [`  "order":   "${orderId}"`] : []),
    '}',
  ].join('\n');
  $('sig-full').textContent = hex0x(receipt.sig.value);
  const rb = data.policy?.receipt;
  $('receipt-basis').textContent = rb ? `basis: ${rb.basis} · ${rb.ref}` : '';
  $('receipt').classList.add('on');
  $('receipt').dataset.state = 'signed';
}

async function onCopy() {
  const btn = $('btn-copy');
  const json = JSON.stringify(window.__receipt, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    const ta = el('textarea');
    ta.value = json;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = 'Copy receipt JSON'; }, 1500);
}

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  $('btn-mandate').addEventListener('click', onMandate);
  $('btn-run').addEventListener('click', onRun);
  $('btn-guard').addEventListener('click', onGuard);
  $('btn-fix').addEventListener('click', onFix);
  $('btn-approve').addEventListener('click', onApprove);
  $('btn-copy').addEventListener('click', onCopy);
  $('btn-reset').addEventListener('click', () => location.reload());
  setState('IDLE');
  try {
    const [listings, runs, policy] = await Promise.all([
      loadJSON('/fixtures/listings.json'),
      loadJSON('/fixtures/agent_runs.json'),
      loadJSON('/policies/uk.json'),
    ]);
    data = { listings, runs, policy };
    setState(state);
  } catch (e) {
    console.error('[finalcheck] boot failed:', e);
    showErr('couldn’t load demo data — ' + e.message);
  }
}

boot();
