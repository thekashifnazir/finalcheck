// Consumer-view e2e. Runs against any server that serves app/public at the root:
//   python3 -m http.server 8000 -d public          (static: no /api)
//   npx wrangler dev                                (service)
// Playwright is resolved through NODE_PATH, e.g.
//   NODE_PATH=/path/to/node_modules KIT_APP_URL=http://localhost:8000/ node demo/e2e_consumer.mjs
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL_ = process.env.KIT_APP_URL || 'http://localhost:8000/';

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
  if (!ok) failed += 1;
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

// /api endpoints that aren't deployed yet answer 404/501 on a static server. The page
// handles that; the browser still logs the failed load, so those are counted apart.
const errors = [];
let missingApi = 0;
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const isMissingApi = /Failed to load resource/.test(msg.text()) && (msg.location().url || '').includes('/api/');
  if (isMissingApi) missingApi += 1;
  else errors.push(msg.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL_);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });

  const bullets = await page.locator('#c-bullets li').allTextContents();
  check('5 protection bullets', bullets.length === 5, `${bullets.length}`);
  check('UK baseline status', (await page.textContent('#c-protection-status')).includes('UK baseline'));

  await page.selectOption('#c-region', 'sg');
  await page.waitForFunction(() => document.getElementById('c-protection-status').textContent.includes('SG baseline'));
  check('UK → SG re-render', (await page.textContent('#c-pack')).includes('Singapore'));
  await page.selectOption('#c-region', 'uk');
  await page.waitForFunction(() => document.getElementById('c-protection-status').textContent.includes('UK baseline'));

  await page.fill('#c-intent', 'Buy a birthday gift for my mum, under £40, one-off, no subscriptions');
  await page.click('#c-set-mandate');
  await page.waitForSelector('#c-mandate-active:not([hidden])');
  const summary = await page.textContent('#c-mandate-summary');
  check('set mandate → card', summary.startsWith('Up to £40 · gifts · one-off · until'), summary);

  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  check('mandate survives reload', await page.isVisible('#c-mandate-active'));

  await page.click('#c-revoke');
  check('Revoke removes card', !(await page.isVisible('#c-mandate-active')) && (await page.isVisible('#c-mandate-form')));

  await page.click('#c-skip');
  await page.waitForSelector('#c-skip-confirm:not([hidden])');
  check('Skip shows confirmation', (await page.textContent('#c-skip-confirm')).includes("won't be asked again"));
  check('Skip turns off ask toggle', !(await page.isChecked('#c-ask-toggle')));

  const feed = await page.textContent('#c-activity-status');
  const rows = await page.locator('#c-activity li').count();
  check('activity: feed rows or connect message', rows > 0 || /Connect to the FinalCheck service|Nothing yet/.test(feed), rows ? `${rows} rows` : feed);

  const body = await page.textContent('body');
  const codes = body.match(/\b[A-Z]{3,}_[A-Z_]+\b/g);
  check('no rule codes on the page', !codes, codes?.join(', ') ?? '');

  check('0 console errors', errors.length === 0, errors.join(' | ') || `(${missingApi} missing-/api loads ignored)`);
} catch (e) {
  check('run completed', false, e.message);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
