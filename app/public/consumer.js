// Consumer view: protection status, spending mandate, and what the agent did.
// Works with or without the FinalCheck service: every /api call falls back to
// local data, so the page also runs from a plain static server.
import { parseIntent, validateMandate, expiryLabel } from '/lib/parse.js';

const $ = (id) => document.getElementById(id);

const REGIONS = { uk: 'UK', sg: 'SG' };
const DEFAULT_PREFS = { region: 'uk', mandate_choice: 'ask' };
const KEY_PREFS = 'fc.prefs';
const KEY_MANDATE = 'fc.mandate';

// Plain-English reason for each refusal code. The page never shows the codes themselves.
const REASONS = {
  OVER_BUDGET: 'it was over your spending limit',
  UNDISCLOSED_RECURRING: 'a monthly subscription was being added',
  INJECTED_INSTRUCTION: 'the shop page tried to instruct your agent',
  RESTRICTED_CATEGORY: 'gift cards are how scams cash out',
  MERCHANT_UNVERIFIED: 'the shop looked like a copy of a real one',
  PRICE_DRIFT: 'fees appeared only at checkout',
  FIRST_TIME_PAYEE: 'first time paying this seller',
  PRESSURE_CUE: 'the page was pressuring for a fast decision',
  DATA_EXFIL: 'your card details were about to be typed into a message',
  QUANTITY_ANOMALY: 'more than one was being ordered',
  CURRENCY_MISMATCH: 'it was priced in another currency',
  EXPIRED: 'your mandate had expired',
};

const state = { prefs: { ...DEFAULT_PREFS }, policy: null, policies: {}, mandateSource: null, record: null };

// ---- storage (may be blocked in private windows) ----
function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: state lives for this page view only */ }
}

// ---- service calls: throw on anything that isn't a JSON 2xx ----
async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  if (!(res.headers.get('content-type') || '').includes('json')) throw new Error(`${path} → not JSON`);
  return res.json();
}
const postJSON = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- prefs ----
async function loadPrefs() {
  try {
    const p = await api('/api/prefs');
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return { ...DEFAULT_PREFS, ...readLocal(KEY_PREFS) };
  }
}
async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  writeLocal(KEY_PREFS, state.prefs);
  try { await postJSON('/api/prefs', patch); } catch { /* service not connected: local copy is the record */ }
}

async function loadPolicy(region) {
  if (!state.policies[region]) {
    const res = await fetch(`/policies/${region}.json`);
    if (!res.ok) throw new Error(`policy ${region} → ${res.status}`);
    state.policies[region] = await res.json();
  }
  return state.policies[region];
}

// ---- protection card ----
async function renderProtection() {
  const region = REGIONS[state.prefs.region] ? state.prefs.region : 'uk';
  state.policy = await loadPolicy(region);
  $('c-region').value = region;
  $('c-protection-status').textContent = `Protected · ${state.policy.region} baseline`;
  $('c-pack').textContent = `Policy pack: ${state.policy.label}`;
  const list = $('c-bullets');
  list.replaceChildren(...state.policy.baseline_summary.map((text) => {
    const li = document.createElement('li');
    li.textContent = `✓ ${text}`;
    return li;
  }));
}

// ---- mandate card ----
function money(amount, currency) {
  const n = Number(amount);
  const sym = currency === 'SGD' ? 'S$' : '£';
  return sym + (Number.isInteger(n) ? n : n.toFixed(2));
}

function mandateSummary(m) {
  const scope = m.category === 'gift' ? 'gifts' : 'anything';
  const kind = m.one_off ? 'one-off' : 'repeat payments allowed';
  const until = expiryLabel(m.expires).replace(/^(\w)(\w+)/, (_, a, b) => a + b.toLowerCase());
  return `Up to ${money(m.max_amount, m.currency)} · ${scope} · ${kind} · until ${until}`;
}

// Where the mandate lives: the FinalCheck service when it answers (so an agent's
// mandate shows here and Revoke stops the agent), else this device (static demo).
async function loadMandate() {
  try {
    const { mandate: rec } = await api('/api/mandate');
    state.mandateSource = 'service';
    state.record = rec ?? null;
  } catch {
    state.mandateSource = 'device';
    const m = readLocal(KEY_MANDATE);
    state.record = m ? { mandate: m } : null;
  }
}

// Poll refresh: keep the last known state if the service blips.
async function refreshServiceMandate() {
  if (state.mandateSource !== 'service') return;
  try {
    const { mandate: rec } = await api('/api/mandate');
    if ((rec?.id ?? null) !== (state.record?.id ?? null)) {
      state.record = rec ?? null;
      renderMandate();
    }
  } catch { /* keep showing what we had */ }
}

function mandateNote(rec) {
  if (state.mandateSource !== 'service') return 'Saved on this device (demo).';
  const who = rec.agent === 'mcp' ? 'Set by your agent' : 'Saved';
  return `${who} · your agent spends against this until you revoke it.`;
}

function renderMandate() {
  const rec = state.record;
  $('c-mandate-active').hidden = !rec;
  $('c-mandate-form').hidden = Boolean(rec);
  if (rec) {
    $('c-mandate-summary').textContent = mandateSummary(rec.mandate);
    $('c-mandate-note').textContent = mandateNote(rec);
  }
  $('c-ask-toggle').checked = state.prefs.mandate_choice !== 'baseline';
  $('c-skip-confirm').hidden = state.prefs.mandate_choice !== 'baseline';
}

