// AP2-style cart-mandate receipt. Pure ESM: no DOM, runs in the browser and in
// Node via globalThis.crypto.subtle. Shared by the UI and (later) the MCP server.

const SHA256_DEMO_ALG = 'sha256-demo (hash of canonical JSON — not a cryptographic key signature)';

// Stable JSON: object keys sorted at every depth, array order kept, undefined dropped.
export function canonicalize(obj) {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(v) {
  if (v && typeof v.toJSON === 'function') v = v.toJSON();
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = sortDeep(v[k]);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return '0x' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Integer pence -> '£34.99'. Integer maths only, so no float drift reaches a hash.
function gbp(pence) {
  const p = Math.round(pence);
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// The constraints the user actually authorised. Raw text and parser are left out
// so the same mandate hashes the same whichever parser produced it.
function mandateCore(m) {
  return {
    currency: m.currency,
    max_amount: m.max_amount,
    one_off: m.one_off,
    allow_recurring: m.allow_recurring,
    category: m.category,
    expires: m.expires,
  };
}

export async function buildReceipt(mandate, cart, verdict, policy, listing, signer = null) {
  const items = (cart?.items ?? []).map((it) => ({
    name: it.name,
    price: it.recurring ? `${gbp(it.price)}/${it.recurring}` : gbp(it.price),
  }));
  const totalPence = (cart?.items ?? []).reduce((sum, it) => sum + it.price, 0);
  const violations = verdict?.violations;

  const body = {
    type: 'finalcheck/cart-mandate-receipt',
    version: '0.1',
    intent_mandate: {
      max: gbp(Math.round(mandate.max_amount * 100)),
      one_off: mandate.one_off,
      category: mandate.category,
      expires: mandate.expires,
      hash: await sha256Hex(canonicalize(mandateCore(mandate))),
    },
    cart_mandate: {
      merchant: cart?.merchant ?? listing?.merchant,
      items,
      total: gbp(totalPence),
    },
    checks: {
      policy_pack: verdict?.policy_pack ?? policy?.id ?? null,
      rules: verdict?.rules_checked,
      violations: Array.isArray(violations) ? violations.length : (violations ?? 0),
      basis: policy?.receipt?.ref ?? null,
    },
    issued_at: new Date().toISOString(),
    expires: mandate.expires,
  };

  const canonical = canonicalize(body);
  const sig = signer
    ? await signer(canonical)
    : { alg: SHA256_DEMO_ALG, value: await sha256Hex(canonical) };

  return { ...body, sig };
}
