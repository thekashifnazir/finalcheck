// Prints a fresh Ed25519 keypair as .dev.vars lines (WebCrypto, no dependencies):
//   node scripts/gen-keys.mjs >> .dev.vars
// For production: wrangler secret put FC_SIGNING_PRIVATE_JWK (and _PUBLIC_JWK) with the values.
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const priv = await crypto.subtle.exportKey('jwk', privateKey);
const pub = await crypto.subtle.exportKey('jwk', publicKey);
const line = (name, jwk) => `${name}='${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.d ? { d: jwk.d } : {}) })}'`;
console.log(line('FC_SIGNING_PRIVATE_JWK', priv));
console.log(line('FC_SIGNING_PUBLIC_JWK', pub));
