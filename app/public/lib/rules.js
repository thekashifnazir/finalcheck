// FinalCheck diff engine: mandate vs cart. Pure — no DOM, no fetch.
import { lineTotal, feesOf } from './cart.js';
// Money is integer pence throughout; mandate.max_amount is pounds and is converted once.

const SYM = { GBP: '£', SGD: 'S$' };
let sym = '£'; // set per check() call from the mandate/policy currency
const MONEY = (p) => {
  const s = (Math.abs(p) / 100).toFixed(2);
  return sym + (s.endsWith('.00') ? s.slice(0, -3) : s);
};
const MONEY2 = (p) => '£' + (p / 100).toFixed(2);
const MONEYF = (p) => sym + (p / 100).toFixed(2); // currency-aware, always 2dp

export const INJECTION_RE = /\b(ignore|override|disregard|select|enrol|enroll|add|subscribe)\b/i;

export const RESTRICTED_CATEGORIES = ['gift_card', 'crypto', 'money_transfer'];
export const PRESSURE_RE = /only \d+ (left|remaining)|act now|within \d+ minutes|last chance|urgent(ly)?|immediately|don'?t tell/i;

const capPence = (m) => Math.round(Number(m.max_amount) * 100);
const oneOffItems = (cart) => cart.items.filter((i) => !i.recurring);
const recurringItems = (cart) => cart.items.filter((i) => i.recurring);
// price × quantity + checkout fees; quantity defaults to 1 so plain {name, price} carts total as before.
const sum = (items) => items.reduce((a, i) => a + lineTotal(i), 0);
const isRestricted = (l) => RESTRICTED_CATEGORIES.includes(l?.category);
const hasRestricted = (cart, byId) => cartListings(cart, byId).some(isRestricted);

export function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

export function luhn(digits) {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    total += d;
  }
  return digits.length > 0 && total % 10 === 0;
}

const PAN_RE = /(?:\d[ -]?){12,18}\d/g;
const SORT_CODE_RE = /\b\d{2}-\d{2}-\d{2}\b/;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/;

// Finds payment/identity data in free text. Returns redacted labels only — the raw values never leave.
export function findSensitive(text) {
  const found = [];
  let rest = String(text ?? '');
  for (const m of rest.match(PAN_RE) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) {
      found.push(`card ${d.slice(0, 4)}…${d.slice(-4)}`);
      rest = rest.replace(m, ' ');
    }
  }
  const sc = rest.match(SORT_CODE_RE);
  if (sc) found.push(`sort code ${sc[0].slice(0, 2)}-••-••`);
  const pc = rest.match(POSTCODE_RE);
  if (pc) found.push(`postcode ${pc[0].split(' ')[0]} •••`);
  return found;
}
const cartListings = (cart, byId) =>
  [...new Set(cart.items.map((i) => i.listing_id))].map((id) => byId[id]).filter(Boolean);

