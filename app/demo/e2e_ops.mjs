// e2e_ops.mjs — drives the ops console through all five stages and asserts each one.
// Usage (app running first):
//   NODE_PATH=/path/to/node_modules KIT_APP_URL=http://localhost:8787/ops/ node app/demo/e2e_ops.mjs
// Optional: E2E_SHOTS=/some/dir saves a screenshot per stage; E2E_SCENARIO=A|B|C runs one scenario
// (default: all). Exits 1 on any failed check.
import { createRequire } from 'node:module';

// require(), not import: CommonJS resolution honours NODE_PATH, ESM does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const url = process.env.KIT_APP_URL ?? 'http://localhost:8787/ops/';
const shots = process.env.E2E_SHOTS;
const only = process.env.E2E_SCENARIO;
const want = (k) => !only || only === k;

const results = [];
let source = 'n/a';
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failed.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  ok('scenario select defaults to A', (await page.inputValue('#scenario')) === 'A', await page.inputValue('#scenario'));
  if (want('A')) {
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
  source = (await page.getAttribute('#receipt', 'data-source')) ?? 'client';
  await shot('5-signed');

  // reset
  await page.click('#btn-reset');
  await page.waitForLoadState('networkidle');
  ok('reset returns to IDLE', (await page.textContent('#status-pill')) === 'IDLE', await page.textContent('#status-pill'));
  ok('reset restores UK pack', (await page.inputValue('#pack-select')) === 'uk', await page.inputValue('#pack-select'));

  // Baseline mode — no mandate, UK pack: only recurring + injection fire (no cap → no OVER_BUDGET)
  const codes = () => page.locator('.flag').evaluateAll((els) => els.map((e) => e.dataset.code));
  await page.check('#baseline-toggle');
  ok('baseline: pill BASELINE ARMED', (await page.textContent('#status-pill')) === 'BASELINE ARMED', await page.textContent('#status-pill'));
  ok('baseline: mandate button disabled', await page.locator('#btn-mandate').isDisabled(), null);
  await page.click('#btn-run');
  await page.click('#btn-guard');
  const bCodes = await codes();
  ok('baseline UK: exactly 2 flags, recurring + injection', bCodes.length === 2 && bCodes.includes('UNDISCLOSED_RECURRING') && bCodes.includes('INJECTED_INSTRUCTION'), bCodes);
  ok('baseline UK: no OVER_BUDGET', !bCodes.includes('OVER_BUDGET'), bCodes);
  const ukBasis = (await page.locator('.flag .basis').allTextContents()).join(' | ');
  ok('baseline UK: basis cites DMCC Act', ukBasis.includes('DMCC Act'), ukBasis);
  ok('baseline UK: #vmeta uk + baseline', /policy: uk-2026-10 · baseline/.test(await page.textContent('#vmeta')), await page.textContent('#vmeta'));

  // Same engine, different data: switch the pack and the basis/ref lines change in place
  await page.selectOption('#pack-select', 'sg');
  await page.waitForFunction(() => document.getElementById('vmeta').textContent.includes('sg-2026-10'));
  const sgCodes = await codes();
  const sgBasis = (await page.locator('.flag .basis').allTextContents()).join(' | ');
  ok('baseline SG: still exactly 2 flags', sgCodes.length === 2 && !sgCodes.includes('OVER_BUDGET'), sgCodes);
  ok('baseline SG: basis changed to SG refs', sgBasis !== ukBasis && sgBasis.includes('Consumer Protection (Fair Trading)'), sgBasis);
  ok('baseline SG: banner names Singapore pack', (await page.textContent('#banner-pack')).includes('Singapore'), await page.textContent('#banner-pack'));

  // Baseline approve — receipt comes from the server (no mandate to hash client-side)
  await page.click('#btn-fix');
  ok('baseline: re-check 0 violations', (await page.textContent('#okline'))?.includes('0 violations · 9 rules · policy sg-2026-10'), await page.textContent('#okline'));
  await page.click('#btn-approve');
  await page.waitForSelector('#receipt.on', { timeout: 8000 });
  const bPre = await page.textContent('#receipt-pre');
  ok('baseline: server receipt with order + baseline pack', bPre.includes('baseline · sg-2026-10') && /"order":\s+"ord_/.test(bPre), bPre);
  ok('baseline: pack select locked after signing', await page.locator('#pack-select').isDisabled(), null);

  }

  const codes2 = () => page.locator('.flag').evaluateAll((els) => els.map((e) => e.dataset.code));
  const arm = async (key) => {
    await page.click('#btn-reset');
    await page.waitForLoadState('networkidle');
    await page.selectOption('#scenario', key);
    await page.click('#btn-mandate');
    await page.waitForSelector('#mandate-card.on');
    await page.waitForFunction(() => !document.getElementById('btn-mandate').disabled, null, { timeout: 12000 });
  };

  if (want('B')) {
    // B — lookalike merchant + drip fee + card number in the gift message
    await arm('B');
    ok('B: intent switched', (await page.inputValue('#intent')).startsWith('Birthday hamper'), await page.inputValue('#intent'));
    await page.click('#btn-run');
    ok('B: cart total £44.98 incl. fee row', (await page.textContent('.cart .total')).includes('£44.98') && (await page.locator('.cart .row.fee').count()) === 1, await page.textContent('.cart'));
    ok('B: only the scenario\'s 4 listings', (await page.locator('.listing').count()) === 4, await page.locator('.listing').count());
    await page.click('#btn-guard');
    const b = await codes2();
    ok('B: exactly 5 flags', JSON.stringify(b) === JSON.stringify(['OVER_BUDGET', 'MERCHANT_UNVERIFIED', 'PRICE_DRIFT', 'FIRST_TIME_PAYEE', 'DATA_EXFIL']), b);
    ok('B: lookalike detail', (await page.textContent('#flags')).includes('2 characters off verified'), null);
    ok('B: card number redacted', !/4532 0151 1283 0366/.test(await page.textContent('body')) && (await page.textContent('#flags')).includes('4532…0366'), null);
    ok('B: no injection box revealed', (await page.locator('.hidden-inj.on').count()) === 0, null);
    const logged = () => page.waitForFunction(() => document.getElementById('verdict').dataset.server === 'refused', null, { timeout: 6000 }).then(() => true, () => false);
    ok('B: server refusal logged', await logged(), await page.textContent('#vmeta'));
    ok('B: #vmeta 13 rules', (await page.textContent('#vmeta')).startsWith('13 rules checked · 5 violations'), await page.textContent('#vmeta'));
    await page.click('#btn-fix');
    ok('B: rebuild 0 violations', (await page.textContent('#okline')).includes('0 violations'), await page.textContent('#okline'));
    await page.click('#btn-approve');
    await page.waitForSelector('#receipt.on');
    ok('B: signed £36.50', (await page.textContent('#status-pill')) === 'SIGNED · £36.50 RELEASED', await page.textContent('#status-pill'));
    const bServer = await page.waitForFunction(() => document.getElementById('receipt').dataset.source === 'server', null, { timeout: 6000 }).then(() => true, () => false);
    ok('B: server receipt with order id', bServer && /"order":\s+"ord_/.test(await page.textContent('#receipt-pre')), await page.textContent('#receipt-pre'));
    await shot('B-signed');
  }

  if (want('C')) {
    // C — coerced gift-card purchase: no compliant cart exists → halt + refusal record
    await arm('C');
    ok('C: mandate MAX £300', (await page.locator('.chip').first().textContent()) === 'MAX £300', await page.locator('.chip').first().textContent());
    await page.click('#btn-run');
    ok('C: cart shows 3 × gift card, £300.00', (await page.textContent('.cart')).includes('3 × Apple Gift Card £100') && (await page.textContent('.cart .total')).includes('£300.00'), await page.textContent('.cart'));
    await page.click('#btn-guard');
    const c = await codes2();
    ok('C: exactly 4 flags', JSON.stringify(c) === JSON.stringify(['RESTRICTED_CATEGORY', 'FIRST_TIME_PAYEE', 'PRESSURE_CUE', 'QUANTITY_ANOMALY']), c);
    const cLogged = await page.waitForFunction(() => document.getElementById('verdict').dataset.server === 'refused', null, { timeout: 6000 }).then(() => true, () => false);
    ok('C: server refusal logged', cLogged, await page.textContent('#vmeta'));
    ok('C: pill 4 VIOLATIONS BLOCKED', (await page.textContent('#status-pill')) === '4 VIOLATIONS BLOCKED', await page.textContent('#status-pill'));
    await page.click('#btn-fix');
    ok('C: halt offered, approve hidden', (await page.locator('#btn-halt').isVisible()) && !(await page.locator('#btn-approve').isVisible()), null);
    ok('C: halt note', (await page.textContent('#halt-note')).includes('number you already have'), null);
    await page.click('#btn-halt');
    ok('C: pill HALTED · £0 MOVED', (await page.textContent('#status-pill')) === 'HALTED · £0 MOVED', await page.textContent('#status-pill'));
    ok('C: red refusal record, no signature', (await page.locator('#receipt.refusal').isVisible()) && (await page.textContent('#receipt-stamp')).includes('REFUSAL RECORD') && !(await page.locator('.fullsig').isVisible()), await page.textContent('#receipt-stamp'));
    await page.click('#btn-copy');
    const rec = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    ok('C: copy gives refusal record JSON, nothing paid', rec.type === 'finalcheck/refusal-record' && rec.paid === '£0.00' && rec.refused.length === 4, rec);
    await shot('C-refusal');

    // Switch back to A without a reload → normal receipt styling returns
    await page.selectOption('#scenario', 'A');
    ok('A after C: stages cleared, refusal styling gone', !(await page.locator('#receipt').isVisible()) && (await page.locator('#receipt.refusal').count()) === 0 && (await page.textContent('#status-pill')) === 'IDLE', null);
    await page.click('#btn-mandate');
    await page.waitForFunction(() => !document.getElementById('btn-mandate').disabled, null, { timeout: 12000 });
    await page.click('#btn-run');
    await page.click('#btn-guard');
    ok('A after C: 3 flags + #inj1 visible', (await page.locator('.flag').count()) === 3 && (await page.locator('#inj1').isVisible()), null);
    await page.click('#btn-fix');
    await page.click('#btn-approve');
    await page.waitForSelector('#receipt.on');
    ok('A after C: signed intent receipt stamp', (await page.textContent('#receipt-stamp')).includes('Intent receipt') && (await page.locator('.fullsig').isVisible()), await page.textContent('#receipt-stamp'));
  }

  ok('0 console errors', errors.length === 0, errors);
  ok('0 failed requests', failed.length === 0, failed);
  console.log(`info  default-path receipt source: ${source}`);
} catch (e) {
  ok('flow completed without throwing', false, e.message);
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
