// FinalCheck ops console — IDLE → MANDATE_ARMED → AGENT_SHOPPING → VIOLATIONS → CART_COMPLIANT → SIGNED.
// Element IDs/classes are load-bearing: demo/record_ui.ts drives the video through them.
import { parseIntent, validateMandate, toChips, expiryLabel } from '/lib/parse.js';
import { check, formatPence } from '/lib/rules.js';
import { buildCart, cartTotals } from '/lib/cart.js';
import { buildReceipt } from '/lib/receipt.js';

const $ = (id) => document.getElementById(id);
const STAGGER_MS = 350;
const PARSED_BY = { ruleset: 'ruleset', anthropic: 'claude', openai: 'openai' };

let state = 'IDLE';
let data = null;          // { listings, byId, scenarios, trust, policy }
let scenarioKey = 'A';
let keys = null;          // GET /api/keys; null → no server to verify against (static mode), buttons stay hidden
let runToken = 0;         // bumped on scenario reset so late /api/sign replies can't touch a new run
let mandate = null;
let fixVerdict = null;
let guardVerdict = null;
let baseline = false;     // mandate === null → only the pack's baseline_rules run
let region = 'uk';
const packs = {};         // region → policy pack JSON, fetched on first use

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
  $('baseline-toggle').disabled = !(state === 'IDLE' || state === 'MANDATE_ARMED');
  $('pack-select').disabled = state === 'SIGNED' || state === 'HALTED' || !data; // a record is issued under one pack
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

const scn = () => data.scenarios[scenarioKey];
const guardCart = () => buildCart(scn().guard_off.items, data.byId);
const rebuildCart = () => (scn().rebuild ? buildCart(scn().rebuild.items, data.byId) : null);
const runCheck = (cart) => check(mandate, cart, data.listings, new Date(), data.policy, data.trust);
// /api/sign rebuilds every scenario's cart server-side (shared buildCart: quantity, notes, fees).
const serverSigns = () => true;

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
  for (const it of cart.items) {
    const qty = it.quantity ?? 1;
    const row = el('div', it.recurring ? 'row sneak' : 'row');
    row.append(
      el('span', null, it.recurring ? `${it.name} — recurring` : (qty > 1 ? `${qty} × ${it.name}` : it.name)),
      el('span', null, it.recurring ? `${gbp(it.price)}/${it.recurring === 'month' ? 'mo' : it.recurring}` : gbp(it.price * qty)),
    );
    container.append(row);
    for (const f of it.fees ?? []) {
      const fee = el('div', 'row sneak fee');
      fee.append(el('span', null, `${f.label} fee — added at checkout`), el('span', null, gbp(f.amount)));
      container.append(fee);
    }
  }
  const row = el('div', 'row total');
  row.append(el('span', null, totalLabel), el('span', null, gbp(cartTotals(cart).pending_total)));
  container.append(row);
}

function renderListings(cart) {
  const box = $('listings');
  box.replaceChildren();
  const picked = new Set(cart.items.map((i) => i.listing_id));
  let inj = 0;
  for (const l of scn().listing_ids.map((id) => data.byId[id]).filter(Boolean)) {
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
      q.dataset.listing = l.id;
      card.append(q);
    }
    box.append(card);
  }
}

function renderMandate(m, note) {
  if (baseline) return; // a late /api/parse reply must not re-arm a mandate
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
  const cart = guardCart();
  renderSteps($('feed2'), scn().guard_off.steps);
  renderListings(cart);
  renderCart($('cart1'), cart, 'Pending checkout');
  show('stage2');
  $('btn-mandate').disabled = true;
  setPill('AGENT SHOPPING', 'armed');
  setState('AGENT_SHOPPING');
}

