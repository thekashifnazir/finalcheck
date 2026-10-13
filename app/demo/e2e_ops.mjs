// e2e_ops.mjs — drives the ops console through all five stages and asserts each one.
// Usage (app running first):
//   NODE_PATH=/path/to/node_modules KIT_APP_URL=http://localhost:8787/ops/ node app/demo/e2e_ops.mjs
// Optional: E2E_SHOTS=/some/dir saves a screenshot per stage. Exits 1 on any failed check.
import { createRequire } from 'node:module';

// require(), not import: CommonJS resolution honours NODE_PATH, ESM does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const url = process.env.KIT_APP_URL ?? 'http://localhost:8787/ops/';
const shots = process.env.E2E_SHOTS;
// /api/sign is best-effort in the UI: 409 is the expected refusal at Guard, 404 means not deployed yet.
// The browser logs both as console errors, so they're tolerated here and counted separately.
const TOLERATED = /\/api\/sign$/;

const results = [];
const ok = (name, cond, got) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const errors = [];
const failed = [];
const tolerated = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (TOLERATED.test(m.location()?.url ?? '')) tolerated.push(m.text());
  else errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failed.push(r.url()));
page.on('response', (r) => {
  if (r.status() < 400) return;
  if (TOLERATED.test(r.url())) tolerated.push(`${r.status()} ${r.url()}`);
  else failed.push(`${r.status()} ${r.url()}`);
});
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  ok('lands IDLE', (await page.textContent('#status-pill')) === 'IDLE', await page.textContent('#status-pill'));

  // 1 — mandate
  await page.fill('#intent', 'Gift for my mum — under £40, no subscriptions');
  await page.click('#btn-mandate');
  await page.waitForSelector('#mandate-card.on');
  await page.waitForFunction(() => !document.getElementById('btn-mandate').disabled, null, { timeout: 12000 });
  const chips = await page.locator('.chip').allTextContents();
  ok('5 mandate chips', chips.length === 5, chips);
  ok('chip MAX £40', chips[0] === 'MAX £40', chips[0]);
  ok('parsed-by badge', /parsed by: (ruleset|claude|openai)/.test(await page.textContent('#parsed-by')), await page.textContent('#parsed-by'));
  ok('pill MANDATE ARMED', (await page.textContent('#status-pill')) === 'MANDATE ARMED', await page.textContent('#status-pill'));
  await shot('1-mandate');

  // 2 — agent shops, guard off
  await page.click('#btn-run');
  ok('cart total £56.99', (await page.textContent('.cart .total'))?.includes('£56.99'), await page.textContent('.cart .total'));
  ok('one .listing.picked', (await page.locator('.listing.picked').count()) === 1, await page.locator('.listing.picked').count());
  ok('recurring row flagged', (await page.locator('.cart .row.sneak').count()) === 1, null);
  ok('#inj1 hidden before guard', !(await page.locator('#inj1').isVisible()), null);
  await shot('2-shopping');

  // 3 — guard
  await page.click('#btn-guard');
  const flags = await page.locator('.flag').count();
  ok('exactly 3 .flag', flags === 3, flags);
  const basis = await page.locator('.flag .basis').allTextContents();
  ok('every flag has a .basis with "·"', basis.length === 3 && basis.every((b) => b.includes('·')), basis);
  ok('#inj1 visible after guard', await page.locator('#inj1').isVisible(), null);
  ok('#vmeta names policy', (await page.textContent('#vmeta'))?.includes('policy: uk-2026-10'), await page.textContent('#vmeta'));
  ok('pill 3 VIOLATIONS BLOCKED', (await page.textContent('#status-pill')) === '3 VIOLATIONS BLOCKED', await page.textContent('#status-pill'));
  await shot('3-violations');

  // 4 — reject → rebuild
  await page.click('#btn-fix');
  ok('#stage4 visible', await page.locator('#stage4').isVisible(), null);
  ok('re-check 0 violations', (await page.textContent('#okline'))?.includes('0 violations'), await page.textContent('#okline'));
  ok('.cart is unique (stage 4 uses .cart2)', (await page.locator('.cart').count()) === 1, await page.locator('.cart').count());

  // 5 — approve & sign
  await page.click('#btn-approve');
  await page.waitForSelector('#receipt.on');
  await page.waitForTimeout(800); // let a server receipt (if any) replace the client one
  const sig = await page.evaluate(() => window.__receipt?.sig?.value);
  ok('window.__receipt.sig.value starts 0x', typeof sig === 'string' && sig.startsWith('0x'), sig);
  ok('receipt shows 0x… sig', /"sig":\s+"0x[0-9a-f]{4}…[0-9a-f]{4}"/.test(await page.textContent('#receipt-pre')), await page.textContent('#receipt-pre'));
  ok('pill SIGNED · £34.99 RELEASED', (await page.textContent('#status-pill')) === 'SIGNED · £34.99 RELEASED', await page.textContent('#status-pill'));
  ok('body data-state SIGNED', (await page.getAttribute('body', 'data-state')) === 'SIGNED', null);
  await page.click('#btn-copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok('copy button copies full receipt JSON', JSON.parse(copied).type === 'finalcheck/cart-mandate-receipt', copied.slice(0, 80));
  const source = (await page.getAttribute('#receipt', 'data-source')) ?? 'client';
  await shot('5-signed');

  // reset
  await page.click('#btn-reset');
  await page.waitForLoadState('networkidle');
  ok('reset returns to IDLE', (await page.textContent('#status-pill')) === 'IDLE', await page.textContent('#status-pill'));

  ok('0 console errors', errors.length === 0, errors);
  ok('0 failed requests', failed.length === 0, failed);
  console.log(`info  receipt source: ${source}; tolerated /api/sign noise: ${tolerated.length ? tolerated.join(' | ') : 'none'}`);
} catch (e) {
  ok('flow completed without throwing', false, e.message);
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