// The service parser is preferred; the in-page ruleset is the fallback.
// The region's currency is the mandate's currency.
async function parseMandate(text) {
  const currency = state.policy.currency;
  let m;
  try {
    ({ mandate: m } = await postJSON('/api/parse', { text, currency }));
    if (!m) throw new Error('no mandate in response');
  } catch {
    m = parseIntent(text, new Date(), { currency });
  }
  return validateMandate({ ...m, raw: text, currency });
}

async function onSetMandate() {
  const err = $('c-mandate-error');
  err.textContent = '';
  const text = $('c-intent').value.trim();
  if (!text) { err.textContent = 'Tell us what your agent may buy, e.g. “a gift under £40”.'; return; }
  $('c-set-mandate').disabled = true;
  try {
    if (state.mandateSource === 'service') {
      // Same ruleset as the server, checked here first so a missing cap is explained
      // without a failed request.
      validateMandate(parseIntent(text, new Date(), { currency: state.policy.currency }));
      state.record = (await postJSON('/api/mandate', { text })).mandate;
    } else {
      const m = await parseMandate(text);
      writeLocal(KEY_MANDATE, m);
      state.record = { mandate: m };
    }
    renderMandate();
  } catch (e) {
    err.textContent = `Couldn't set that mandate: ${e.message}`;
  } finally {
    $('c-set-mandate').disabled = false;
  }
}

async function onRevoke() {
  try {
    if (state.mandateSource === 'service') await postJSON('/api/mandate/revoke', {});
    else writeLocal(KEY_MANDATE, null);
    state.record = null;
    renderMandate();
  } catch (e) {
    $('c-mandate-error').textContent = `Couldn't revoke: ${e.message}`;
  }
}

async function onSkip() {
  await savePrefs({ mandate_choice: 'baseline' });
  renderMandate();
}

async function onAskToggle(e) {
  await savePrefs({ mandate_choice: e.target.checked ? 'ask' : 'baseline' });
  renderMandate();
}

async function onRegion(e) {
  await savePrefs({ region: e.target.value });
  await renderProtection();
}

// ---- activity feed ----
function sentence(ev) {
  const names = (ev.items ?? []).map((i) => i.name).filter(Boolean).join(' + ') || 'an item';
  if (ev.kind === 'receipt') {
    const at = ev.merchant ? ` at ${ev.merchant}` : '';
    return `✓ Bought ${names} for ${ev.total}${at} · receipt signed`;
  }
  if (ev.kind === 'refusal') {
    const codes = (ev.violations ?? []).map((v) => (typeof v === 'string' ? v : v.code));
    const cap = ev.cap ? ev.cap.replace(/\.00$/, '') : null;
    const reason = (c) => (c === 'OVER_BUDGET' && cap ? `it was over your ${cap} limit` : REASONS[c])
      ?? 'it broke one of your protection rules';
    const reasons = [...new Set(codes.map(reason))];
    return `⛔ Stopped: ${reasons.join('; ') || 'it broke one of your protection rules'}`;
  }
  if (ev.kind === 'order') return `🧾 Order accepted by the shop · ${ev.order_id ?? ''}`.trim();
  return null;
}

let feedFailures = 0;
let feedTimer = null;

async function refreshActivity() {
  const status = $('c-activity-status');
  try {
    const data = await api('/api/events');
    feedFailures = 0;
    const events = Array.isArray(data) ? data : (data.events ?? []);
    const rows = events.map((ev) => [ev, sentence(ev)]).filter(([, s]) => s);
    $('c-activity').replaceChildren(...rows.map(([ev, s]) => {
      const li = document.createElement('li');
      li.textContent = s;
      if (ev.at) {
        const t = document.createElement('time');
        t.dateTime = ev.at;
        t.textContent = ` — ${new Date(ev.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
        li.append(t);
      }
      return li;
    }));
    status.textContent = rows.length ? '' : "Nothing yet — your agent hasn't tried to buy anything.";
    $('c-agent-hint').hidden = !events.some((ev) => ev.agent === 'mcp');
    if (!feedTimer) feedTimer = setInterval(refreshActivity, 5000);
    await refreshServiceMandate();
  } catch {
    feedFailures += 1;
    if (feedFailures >= 2 && feedTimer) { clearInterval(feedTimer); feedTimer = null; }
    if (!$('c-activity').children.length) status.textContent = 'Connect to the FinalCheck service to see live activity.';
  }
}

// ---- boot ----
async function boot() {
  state.prefs = await loadPrefs();
  await renderProtection();
  await loadMandate();
  renderMandate();
  $('c-region').addEventListener('change', onRegion);
  $('c-set-mandate').addEventListener('click', onSetMandate);
  $('c-revoke').addEventListener('click', onRevoke);
  $('c-skip').addEventListener('click', onSkip);
  $('c-ask-toggle').addEventListener('change', onAskToggle);
  await refreshActivity();
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  $('c-boot-error').textContent = `Something went wrong loading this page: ${e.message}`;
});