// POST /api/sign is best-effort: a 404, timeout or bad body returns null and the client flow
// carries on exactly as without it. {ok:false, verdict} = refused; {ok:true, receipt, order_id} = signed.
async function postSign(cart) {
  try {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mandate, cart, region, agent: 'console' }),
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
  renderVerdict();
  // Reveal only the listings the INJECTED_INSTRUCTION evidence names.
  const named = new Set(guardVerdict.violations.filter((v) => v.code === 'INJECTED_INSTRUCTION').map((v) => v.evidence?.listing_id));
  document.querySelectorAll('.hidden-inj').forEach((n) => n.classList.toggle('on', named.has(n.dataset.listing)));
  $('verdict').classList.add('on');
  $('verdict').dataset.state = 'shown';
  $('verdict-hint').style.display = 'none';
  $('btn-guard').disabled = true;
  setState('VIOLATIONS');
  // Log the refusal server-side too; the on-screen verdict never waits for it.
  if (!serverSigns()) return;
  const token = runToken;
  postSign(guardCart()).then((r) => {
    if (token === runToken && r?.body?.ok === false) {
      $('verdict').dataset.server = 'refused';
      $('vmeta').textContent += ' · refusal logged';
    }
  });
}

// Re-runnable: a pack switch calls this again so the basis/ref lines change in place.
function renderVerdict() {
  const v = guardVerdict = runCheck(guardCart());
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
  $('vmeta').textContent = `${v.rules_checked} rules checked · ${k} violation${k === 1 ? '' : 's'}` + (pack ? ` · policy: ${pack}` : '') + (baseline ? ' · baseline' : '');
  $('verdict').dataset.mode = v.mode ?? (baseline ? 'baseline' : 'mandate');
  if (state === 'AGENT_SHOPPING' || state === 'VIOLATIONS') setPill(`${k} VIOLATION${k === 1 ? '' : 'S'} BLOCKED`, k ? 'fired' : 'armed');
}

// 4 — rejected cart goes back; the agent rebuilds and FinalCheck re-checks.
function onFix() {
  if (state !== 'VIOLATIONS') return;
  const run = scn().rebuild;
  if (!run) return showHalt();
  renderSteps($('feed4'), run.steps);
  renderCart($('cart2'), rebuildCart(), 'Checkout');
  show('stage4');
  $('btn-fix').disabled = true;
  setState('CART_COMPLIANT');
  renderRecheck();
}

function renderRecheck() {
  if (!scn().rebuild) return;
  fixVerdict = runCheck(rebuildCart());
  const n = fixVerdict.violations.length;
  const pack = fixVerdict.policy_pack || data.policy?.id;
  const ok = $('okline');
  ok.textContent = `${n ? '✗' : '✓'} re-checked: ${n} violation${n === 1 ? '' : 's'} · ${fixVerdict.rules_checked} rules` + (pack ? ` · policy ${pack}` : '');
  ok.classList.toggle('bad', n > 0);
  $('btn-approve').disabled = n > 0;
  setPill(n ? `${n} VIOLATIONS BLOCKED` : 'CART COMPLIANT', n ? 'fired' : 'armed');
}

// Baseline demo: no mandate at all — the pack's baseline_rules still catch the recurring charge
// and the injected text, but there is no cap, so no OVER_BUDGET.
function onBaselineToggle(e) {
  baseline = e.target.checked;
  mandate = null;
  showErr('');
  $('btn-mandate').disabled = baseline;
  $('intent').disabled = baseline;
  if (baseline) {
    $('chips').replaceChildren(el('div', 'chip', 'NO MANDATE'), el('div', 'chip', 'BASELINE RULES ONLY'));
    $('parsed-by').textContent = `policy pack: ${data?.policy?.id ?? region} · baseline rules`;
    $('mandate-card').classList.add('on');
    $('mandate-card').dataset.state = 'baseline';
    setPill('BASELINE ARMED', 'armed');
    setState('MANDATE_ARMED');
  } else {
    $('mandate-card').classList.remove('on');
    $('mandate-card').dataset.state = 'empty';
    setPill('IDLE', '');
    setState('IDLE');
  }
}

