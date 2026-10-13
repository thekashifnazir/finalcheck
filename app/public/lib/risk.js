// Financial risk read-out for a verdict: level, money kept safe, why, and on what evidence.
// Pure — takes check() output, no DOM.
import { formatPence } from './rules.js';

// Irreversible scam cash-outs, leaked credentials and hijacked agents are the top tier.
const CRITICAL = new Set(['RESTRICTED_CATEGORY', 'DATA_EXFIL', 'INJECTED_INSTRUCTION']);

const WHY = {
  OVER_BUDGET: 'cart exceeded the spending mandate',
  UNDISCLOSED_RECURRING: 'included a recurring charge nobody agreed to',
  INJECTED_INSTRUCTION: 'merchant page tried to steer the agent',
  CATEGORY_MISMATCH: 'outside the authorised purpose',
  EXPIRED: 'consent had expired',
  QUANTITY_ANOMALY: 'unusual quantity',
  RESTRICTED_CATEGORY: 'gift cards are a scam cash-out route',
  MERCHANT_UNVERIFIED: 'lookalike of a verified merchant',
  PRICE_DRIFT: 'fees appeared only at checkout',
  FIRST_TIME_PAYEE: 'first payment to this payee',
  PRESSURE_CUE: 'pressure language on the page',
  DATA_EXFIL: 'card details were about to leave in free text',
  CURRENCY_MISMATCH: 'priced in another currency',
};

export function riskLevel(verdict) {
  const codes = verdict.violations.map((v) => v.code);
  if (codes.length === 0) return 'Low';
  if (codes.some((c) => CRITICAL.has(c))) return 'Critical';
  if (verdict.violations.some((v) => v.severity === 'red')) return 'High';
  return 'Medium';
}

// What blocking this cart keeps in the account: the one-off total now, plus a year of any
// recurring line (the subscription is the part people notice months later).
export function lossPrevented(verdict) {
  if (verdict.ok) return { pence: 0, label: 'None — cart matched the mandate' };
  const yearly = verdict.recurring_total * 12;
  const pence = verdict.one_off_total + yearly;
  let label = formatPence(verdict.one_off_total);
  if (verdict.recurring_total) label += ` + ${formatPence(verdict.recurring_total)}/month (${formatPence(pence)} over a year)`;
  return { pence, label };
}

export function financialRisk(verdict) {
  const level = riskLevel(verdict);
  const reasons = [...new Set(verdict.violations.map((v) => WHY[v.code] ?? v.title))];
  const evidence = verdict.ok
    ? ['mandate', 'cart total', 'merchant', `${verdict.rules_checked} checks passed`, 'receipt signature']
    : ['mandate', 'cart total', ...verdict.violations.map((v) => v.code.toLowerCase().replace(/_/g, ' '))];
  return {
    level,
    loss_prevented: lossPrevented(verdict),
    reason: verdict.ok ? 'Cart matched the mandate' : reasons.join('; '),
    evidence,
    decision: verdict.ok ? 'Approved with signed intent receipt' : 'Blocked before payment',
  };
}