export const RULES = [
  {
    code: 'OVER_BUDGET',
    label: 'Cart within signed spending cap',
    run(m, cart) {
      const total = sum(oneOffItems(cart));
      const cap = capPence(m);
      if (total <= cap) return [];
      return [{
        severity: 'red',
        title: `${MONEY(total - cap)} over mandate`,
        detail: `cart ${MONEY(total)} vs signed limit ${MONEY(cap)}`,
      }];
    },
  },
  {
    code: 'UNDISCLOSED_RECURRING',
    label: 'No recurring charge unless the mandate allows it',
    run(m, cart) {
      if (m.allow_recurring) return [];
      return recurringItems(cart).map((i) => ({
        severity: 'red',
        title: 'Undisclosed recurring charge',
        detail: `“${i.name} ${MONEY2(i.price)}/${i.recurring === 'month' ? 'mo' : i.recurring}” — ${m.baseline ? 'recurring charge needs explicit consent' : 'mandate says one-off'}`,
        evidence: { listing_id: i.listing_id, item: i.name },
      }));
    },
  },
  {
    code: 'INJECTED_INSTRUCTION',
    label: 'No agent-directed instructions in merchant content',
    run(m, cart, byId) {
      // The hidden text is evidence to display, never something to act on.
      return cartListings(cart, byId)
        .filter((l) => l.hidden_text && INJECTION_RE.test(l.hidden_text))
        .map((l) => ({
          severity: 'amb',
          title: 'Injected instruction quarantined',
          detail: 'listing hid text aimed at the agent, invisible to you',
          evidence: { listing_id: l.id, hidden_text: l.hidden_text },
        }));
    },
  },
  {
    code: 'CATEGORY_MISMATCH',
    label: 'Items match the authorised category',
    run(m, cart, byId) {
      if (!m.category || m.category === 'general') return [];
      return cartListings(cart, byId)
        .filter((l) => l.category && l.category !== m.category && !isRestricted(l)) // restricted → RESTRICTED_CATEGORY
        .map((l) => ({
          severity: 'amb',
          title: 'Outside authorised category',
          detail: `“${l.name}” is ${l.category}; mandate covers ${m.category}`,
          evidence: { listing_id: l.id },
        }));
    },
  },
  {
    code: 'EXPIRED',
    label: 'Mandate still in date',
    run(m, cart, byId, now) {
      if (!m.expires || new Date(now) <= new Date(m.expires)) return [];
      return [{
        severity: 'red',
        title: 'Mandate expired',
        detail: `authorisation lapsed ${new Date(m.expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      }];
    },
  },
  // ── fraud rules (appended; the five above keep their order and copy) ──
  {
    code: 'RESTRICTED_CATEGORY',
    label: 'Never auto-approve scam cash-out categories',
    run(m, cart, byId) {
      // Fires even when the mandate names the category: a mandate can't authorise a cash-out.
      const titles = { gift_card: 'Gift cards are a scam cash-out', crypto: 'Crypto is a scam cash-out', money_transfer: 'Money transfers are a scam cash-out' };
      return cartListings(cart, byId).filter(isRestricted).map((l) => ({
        severity: 'red',
        title: titles[l.category],
        detail: 'FinalCheck never auto-approves gift cards, crypto or money transfers — call Mum on a number you already have',
        evidence: { listing_id: l.id, category: l.category },
      }));
    },
  },
  {
    code: 'MERCHANT_UNVERIFIED',
    label: 'Merchant domain is on the verified list',
    run(m, cart, byId, now, trust) {
      if (!trust?.verified_merchants || hasRestricted(cart, byId)) return []; // moot next to a restricted item
      const verified = trust.verified_merchants.map((v) => v.domain);
      return cartListings(cart, byId)
        .filter((l) => l.domain && !verified.includes(l.domain))
        .map((l) => {
          const near = verified
            .map((d) => ({ d, n: levenshtein(l.domain, d) }))
            .sort((a, b) => a.n - b.n)[0];
          const look = near && near.n <= 2;
          return {
            severity: 'red',
            title: look ? 'Lookalike merchant' : 'Unverified merchant',
            detail: look
              ? `“${l.domain}” is ${near.n} character${near.n === 1 ? '' : 's'} off verified “${near.d}” — lookalike`
              : `“${l.domain}” is not on the verified merchant list`,
            evidence: { listing_id: l.id, domain: l.domain, nearest: near?.d, distance: near?.n },
          };
        });
    },
  },
  {
    code: 'PRICE_DRIFT',
    label: 'Checkout total matches the listed price',
    run(m, cart) {
      return cart.items.filter((i) => feesOf(i) > 0).map((i) => {
        const listed = lineTotal(i) - feesOf(i);
        return {
          severity: 'red',
          title: `${MONEY(feesOf(i))} added at checkout`,
          detail: `“${i.fees.map((f) => f.label).join('”, “')}” was not in the listed price (${MONEYF(listed)} → ${MONEYF(lineTotal(i))})`,
          evidence: { listing_id: i.listing_id, fees: i.fees },
        };
      });
    },
  },
  {
    code: 'FIRST_TIME_PAYEE',
    label: 'Payee has been paid before',
    run(m, cart, byId, now, trust) {
      if (!trust?.known_payees) return [];
      const seen = new Set();
      return cartListings(cart, byId)
        .filter((l) => l.payee && !trust.known_payees.includes(l.payee) && !seen.has(l.payee) && seen.add(l.payee))
        .map((l) => ({
          severity: 'amb',
          title: 'First payment to this payee',
          detail: `“${l.payee}” has never been paid from this account — confirm it out-of-band`,
          evidence: { listing_id: l.id, payee: l.payee },
        }));
    },
  },
  {
    code: 'PRESSURE_CUE',
    label: 'No pressure-selling on the page',
    run(m, cart, byId) {
      return cartListings(cart, byId).flatMap((l) => {
        const text = [l.description, l.page_text, l.hidden_text].filter(Boolean).join(' ');
        const hit = text.match(PRESSURE_RE);
        if (!hit) return [];
        const sentence = text.split(/(?<=[.!?])\s+/).find((s) => PRESSURE_RE.test(s)) ?? hit[0];
        return [{
          severity: 'amb',
          title: 'Pressure tactics on the page',
          detail: `“${sentence}” — manufactured urgency is a scam tell`,
          evidence: { listing_id: l.id, cue: hit[0] },
        }];
      });
    },
  },
  {
    code: 'DATA_EXFIL',
    label: 'No payment or identity data in free-text fields',
    run(m, cart) {
      return cart.items.flatMap((i) => {
        const found = findSensitive(i.notes);
        if (!found.length) return [];
        return [{
          severity: 'red',
          title: found.some((f) => f.startsWith('card')) ? 'Card number in a free-text field' : 'Personal data in a free-text field',
          detail: `order notes carry ${found.join(', ')} — never sent to the merchant`,
          evidence: { listing_id: i.listing_id, redacted: found },
        }];
      });
    },
  },
  {
    code: 'QUANTITY_ANOMALY',
    label: 'Quantity matches what the mandate asked for',
    run(m, cart) {
      if (m.quantity != null) return [];
      return oneOffItems(cart).filter((i) => (i.quantity ?? 1) > 1).map((i) => ({
        severity: 'amb',
        title: `${i.quantity} × ${i.name}`,
        detail: `quantity ${i.quantity} — the mandate never asked for more than one`,
        evidence: { listing_id: i.listing_id, quantity: i.quantity },
      }));
    },
  },
  {
    code: 'CURRENCY_MISMATCH',
    label: 'Items priced in the mandate currency',
    run(m, cart) {
      return cart.items.filter((i) => i.currency && m.currency && i.currency !== m.currency).map((i) => ({
        severity: 'red',
        title: 'Currency mismatch',
        detail: `“${i.name}” is priced in ${i.currency}; the mandate is in ${m.currency}`,
        evidence: { listing_id: i.listing_id, currency: i.currency },
      }));
    },
  },
];

// mandate === null → baseline mode: only the policy's baseline_rules run, against a
// pseudo-mandate (no cap, no category, no recurring without consent).
// trust = { verified_merchants:[{name,domain}], known_payees:[] }; without it the merchant/payee rules stay silent.
export function check(mandate, cart, listings, now = new Date(), policy = null, trust = null) {
  const byId = Object.fromEntries(listings.map((l) => [l.id, l]));
  const baseline = mandate == null;
  const m = baseline
    ? { currency: policy?.currency ?? 'GBP', allow_recurring: false, one_off: true, category: null, baseline: true }
    : mandate;
  const active = baseline
    ? RULES.filter((r) => (policy?.baseline_rules ?? ['UNDISCLOSED_RECURRING', 'INJECTED_INSTRUCTION']).includes(r.code))
    : RULES;
  sym = SYM[m.currency] ?? '£';
  const violations = [];
  for (const rule of active) {
    for (const v of rule.run(m, cart, byId, now, trust)) {
      const out = { code: rule.code, ...v };
      const p = policy?.rules?.[rule.code];
      if (p) { out.basis = p.basis; out.ref = p.ref; }
      violations.push(out);
    }
  }
  const one_off_total = sum(oneOffItems(cart));
  const recurring_total = sum(recurringItems(cart));
  const result = {
    mode: baseline ? 'baseline' : 'mandate',
    violations,
    rules_checked: active.length,
    one_off_total,
    recurring_total,
    pending_total: one_off_total + recurring_total,
    ok: violations.length === 0,
  };
  if (policy) result.policy_pack = policy.id;
  return result;
}

export const formatPence = MONEY2;