// Compliance is data: switching the pack re-runs check() with the new JSON — same engine, new basis/ref.
async function onPackChange(e) {
  const next = e.target.value;
  try {
    packs[next] ??= await loadJSON(`/policies/${next}.json`);
  } catch (err) {
    console.warn('[finalcheck] pack load failed:', err.message);
    e.target.value = region;
    return;
  }
  region = next;
  data.policy = packs[next];
  $('banner-pack').textContent = data.policy.label ?? data.policy.id;
  if (baseline) $('parsed-by').textContent = `policy pack: ${data.policy.id} · baseline rules`;
  if (guardVerdict) renderVerdict();
  if (fixVerdict) renderRecheck();
}

// 5 — approve: build the AP2-style receipt and hash it.
async function onApprove() {
  if (state !== 'CART_COMPLIANT' || !fixVerdict?.ok) return;
  const btn = $('btn-approve');
  btn.disabled = true;
  const cart = rebuildCart();
  const listing = data.byId[cart.items[0]?.listing_id] ?? null;
  if (baseline) return approveBaseline(cart);
  const token = runToken;
  try {
    const pending = serverSigns() ? postSign(cart) : Promise.resolve(null); // in flight while the client receipt renders
    renderReceipt(await buildReceipt(mandate, cart, fixVerdict, data.policy, listing));
    setPill(`SIGNED · ${window.__receipt.cart_mandate.total} RELEASED`, 'signed');
    setState('SIGNED');
    const r = await pending;
    if (token === runToken && r?.body?.ok === true && r.body.receipt?.sig?.value) {
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

// No mandate means no client-side intent to hash, so a baseline receipt comes from the server only.
async function approveBaseline(cart) {
  const r = serverSigns() ? await postSign(cart) : null;
  if (r?.body?.ok === true && r.body.receipt?.sig?.value) {
    renderReceipt(r.body.receipt, r.body.order_id);
    $('receipt').dataset.source = 'server';
    setPill(`SIGNED · ${r.body.receipt.cart_mandate.total} RELEASED`, 'signed');
    setState('SIGNED');
  } else {
    $('btn-approve').disabled = false;
    $('okline').textContent = '✗ baseline receipts are signed server-side — /api/sign unavailable, try again';
    $('okline').classList.add('bad');
  }
}

function renderReceipt(receipt, orderId = null) {
  setReceiptMode('signed');
  // Keep the receipt exactly as signed — adding order_id here would make every verify fail.
  window.__receipt = receipt;
  window.__order_id = orderId;
  resetVerify(true);
  const flags = mandate
    ? [mandate.category, `≤${gbpShort(Number(mandate.max_amount))}`, mandate.one_off ? 'one-off' : 'recurring ok']
    : ['no mandate', `baseline · ${receipt.checks?.policy_pack ?? region}`];
  const items = receipt.cart_mandate.items.map((i) => `${i.name} ${i.price}`).join(', ');
  $('receipt-pre').textContent = [
    '{',
    `  "mandate": "${flags.join(' · ')}",`,
    `  "cart":    "${items}",`,
    `  "checked": "${receipt.checks.rules} rules · ${receipt.checks.violations} violations",`,
    `  "intent":  "${receipt.intent_mandate?.hash ? shortHash(receipt.intent_mandate.hash) : 'none (baseline)'}",`,
    `  "sig":     "${shortHash(receipt.sig.value)}",`,
    `  "expires": "${receipt.expires ? expiryLabel(receipt.expires) : 'n/a'}"` + (orderId ? ',' : ''),
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

// ── scenario C: no compliant cart exists, so the agent halts and we record a refusal ──
const RECEIPT_COPY = {};

function setReceiptMode(mode) {
  const refusal = mode === 'refusal';
  $('receipt').classList.toggle('refusal', refusal);
  $('receipt').dataset.mode = mode;
  $('receipt-stamp').textContent = refusal ? '⛔ REFUSAL RECORD — NOTHING PAID' : RECEIPT_COPY.stamp;
  $('dispute').innerHTML = refusal
    ? '<strong>Scam evidence:</strong> nothing was paid. Keep this record — it lists every rule the agent’s cart broke, for your bank or Action Fraud.<span class="basis" id="receipt-basis"></span>'
    : RECEIPT_COPY.dispute;
  for (const sel of ['.fullsig', '.siglabel']) $('receipt').querySelector(sel).hidden = refusal;
  if (refusal) resetVerify(false);
}

function showHalt() {
  renderSteps($('feed4'), [{ t: 'agent', text: 'agent halted — no compliant cart exists for this request', tone: 'bad' }]);
  $('cart2').replaceChildren();
  $('okline').textContent = '';
  $('halt-note').hidden = false;
  $('btn-halt').hidden = false;
  $('btn-approve').hidden = true;
  show('stage4');
  $('btn-fix').disabled = true;
  setState('HALT_PENDING');
}

function onHalt() {
  if (state !== 'HALT_PENDING') return;
  const v = guardVerdict;
  const cart = guardCart();
  const totals = cartTotals(cart);
  const record = {
    type: 'finalcheck/refusal-record',
    version: '0.1',
    scenario: scn().label,
    merchant: cart.merchant,
    attempted_total: gbp(totals.pending_total),
    paid: gbp(0),
    refused: v.violations.map((x) => ({ code: x.code, title: x.title, ref: x.ref ?? null })),
    policy_pack: v.policy_pack ?? data.policy?.id ?? null,
    rules_checked: v.rules_checked,
    issued_at: new Date().toISOString(),
  };
  window.__receipt = record;
  setReceiptMode('refusal');
  $('receipt-pre').textContent = [
    '{',
    `  "refused":   "${record.refused.map((x) => x.code).join(', ')}",`,
    `  "attempted": "${record.attempted_total} · ${record.merchant}",`,
    `  "paid":      "${record.paid}",`,
    `  "checked":   "${record.rules_checked} rules · ${record.refused.length} violations",`,
    `  "policy":    "${record.policy_pack}"`,
    '}',
  ].join('\n');
  $('receipt').classList.add('on');
  $('receipt').dataset.state = 'refused';
  $('btn-halt').disabled = true;
  setPill('HALTED · £0 MOVED', 'fired');
  setState('HALTED');
}

// Switch scenario without a reload: new intent, stages 2–5 cleared, mandate re-armed by the user.
function onScenarioChange(e) {
  scenarioKey = e.target.value;
  runToken += 1;
  $('intent').value = scn().intent;
  for (const id of ['stage2', 'stage4']) { $(id).style.display = 'none'; $(id).dataset.state = 'hidden'; }
  for (const id of ['feed2', 'listings', 'cart1', 'feed4', 'cart2', 'flags']) $(id).replaceChildren();
  $('okline').textContent = '';
  $('okline').classList.remove('bad');
  $('vmeta').textContent = '';
  $('verdict').classList.remove('on');
  $('verdict').dataset.state = 'hidden';
  delete $('verdict').dataset.server;
  $('receipt').classList.remove('on');
  $('receipt').dataset.state = 'hidden';
  delete $('receipt').dataset.source;
  setReceiptMode('signed');
  $('verdict-hint').style.display = '';
  for (const id of ['btn-guard', 'btn-fix', 'btn-approve', 'btn-halt']) $(id).disabled = false;
  $('btn-approve').hidden = false;
  $('btn-halt').hidden = true;
  $('halt-note').hidden = true;
  guardVerdict = fixVerdict = null;
  window.__receipt = undefined;
  resetVerify(false);
  if (baseline) {
    setPill('BASELINE ARMED', 'armed');
    setState('MANDATE_ARMED');
  } else {
    mandate = null;
    $('mandate-card').classList.remove('on');
    $('mandate-card').dataset.state = 'empty';
    $('btn-mandate').disabled = false;
    setPill('IDLE', '');
    setState('IDLE');
  }
}

// ── verify: the server checks the signature over the canonical receipt; tampering any field breaks it ──
function resetVerify(show) {
  $('verify-box').hidden = !(show && keys);
  $('verify-result').replaceChildren();
  delete $('verify-result').dataset.valid;
  for (const id of ['btn-verify', 'btn-tamper']) $(id).disabled = false;
}

async function postVerify(receipt) {
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt }),
    signal: AbortSignal.timeout(5000),
  });
  if (!(res.headers.get('content-type') || '').includes('json')) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showVerify(r, edited = null) {
  const out = $('verify-result');
  out.dataset.valid = String(!!r.valid);
  const line = r.valid
    ? (r.alg === 'Ed25519' ? `✓ Valid · Ed25519 · key ${r.kid}` : `✓ Valid · ${r.alg} (no signing key)`)
    : `✗ Invalid — ${r.reason ?? 'signature does not match receipt'}`;
  out.replaceChildren(el('span', null, line));
  if (edited) {
    const row = el('span', 'edited');
    row.append(el('br'), document.createTextNode(`edited: ${edited.field} “${edited.from}” → `), el('mark', null, `“${edited.to}”`));
    out.append(row);
  }
}

async function runVerify(tamper) {
  const btn = $(tamper ? 'btn-tamper' : 'btn-verify');
  btn.disabled = true;
  try {
    const receipt = structuredClone(window.__receipt);
    let edited = null;
    if (tamper) {
      edited = { field: 'cart_mandate.total', from: receipt.cart_mandate.total, to: '£3.49' };
      receipt.cart_mandate.total = edited.to;
    }
    showVerify(await postVerify(receipt), edited);
  } catch (e) {
    console.warn('[finalcheck] /api/verify unavailable:', e.message);
    $('verify-result').textContent = 'verify service unavailable — try again';
    delete $('verify-result').dataset.valid;
  } finally {
    btn.disabled = false;
  }
}

async function loadKeys() {
  try {
    const res = await fetch('/api/keys', { signal: AbortSignal.timeout(5000) });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
    keys = await res.json();
    $('pubkey').textContent = keys.signing && keys.public_key?.x
      ? `Public key: ${keys.kid} · x=${keys.public_key.x.slice(0, 12)}…`
      : 'Public key: none — receipts carry a sha256-demo integrity hash only';
  } catch (e) {
    console.warn('[finalcheck] /api/keys unavailable — verify hidden:', e.message);
  }
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
  $('baseline-toggle').addEventListener('change', onBaselineToggle);
  $('pack-select').addEventListener('change', onPackChange);
  $('scenario').addEventListener('change', onScenarioChange);
  $('btn-halt').addEventListener('click', onHalt);
  $('btn-verify').addEventListener('click', () => runVerify(false));
  $('btn-tamper').addEventListener('click', () => runVerify(true));
  loadKeys(); // not awaited: the default path never waits on it
  RECEIPT_COPY.stamp = $('receipt-stamp').textContent;
  RECEIPT_COPY.dispute = $('dispute').innerHTML;
  setState('IDLE');
  try {
    const [listings, scen, trust, policy] = await Promise.all([
      loadJSON('/fixtures/listings.json'),
      loadJSON('/fixtures/scenarios.json'),
      loadJSON('/fixtures/trust.json'),
      loadJSON('/policies/uk.json'),
    ]);
    data = { listings, byId: Object.fromEntries(listings.map((l) => [l.id, l])), scenarios: scen.scenarios, trust, policy };
    packs.uk = policy;
    scenarioKey = scen.default ?? 'A';
    $('scenario').replaceChildren(...Object.entries(data.scenarios).map(([k, v]) => {
      const o = el('option', null, v.label);
      o.value = k;
      o.selected = k === scenarioKey;
      return o;
    }));
    setState(state);
  } catch (e) {
    console.error('[finalcheck] boot failed:', e);
    showErr('couldn’t load demo data — ' + e.message);
  }
}

boot();
