// Plain-English intent → mandate. The keyword ruleset is the floor; an LLM parse may
// only tighten it (mergeMandate). Pure — runs in the browser, Node and the Worker.

export const CATEGORIES = ['gift', 'general'];
export const MAX_CAP = 10000;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TZ = 'Europe/London';

// London wall-clock parts for an instant.
function londonParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, dow: DAYS.indexOf(o.weekday.toLowerCase()), hh: +o.hour, mm: +o.minute };
}

// London wall time → UTC ISO string (handles BST/GMT by probing the offset).
function londonToISO(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = londonParts(new Date(guess));
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return new Date(guess - (asUTC - guess)).toISOString();
}

// Next occurrence of `dow` at 23:59 London (today counts if it's still before 23:59).
export function nextWeekdayEnd(now, dow = 5) {
  const p = londonParts(new Date(now));
  let add = (dow - p.dow + 7) % 7;
  if (add === 0 && (p.hh > 23 || (p.hh === 23 && p.mm >= 59))) add = 7;
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
  return londonToISO(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 23, 59);
}

const CUR = '(?:£|S\\$|SGD\\s*|\\$)';
const AMOUNT_RE = new RegExp(`(?:under|below|max(?:imum)?|less than|up to|no more than|≤|<)\\s*${CUR}?\\s*(\\d+(?:\\.\\d{1,2})?)`, 'i');
const BARE_AMOUNT_RE = new RegExp(`${CUR}\\s*(\\d+(?:\\.\\d{1,2})?)`, 'i');
const SGD_RE = /S\$|\bSGD\b/i;
export const CURRENCY_SYMBOL = { GBP: '£', SGD: 'S$' };
const ONE_OFF_RE = /no subscriptions?|one[- ]off|no recurring|single payment/i;
const RECURRING_OK_RE = /subscriptions?\s+(?:are\s+)?(?:ok|fine|allowed)/i;
const GIFT_RE = /gift|present|birthday/i;
const BY_DAY_RE = /\bby\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

export function parseIntent(text, now = new Date(), opts = {}) {
  const raw = String(text ?? '').trim();
  const amt = raw.match(AMOUNT_RE) || raw.match(BARE_AMOUNT_RE);
  const allow_recurring = RECURRING_OK_RE.test(raw) && !ONE_OFF_RE.test(raw);
  const by = raw.match(BY_DAY_RE);
  return {
    raw,
    currency: SGD_RE.test(raw) ? 'SGD' : (opts.currency ?? 'GBP'),
    max_amount: amt ? Number(amt[1]) : null,
    one_off: !allow_recurring,
    allow_recurring,
    category: GIFT_RE.test(raw) ? 'gift' : 'general',
    expires: nextWeekdayEnd(now, by ? DAYS.indexOf(by[1].toLowerCase()) : 5),
    parsed_by: 'ruleset',
  };
}

export function validateMandate(m) {
  if (m == null || m.max_amount == null || !Number.isFinite(Number(m.max_amount)) || Number(m.max_amount) <= 0) {
    throw new Error('couldn’t find a spending cap — try adding e.g. “under £40”');
  }
  if (Number(m.max_amount) > MAX_CAP) throw new Error(`spending cap above £${MAX_CAP} isn’t supported in this demo`);
  if (!CATEGORIES.includes(m.category)) throw new Error(`unknown category “${m.category}”`);
  if (!m.expires || Number.isNaN(Date.parse(m.expires))) throw new Error('mandate needs an expiry');
  return m;
}

// LLM output may TIGHTEN the ruleset floor, never loosen it.
export function mergeMandate(floor, llm, parsed_by = 'anthropic') {
  if (!llm || typeof llm !== 'object') return floor;
  const out = { ...floor, parsed_by };
  const lm = Number(llm.max_amount);
  if (Number.isFinite(lm) && lm > 0) {
    out.max_amount = floor.max_amount == null ? lm : Math.min(floor.max_amount, lm);
  }
  out.allow_recurring = Boolean(floor.allow_recurring && llm.allow_recurring !== false);
  out.one_off = floor.one_off || llm.one_off === true || !out.allow_recurring;
  if (floor.category === 'general' && CATEGORIES.includes(llm.category)) out.category = llm.category;
  return out;
}

const DOW_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function expiryLabel(iso) {
  const p = londonParts(new Date(iso));
  return `${DOW_SHORT[p.dow]} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

export function toChips(m) {
  const amt = Number(m.max_amount);
  const sym = CURRENCY_SYMBOL[m.currency] ?? '£';
  const chips = [`MAX ${sym}${Number.isInteger(amt) ? amt : amt.toFixed(2)}`];
  if (m.one_off) chips.push('ONE-OFF');
  chips.push(`CATEGORY: ${String(m.category).toUpperCase()}`);
  chips.push(`EXPIRES ${expiryLabel(m.expires)}`);
  if (!m.allow_recurring) chips.push('NO RECURRING');
  return chips;
}

// What the person didn't say. Drives the follow-up questions: anything missing falls back to
// the safe default (baseline rules, one-off, Friday expiry) until they answer.
export function missingFields(text) {
  const raw = String(text ?? '');
  const missing = [];
  if (!(AMOUNT_RE.test(raw) || BARE_AMOUNT_RE.test(raw))) missing.push('max_amount');
  if (!(ONE_OFF_RE.test(raw) || RECURRING_OK_RE.test(raw))) missing.push('recurring');
  if (!GIFT_RE.test(raw)) missing.push('category');
  if (!BY_DAY_RE.test(raw)) missing.push('expires');
  return missing;
}
