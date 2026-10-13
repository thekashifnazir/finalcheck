// FinalCheck diff engine: mandate vs cart. Pure — no DOM, no fetch.
// Money is integer pence throughout; mandate.max_amount is pounds and is converted once.

const MONEY = (p) => {
  const s = (Math.abs(p) / 100).toFixed(2);
  return '£' + (s.endsWith('.00') ? s.slice(0, -3) : s);
};
const MONEY2 = (p) => '£' + (p / 100).toFixed(2);

export const INJECTION_RE = /\b(ignore|override|disregard|select|enrol|enroll|add|subscribe)\b/i;

const capPence = (m) => Math.round(Number(m.max_amount) * 100);
const oneOffItems = (cart) => cart.items.filter((i) => !i.recurring);
const recurringItems = (cart) => cart.items.filter((i) => i.recurring);
const sum = (items) => items.reduce((a, i) => a + i.price, 0);
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
        detail: `“${i.name} ${MONEY2(i.price)}/${i.recurring === 'month' ? 'mo' : i.recurring}” — mandate says one-off`,
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
        .filter((l) => l.category && l.category !== m.category)
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
];

export function check(mandate, cart, listings, now = new Date(), policy = null) {
  const byId = Object.fromEntries(listings.map((l) => [l.id, l]));
  const violations = [];
  for (const rule of RULES) {
    for (const v of rule.run(mandate, cart, byId, now)) {
      const out = { code: rule.code, ...v };
      const p = policy?.rules?.[rule.code];
      if (p) { out.basis = p.basis; out.ref = p.ref; }
      violations.push(out);
    }
  }
  const one_off_total = sum(oneOffItems(cart));
  const recurring_total = sum(recurringItems(cart));
  const result = {
    violations,
    rules_checked: RULES.length,
    one_off_total,
    recurring_total,
    pending_total: one_off_total + recurring_total,
    ok: violations.length === 0,
  };
  if (policy) result.policy_pack = policy.id;
  return result;
}

export const formatPence = MONEY2;
