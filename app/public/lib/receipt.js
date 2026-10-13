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

// mandate === null → baseline receipt: no cap or scope was authorised, so the intent
// block records the protection mode instead. `extra` adds top-level fields (agent_id,
// mandate_id) that are covered by the signature.
export async function buildReceipt(mandate, cart, verdict, policy, listing, signer = null, extra = null) {
  const items = (cart?.items ?? []).map((it) => ({
    name: it.name,
    price: it.recurring ? `${gbp(it.price)}/${it.recurring}` : gbp(it.price),
  }));
  const totalPence = (cart?.items ?? []).reduce((sum, it) => sum + it.price, 0);
  const violations = verdict?.violations;

  const body = {
    type: 'finalcheck/cart-mandate-receipt',
    version: '0.1',
    intent_mandate: mandate == null
      ? { mode: 'baseline', policy_pack: verdict?.policy_pack ?? policy?.id ?? null, max: null }
      : {
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
    expires: mandate?.expires ?? null,
    ...(extra ?? {}),
  };
  if (mandate == null) body.checks.mode = 'baseline';

  const canonical = canonicalize(body);
  const sig = signer
    ? await signer(canonical)
    : { alg: SHA256_DEMO_ALG, value: await sha256Hex(canonical) };

  return { ...body, sig };
}

// ---- Ed25519 receipts (WebCrypto; Workers, browsers and Node) ----

const ED25519 = { name: 'Ed25519' };
const hexToBytes = (hex) => Uint8Array.from(hex.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const bytesToHex = (b) => '0x' + Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

// Key id: first 16 hex chars of sha256 over the public key's x coordinate.
export async function keyId(jwk) {
  return 'fc-' + (await sha256Hex(jwk.x)).slice(2, 18);
}

export function publicJwk(jwk) {
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

// A buildReceipt signer from a private JWK. The signature covers the canonical receipt without sig.
export async function ed25519Signer(privateJwk) {
  const key = await globalThis.crypto.subtle.importKey('jwk', privateJwk, ED25519, false, ['sign']);
  const kid = await keyId(privateJwk);
  return async (canonicalJson) => {
    const sig = await globalThis.crypto.subtle.sign(ED25519, key, new TextEncoder().encode(canonicalJson));
    return { alg: 'Ed25519', kid, value: bytesToHex(sig) };
  };
}

// {valid, alg, reason?}. Ed25519 needs the public JWK; the sha256-demo sig is checked as a
// plain hash, which proves the receipt wasn't altered but not who issued it.
export async function verifyReceipt(receipt, publicKeyJwk = null) {
  if (!receipt || typeof receipt !== 'object' || !receipt.sig) return { valid: false, reason: 'no sig on receipt' };
  const { sig, ...body } = receipt;
  const canonical = canonicalize(body);
  if (sig.alg === 'Ed25519') {
    if (!publicKeyJwk) return { valid: false, alg: sig.alg, reason: 'no public key configured' };
    if (sig.kid && sig.kid !== (await keyId(publicKeyJwk))) return { valid: false, alg: sig.alg, reason: `unknown key ${sig.kid}` };
    try {
      const key = await globalThis.crypto.subtle.importKey('jwk', publicJwk(publicKeyJwk), ED25519, false, ['verify']);
      const ok = await globalThis.crypto.subtle.verify(ED25519, key, hexToBytes(String(sig.value)), new TextEncoder().encode(canonical));
      return ok ? { valid: true, alg: sig.alg, kid: sig.kid } : { valid: false, alg: sig.alg, reason: 'signature does not match receipt' };
    } catch (e) {
      return { valid: false, alg: sig.alg, reason: `malformed signature: ${e.message}` };
    }
  }
  if (sig.alg === SHA256_DEMO_ALG) {
    const ok = sig.value === (await sha256Hex(canonical));
    return ok
      ? { valid: true, alg: 'sha256-demo', reason: 'hash matches — integrity only, not a key signature' }
      : { valid: false, alg: 'sha256-demo', reason: 'hash does not match receipt' };
  }
  return { valid: false, reason: `unsupported alg ${JSON.stringify(sig.alg)}` };
}
