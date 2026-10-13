// Consumer view: protection status, spending mandate, and what the agent did.
// Works with or without the FinalCheck service: every /api call falls back to
// local data, so the page also runs from a plain static server.
import { parseIntent, validateMandate, expiryLabel, toChips, missingFields } from '/lib/parse.js';

const $ = (id) => document.getElementById(id);

const REGIONS = { uk: 'UK', sg: 'SG' };
const DEFAULT_PREFS = { region: 'uk', mandate_choice: 'ask', agents_paused: false };
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
  AGENTS_PAUSED: 'you had paused your agent',
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
  list.replaceChildren(...state.policy.baseline_summary.map((text, i) => {
    const t = TILES[i] ?? { title: '', icon: TILES[0].icon };
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'c-tile-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>`; // constant markup
    const title = document.createElement('strong');
    title.className = 'c-tile-title';
    title.textContent = t.title;
    const sub = document.createElement('span');
    sub.className = 'c-tile-sub';
    sub.textContent = text;
    li.append(icon, title, sub);
    return li;
  }));
}

// Short titles and icons for the 5 baseline bullets (same order in every policy pack).
const TILES = [
  { title: 'Scam cash-outs blocked', icon: '<path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>' },
  { title: 'No surprise sign-ups', icon: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>' },
  { title: 'Hidden instructions ignored', icon: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4"/><path d="M6.6 6.6C4.3 8 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/>' },
  { title: 'Lookalike shops flagged', icon: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>' },
  { title: 'Payment privacy', icon: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>' },
];

// ---- mandate card ----
function money(amount, currency) {
  const n = Number(amount);
  const sym = currency === 'SGD' ? 'S$' : '£';
  return sym + (Number.isInteger(n) ? n : n.toFixed(2));
}

function mandateSummary(m) {
  const scope = m.category === 'gift' ? 'gifts' : 'anything';
  const kind = m.one_off ? 'one-off' : 'repeat payments allowed';
  let until = expiryLabel(m.expires).replace(/^(\w)(\w+)/, (_, a, b) => a + b.toLowerCase());
  if (Date.parse(m.expires) - Date.now() > 6 * 86_400_000) {
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' }).format(new Date(m.expires));
    until = until.replace(' ', ` ${date} `);
  }
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

// Saves a mandate from text (the service when it answers, else this device).
async function saveMandateText(text) {
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
}

// ---- mandate conversation ----
// Free text alone gets baseline protection. The chat asks one question per field the
// text didn't state, appends each answer as plain words, and runs the combined text
// through the same parser, so there is still one engine path.
const FIELDS = ['max_amount', 'recurring', 'category', 'expires'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const sym = () => (state.policy?.currency === 'SGD' ? 'S$' : '£');

const QUESTIONS = {
  max_amount: {
    ask: "What's the most it should spend?",
    replies: () => [20, 40, 75].map((n) => ({ label: `${sym()}${n}`, words: `under ${sym()}${n}` }))
      .concat({ label: 'No limit — baseline only', decline: true }),
    free: (t) => {
      const n = t.match(/(\d+(?:\.\d{1,2})?)/);
      return n ? `under ${sym()}${n[1]}` : null;
    },
    hint: 'Give me an amount, e.g. 40.',
    unset: 'default: no cap (baseline protection only)',
    chip: (chips) => chips.filter((c) => c.startsWith('MAX')),
  },
  recurring: {
    ask: 'Can it sign you up to anything that renews?',
    replies: () => [{ label: 'No — one-off only', words: 'one-off' }, { label: 'Yes, subscriptions are OK', words: 'subscriptions are ok' }],
    free: (t) => (/^\s*(y|yes|ok|okay|sure|fine)\b/i.test(t) ? 'subscriptions are ok' : /^\s*(n|no|nope)\b/i.test(t) ? 'one-off' : null),
    hint: 'Yes or no?',
    unset: 'default: one-off, nothing that renews',
    chip: (chips, m) => (m.allow_recurring ? ['SUBSCRIPTIONS OK'] : chips.filter((c) => c === 'ONE-OFF' || c === 'NO RECURRING')),
  },
  category: {
    ask: "What's it for?",
    replies: () => [{ label: 'A gift', words: 'gift' }, { label: 'Anything', words: '' }],
    free: (t) => t.trim(),
    unset: 'default: anything',
    chip: (chips) => chips.filter((c) => c.startsWith('CATEGORY')),
  },
  expires: {
    ask: 'When should this permission end?',
    // Each option is wording the parser reads (all end 23:59 London).
    replies: () => [
      { label: 'Friday 23:59', words: 'by friday' },
      { label: 'End of today', words: 'end of today' },
      { label: 'In 7 days', words: 'in 7 days' },
    ],
    free: (t) => {
      const s = t.toLowerCase();
      const n = s.match(/\bin\s+(\d{1,2})\s+days?\b/);
      if (n) return `in ${n[1]} days`;
      if (/\btonight\b|\bend of (?:the )?day\b|\bend of today\b|\btoday\b/.test(s)) return 'end of today';
      const d = DAYS.find((day) => s.includes(day));
      return d ? `by ${d}` : null;
    },
    hint: 'Pick a day (e.g. Saturday), "end of today", or "in 3 days".',
    unset: 'default: Friday 23:59',
    chip: (chips) => chips.filter((c) => c.startsWith('EXPIRES')),
  },
};

const chat = { original: '', words: {}, answered: new Set(), queue: [], stage: 'intent' };

const composed = () => [chat.original, ...FIELDS.map((f) => chat.words[f]).filter(Boolean)].join(', ');

function say(who, text) {
  const li = document.createElement('li');
  li.dataset.who = who;
  const b = document.createElement('b');
  b.textContent = who === 'you' ? 'You: ' : 'FinalCheck: ';
  li.append(b, text);
  $('c-chat-log').append(li);
}

function showReplies(options) {
  $('c-chat-replies').replaceChildren(...options.map((o) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = o.label;
    btn.addEventListener('click', () => onReply(o));
    return btn;
  }));
}

function renderPreview() {
  const m = parseIntent(composed(), new Date(), { currency: state.policy.currency });
  const chips = toChips({ ...m, max_amount: m.max_amount ?? 0 });
  $('c-chat-rows').replaceChildren(...FIELDS.map((f) => {
    const li = document.createElement('li');
    li.dataset.field = f;
    const q = QUESTIONS[f];
    if (chat.answered.has(f)) {
      li.textContent = q.chip(chips, m).join(' · ') || (f === 'category' ? 'CATEGORY: ANYTHING' : '');
      if (f === 'max_amount') li.textContent = li.textContent.replace(/^MAX\s*/, '');
    } else {
      li.textContent = q.unset;
      li.className = 'c-default';
    }
    return li;
  }));
  $('c-chat-preview').hidden = false;
}

function askNext() {
  const field = chat.queue[0];
  if (field) {
    chat.stage = 'asking';
    say('finalcheck', QUESTIONS[field].ask);
    showReplies(QUESTIONS[field].replies());
    $('c-chat-input').placeholder = 'or type your own answer';
    return;
  }
  chat.stage = 'review';
  say('finalcheck', "Here's your mandate.");
  showReplies([]);
  $('c-chat-actions').hidden = false;
  $('c-chat-input').placeholder = 'or type a new request to start again';
}

function startChat(prefill = '') {
  Object.assign(chat, { original: '', words: {}, answered: new Set(), queue: [], stage: 'intent' });
  $('c-chat-log').replaceChildren();
  showReplies([]);
  $('c-chat-preview').hidden = true;
  $('c-chat-actions').hidden = true;
  $('c-chat-input').value = prefill;
  $('c-chat-input').placeholder = 'e.g. buy mum a birthday present';
  say('finalcheck', 'What should your agent buy? Say it in your own words.');
}

function onIntent(text) {
  chat.original = text;
  const missing = missingFields(text);
  chat.queue = FIELDS.filter((f) => missing.includes(f));
  chat.answered = new Set(FIELDS.filter((f) => !missing.includes(f)));
  say('finalcheck', chat.queue.length
    ? 'Got it. Baseline protection is on already. A few quick questions so your agent knows your limits.'
    : 'Got it. That covers your limits.');
  renderPreview();
  askNext();
}

function answer(field, words) {
  chat.words[field] = words;
  chat.answered.add(field);
  chat.queue.shift();
  renderPreview();
  askNext();
}

async function onReply(option) {
  $('c-mandate-error').textContent = '';
  say('you', option.label);
  const field = chat.queue[0];
  if (option.decline) {
    say('finalcheck', "OK, no spending mandate. Baseline protection stays on, and your agent won't be asked again.");
    showReplies([]);
    chat.stage = 'review'; // next message starts a fresh request
    await savePrefs({ mandate_choice: 'baseline' });
    renderMandate();
    return;
  }
  answer(field, option.words);
}

function onChatSubmit(e) {
  e.preventDefault();
  $('c-mandate-error').textContent = '';
  const text = $('c-chat-input').value.trim();
  if (!text) return;
  $('c-chat-input').value = '';
  if (chat.stage === 'review') startChat();
  say('you', text);
  if (chat.stage === 'intent') { onIntent(text); return; }
  const field = chat.queue[0];
  const words = QUESTIONS[field].free(text);
  if (words == null) { say('finalcheck', QUESTIONS[field].hint); return; }
  answer(field, words);
}

async function onSaveMandate() {
  const err = $('c-mandate-error');
  err.textContent = '';
  $('c-save-mandate').disabled = true;
  try {
    await saveMandateText(composed());
    renderMandate();
    startChat();
  } catch (e) {
    err.textContent = `Couldn't set that mandate: ${e.message}`;
  } finally {
    $('c-save-mandate').disabled = false;
  }
}

function onEditMandate() {
  const text = composed();
  startChat(text);
  $('c-chat-input').focus();
}

async function onRevoke() {
  try {
    if (state.mandateSource === 'service') await postJSON('/api/mandate/revoke', {});
    else writeLocal(KEY_MANDATE, null);
    state.record = null;
    renderMandate();
  } catch (e) {
    $('c-mandate-note').textContent = `Couldn't revoke: ${e.message}`; // the form (and its error line) is hidden here
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

async function onPause(e) {
  await savePrefs({ agents_paused: e.target.checked });
  renderPause();
}

function renderPause() {
  const paused = Boolean(state.prefs.agents_paused);
  $('c-pause').checked = paused;
  $('c-pause-note').textContent = paused
    ? 'Paused. FinalCheck refuses every purchase your agent tries until you resume.'
    : 'Your agent can buy within your rules.';
  document.body.dataset.paused = paused ? '1' : '0';
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
      li.dataset.kind = ev.kind;
      // "✓ Bought …" → icon circle + title; the text still reads as one sentence.
      const cut = s.indexOf(' ');
      const icon = document.createElement('span');
      icon.className = 'c-feed-icon';
      icon.textContent = s.slice(0, cut);
      const title = document.createElement('strong');
      title.className = 'c-feed-title';
      title.textContent = s.slice(cut);
      const meta = document.createElement('span');
      meta.className = 'c-feed-meta';
      if (ev.at) {
        const t = document.createElement('time');
        t.dateTime = ev.at;
        t.textContent = new Date(ev.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        meta.append(t);
      }
      const note = ev.kind === 'refusal' ? "You weren't charged"
        : ev.kind === 'receipt' ? (ev.cap ? `Within your ${ev.cap.replace(/\.00$/, '')} limit · receipt signed` : 'Baseline protection · receipt signed')
        : ev.kind === 'order' ? 'Order placed with the shop' : '';
      if (note) meta.append(` · ${note}`);
      const body = document.createElement('span');
      body.className = 'c-feed-body';
      body.append(title, meta);
      li.append(icon, body);
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
  startChat();
  $('c-chat-form').addEventListener('submit', onChatSubmit);
  $('c-save-mandate').addEventListener('click', onSaveMandate);
  $('c-edit-mandate').addEventListener('click', onEditMandate);
  $('c-revoke').addEventListener('click', onRevoke);
  $('c-skip').addEventListener('click', onSkip);
  $('c-ask-toggle').addEventListener('change', onAskToggle);
  renderPause();
  $('c-pause').addEventListener('change', onPause);
  await refreshActivity();
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  $('c-boot-error').textContent = `Something went wrong loading this page: ${e.message}`;
});
