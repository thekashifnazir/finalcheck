// Consumer-view e2e. Runs against any server that serves app/public at the root:
//   python3 -m http.server 8000 -d public          (static: no /api)
//   npx wrangler dev                                (service)
// Playwright is resolved through NODE_PATH, e.g.
//   NODE_PATH=/path/to/node_modules KIT_APP_URL=http://localhost:8000/ node demo/e2e_consumer.mjs
// Against the service it also drives /mcp as an agent (set FC_MCP_TOKEN if /mcp needs one).
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL_ = process.env.KIT_APP_URL || 'http://localhost:8000/';

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` — ${info}` : ''}`);
  if (!ok) failed += 1;
}

// Calls a FinalCheck MCP tool the way an agent would (bearer only if FC_MCP_TOKEN is set).
async function mcp(name, args = {}) {
  const res = await fetch(new URL('/mcp', URL_), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(process.env.FC_MCP_TOKEN ? { authorization: `Bearer ${process.env.FC_MCP_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`/mcp ${name} → ${res.status}`);
  return JSON.parse((await res.json()).result.content[0].text);
}

// Screenshots at key steps when E2E_SHOTS names a directory.
const SHOTS = process.env.E2E_SHOTS;
let page;
async function shot(name) {
  if (!SHOTS) return;
  const { mkdirSync } = await import('node:fs');
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/consumer-${name}.png`, fullPage: true });
}

const browser = await chromium.launch();
page = await (await browser.newContext()).newPage();

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

  // Service mode: mandates live on the server and agents reach them over /mcp.
  const service = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/mandate');
      return r.ok && (r.headers.get('content-type') || '').includes('json');
    } catch { return false; }
  });
  console.log(`mode: ${service ? 'service' : 'static'}`);
  if (service) {
    await page.evaluate(() => fetch('/api/mandate/revoke', { method: 'POST', body: '{}' }));
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
  }

  // Mandate conversation: a vague request → one question per missing field → save.
  await page.fill('#c-chat-input', 'buy something nice for mum');
  await page.press('#c-chat-input', 'Enter');
  await page.waitForSelector('#c-chat-preview:not([hidden])');
  const defaults = await page.locator('#c-chat-rows li.c-default').count();
  check('vague request → all 4 fields at default', defaults === 4, `${defaults}`);
  await shot('chat-start');
  const asked = [];
  for (const reply of ['£40', 'No — one-off only', 'A gift', 'Friday 23:59']) {
    asked.push(await page.locator('#c-chat-log li[data-who="finalcheck"]').last().textContent());
    await page.click(`#c-chat-replies button:text-is("${reply}")`);
    if (reply === 'No — one-off only') await shot('chat-midway');
  }
  const questions = asked.filter((q) => q.trim().endsWith('?'));
  check('asks exactly 4 questions, one per missing field', questions.length === 4, questions.map((q) => q.replace('FinalCheck: ', '')).join(' | '));
  await page.waitForSelector('#c-chat-actions:not([hidden])');
  const previewRows = await page.locator('#c-chat-rows li').allTextContents();
  check('preview filled from answers', (await page.locator('#c-chat-rows li.c-default').count()) === 0 && previewRows[0] === 'MAX £40', previewRows.join(' / '));
  check("ends with \"Here's your mandate\"", (await page.locator('#c-chat-log li').last().textContent()).includes("Here's your mandate"));
  await shot('chat-review');
  await page.click('#c-save-mandate');
  await page.waitForSelector('#c-mandate-active:not([hidden])');
  const summary = await page.textContent('#c-mandate-summary');
  check('save → mandate card', summary.startsWith('Up to £40 · gifts · one-off · until Fri 23:59'), summary);
  await shot('mandate-card');
  const note = await page.textContent('#c-mandate-note');
  check('mandate note matches mode', service ? /spends against this/.test(note) : /on this device/.test(note), note);

  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  check('mandate survives reload', await page.isVisible('#c-mandate-active'));
  if (service) check('agent sees the page mandate', Boolean((await mcp('get_mandate')).mandate));

  await page.click('#c-revoke');
  await page.waitForSelector('#c-mandate-active', { state: 'hidden' });
  check('Revoke removes card', !(await page.isVisible('#c-mandate-active')) && (await page.isVisible('#c-mandate-form')));

  if (service) {
    check('Revoke stops the agent', (await mcp('get_mandate')).mandate === null);

    const set = await mcp('set_mandate', { text: 'a birthday present under £30, one-off' });
    await mcp('check_cart', { items: [{ listing_id: 'lst_hamper_pro', add_recurring_addon: true }] });
    await page.waitForSelector('#c-mandate-active:not([hidden])', { timeout: 12000 });
    check('agent-set mandate appears on the page', (await page.textContent('#c-mandate-summary')).startsWith('Up to £30'), set.mandate_id);
    check('marked as set by the agent', (await page.textContent('#c-mandate-note')).includes('Set by your agent'));
    await page.waitForSelector('#c-agent-hint:not([hidden])', { timeout: 12000 });
    check('"Agent connected via MCP" hint', (await page.textContent('#c-agent-hint')).includes('Agent connected via MCP'));
    await page.click('#c-revoke');
    await page.waitForSelector('#c-mandate-form:not([hidden])');
  } else {
    check('no agent hint without the service', !(await page.isVisible('#c-agent-hint')));
  }

  // A request that states everything goes straight to review.
  await page.fill('#c-chat-input', 'Buy a birthday gift for my mum, under £40, one-off, no subscriptions, by Friday');
  await page.press('#c-chat-input', 'Enter');
  await page.waitForSelector('#c-chat-actions:not([hidden])');
  check('complete request → no questions', (await page.locator('#c-chat-replies button').count()) === 0);
  await page.click('#c-edit-mandate');
  check('Edit puts the combined text back', (await page.inputValue('#c-chat-input')).includes('under £40'));

  // "No limit" means baseline only, the same as Skip.
  await page.fill('#c-chat-input', 'buy something nice for mum');
  await page.press('#c-chat-input', 'Enter');
  await page.click('#c-chat-replies button:text-is("No limit — baseline only")');
  await page.waitForSelector('#c-skip-confirm:not([hidden])');
  check('"No limit" → baseline only', !(await page.isChecked('#c-ask-toggle')));
  await page.click('#c-ask-toggle'); // back to "ask" so Skip below is a real change

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
