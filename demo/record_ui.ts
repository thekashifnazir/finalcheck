// record_ui.ts — a scripted walk through the REAL running app, recorded by Playwright.
// kit-video runs it with `npx tsx demo/record_ui.ts`; KIT_VIDEO_DIR is where the
// recording must land and KIT_APP_URL (default http://localhost:8787/ops/) is the app.
// Start the app first. Re-run after any UI change — a fumbled take is one re-run.
//
// Why the helpers: Playwright's own pointer is invisible on video and jumps between
// targets, so viewers can't follow. These draw a visible cursor that glides, ripple
// on every click, type at human speed, and pause so each step can be read.
// The browser renders at its natural desktop layout (1600×800 by default) and kit-video
// scales it into the frame above a caption band, so captions never cover the UI.
// highlight() zooms smoothly onto the element it rings, then back out — small text
// becomes readable without cramping the whole layout. KIT_UI_ZOOM (default 1.2) is
// how much the whole page is enlarged in the final frame: higher = bigger text, less room.
// Seed realistic data first; show one complete path with real input.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Locator, Page } from "playwright";
// require(), not import: CommonJS resolution honours NODE_PATH, ESM does not. With no local
// install, point NODE_PATH at any node_modules that has playwright (kit-video passes env through):
//   NODE_PATH=/path/to/node_modules kit-video
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const outDir = process.env.KIT_VIDEO_DIR ?? "demo/raw/ui";
const appUrl = process.env.KIT_APP_URL ?? "http://localhost:8787/ops/";
// the picture area kit-video fills: a 1920×1080 frame minus a 120px caption band (2:1)
const ZOOM = Number(process.env.KIT_UI_ZOOM ?? 1.2);
const SIZE = { width: Math.round(1920 / ZOOM), height: Math.round(960 / ZOOM) };

const FLAT = !!process.env.KIT_FLAT; // skip in-page zoom — post-capture camera instead

let page: Page;
let pos = { x: SIZE.width / 2, y: SIZE.height / 2 };
const cues: any[] = [];

const hold = (ms: number) => page.waitForTimeout(ms);

// Sync to the voiceover: call markStart() once the first screen is ready (kit-video trims
// everything recorded before it — the blank page load), then at(seconds) waits until that
// many seconds after the mark. Take the seconds from `kit-video --timings`, which prints
// when each word of demo/script.md is spoken.
const t0 = Date.now();
let mark = t0;
function markStart() {
  mark = Date.now();
  writeFileSync(`${outDir}/start.txt`, String((mark - t0) / 1000));
}
async function at(seconds: number) {
  const wait = mark + seconds * 1000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}
const now = () => (Date.now() - mark) / 1000;
async function selName(target: Locator) {
  return target.evaluate(
    (el) => (el.id ? "#" + el.id : "." + String(el.className).trim().split(/\s+/)[0])
  );
}
async function cue(kind: string, target: Locator, label?: string, zoom = false, ms = 0) {
  const box = await target.boundingBox();
  if (box)
    cues.push({
      t: now(), kind, sel: await selName(target),
      box: { x: box.x, y: box.y, w: box.width, h: box.height }, label, zoom, ms,
    });
}

/** Glide the visible cursor to the element, hover, click, pause. */
async function click(target: Locator, after = 700, label?: string) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`not visible: ${target}`);
  await cue("click", target, label);
  await glide({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await hold(500); // hover before clicking — signals intent to the viewer
  await page.mouse.down();
  await page.mouse.up();
  await hold(after);
}

/** Eased cursor travel — an easeInOut path over ~0.2-0.65s scaled by distance,
 * instead of Playwright's evenly-stepped move (reads as a teleport/hard stop). */
async function glide(to: { x: number; y: number }) {
  const from = pos;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(4, Math.round(Math.min(650, Math.max(220, dist * 0.9)) / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    if (i < steps) await page.waitForTimeout(16);
  }
  pos = to;
}

/** Click into a field and type like a person. */
async function type(target: Locator, text: string, after = 600) {
  await click(target, 200);
  await target.pressSequentially(text, { delay: 45 });
  await hold(after);
}

/** Ring an element and zoom smoothly onto it, hold, zoom back out. zoom: false = ring only.
 * ms is the whole window including both transitions: zoomed dwell ≈ ms − 1600.
 * Hold while the narration is ON the element (3-5s total is typical), not just a flash —
 * and don't zoom out if the next beat lands on the same region. */
async function highlight(
  target: Locator,
  ms = 2200,
  opts: { zoom?: boolean; maxScale?: number; label?: string } = {}
) {
  const { zoom: wantZoom = true, maxScale = 1.8, label } = opts;
  const zoom = wantZoom && !FLAT;
  const easeIn = 700, easeOut = 900; // in slightly bouncy, out softer
  ms = Math.max(ms, zoom ? easeIn + easeOut + 400 : 300);
  await target.scrollIntoViewIfNeeded();
  await cue("highlight", target, label, wantZoom, ms);
  await target.evaluate((el, o) => {
    const r = el.getBoundingClientRect();
    const sx = scrollX, sy = scrollY;
    const ring = document.createElement("div");
    ring.style.cssText =
      `position:absolute;left:${r.left + sx - 8}px;top:${r.top + sy - 8}px;width:${r.width + 16}px;` +
      `height:${r.height + 16}px;border:3px solid rgba(255,255,255,.95);border-radius:10px;` +
      "box-shadow:0 0 0 9999px rgba(0,0,0,.22);z-index:2147483646;pointer-events:none;";
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), o.ms);
    if (!o.zoom) return;
    // scale so the element fills ~80% of the view, never past maxScale; keep page edges in frame
    const W = innerWidth, H = innerHeight;
    const s = Math.max(1, Math.min(o.maxScale, (0.8 * W) / (r.width + 32), (0.8 * H) / (r.height + 32)));
    if (s < 1.08) return;
    let tx = W / 2 + sx - s * (r.left + sx + r.width / 2);
    let ty = H / 2 + sy - s * (r.top + sy + r.height / 2);
    tx = Math.min(sx - s * sx, Math.max(sx + W - s * (sx + W), tx));
    ty = Math.min(sy - s * sy, Math.max(sy + H - s * (sy + H), ty));
    const b = document.body;
    b.style.transformOrigin = "0 0";
    b.style.transition = `transform ${o.easeIn}ms cubic-bezier(.4,0,.2,1)`;
    b.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    setTimeout(() => {
      b.style.transition = `transform ${o.easeOut}ms cubic-bezier(.25,.46,.45,.94)`;
      b.style.transform = "";
    }, o.ms - o.easeOut);
  }, { ms, zoom, maxScale, easeIn, easeOut });
  await hold(ms);
}

/** Navigate and put the cursor back where it was. */
async function go(url: string, after = 1200) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.mouse.move(pos.x, pos.y);
  await hold(after);
}

// Injected into every page: a big white arrow cursor + a thin white click ring.
function installCursor() {
  // plain function declaration (not a const-arrow) — this body is serialized into
  // the page via addInitScript, so avoid bundler-decorated constructs.
  function install() {
    if (document.getElementById("__kit_cursor")) return;
    const c = document.createElement("div");
    c.id = "__kit_cursor";
    // ~34px mac-style pointing hand; fingertip at viewBox (8,1) → offset -14/-2px
    // so the tip lands on the cursor point.
    c.innerHTML =
      '<svg width="34" height="34" viewBox="0 0 20 20" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">' +
      '<path d="M8 1 C7.2 1 6.7 1.6 6.7 2.5 L6.7 9 L6 8.4 C5 7.5 3.7 7.9 3.4 9 C3.2 9.7 3.5 10.4 4.4 12.2 ' +
      'C5.9 15 7.4 17.3 10 17.3 L13.4 17.3 C15.6 17.3 17 15.7 17 13.5 L17 7.5 C17 6.7 16.4 6.2 15.7 6.2 ' +
      'C15.3 6.2 15 6.4 14.8 6.7 L14.8 5.8 C14.8 5 14.2 4.5 13.5 4.5 C13 4.5 12.6 4.8 12.4 5.2 L12.4 4.5 ' +
      'C12.4 3.7 11.8 3.2 11.1 3.2 C10.6 3.2 10.2 3.5 10 3.9 L10 4 L10 2.5 C10 1.6 9.3 1 8 1 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    c.style.cssText =
      "position:fixed;left:-50px;top:-50px;width:34px;height:34px;" +
      "z-index:2147483647;pointer-events:none;transition:transform .12s ease;";
    // documentElement, NOT body: a transform on body (highlight()'s zoom) re-anchors
    // every position:fixed descendant — the cursor would scale and drift off the
    // real pointer location. Outside body it stays 1:1 with the viewport.
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => {
      c.style.left = e.clientX - 14 + "px";
      c.style.top = e.clientY - 2 + "px";
    }, true);
    addEventListener("mousedown", (e) => {
      c.style.transform = "scale(.85)";
      setTimeout(() => { c.style.transform = "scale(1)"; }, 120);
      const r = document.createElement("div");
      r.style.cssText =
        `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:10px;height:10px;` +
        "margin:-5px 0 0 -5px;border-radius:50%;border:2px solid rgba(255,255,255,.9);" +
        "box-shadow:0 0 4px rgba(0,0,0,.5);" +
        "z-index:2147483647;pointer-events:none;transition:all .45s ease-out;opacity:1;";
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => {
        r.style.width = r.style.height = "56px";
        r.style.margin = "-28px 0 0 -28px";
        r.style.opacity = "0";
      });
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener("mouseup", () => { c.style.transform = "scale(1)"; }, true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
}

async function main() {
  const browser = await chromium.launch();
  // page.screencast (Playwright ≥1.59; fps ≥1.64) beats context recordVideo: real
  // fps + JPEG-quality control instead of a fixed ~1Mbit VP8. Probe once — older
  // Playwright keeps the recordVideo path.
  const probe = await browser.newContext({ viewport: SIZE });
  const canScreencast = typeof ((await probe.newPage()) as any).screencast?.start === "function";
  await probe.close();
  const context = await browser.newContext({
    viewport: SIZE,
    ...(canScreencast ? {} : { recordVideo: { dir: outDir, size: SIZE } }),
  });
  // tsx/esbuild decorates serialized function bodies with __name() helper calls that
  // don't exist inside the page — inject a no-op shim first so installCursor runs.
  await context.addInitScript("globalThis.__name=function(f){return f};");
  await context.addInitScript(installCursor);
  page = await context.newPage();
  page.setDefaultTimeout(8000); // a missing element fails the take fast, not after 30s
  if (canScreencast) {
    await (page as any).screencast.start({ path: `${outDir}/capture.webm`, size: SIZE, fps: 30, quality: 90 });
  }

  // Timings come from `kit-video --timings` on demo/script.md (VO ≈ 71s).
  // person 0–10 · why now 10–18 · demo 18–52 (wow ≈ 31–35) · trust 52–64 · close 64–71
  const origin = new URL(appUrl).origin;
  await page.request.post(`${origin}/api/events/reset`, { data: {} }).catch(() => {}); // clean feed for the close

  // 1. "Meet Priya…" — the consumer view: what protects her by default
  await go(`${origin}/`, 300);
  markStart();
  await at(2.0);
  await highlight(page.locator("#c-protection"), 6500, { label: "on by default — even without a mandate" });

  // "…nothing checks the agent before the money moves." → the checkpoint itself
  await at(15.0);
  await go(appUrl, 600);
  await highlight(page.locator("#howto"), 1600, { zoom: false, label: "Back end: the ops console — what FinalCheck checks behind the scenes" });

  // 2. "FinalCheck turns her words into a mandate…"
  await page.locator("#intent").fill(""); // start from an empty box so the typed intent reads cleanly
  await type(page.locator("#intent"), "Gift for my mum — under £40, no subscriptions", 200);
  await click(page.locator("#btn-mandate"), 400, "arm the mandate");
  await page.locator("#mandate-card.on").waitFor();
  await highlight(page.locator("#mandate-card"), 2600, { label: "£40 cap · one-off · gift · expires Fri" });

  // "Unguarded, the agent picks a £52 hamper and adds a £4.99 monthly club."
  await at(24.0);
  await click(page.locator("#btn-run"), 500, "agent shops — guard off");
  await hold(900); // step rows fade in on a 350ms stagger
  await highlight(page.locator(".cart"), 3000, { label: "£56.99 pending" });

  // "Why? The listing hid white-on-white text only the agent could read."
  await at(30.0);
  await highlight(page.locator(".listing.picked"), 3000, { zoom: false, label: "this listing hides agent-only text" });

  // "FinalCheck blocks all 3…"
  await at(34.0);
  await click(page.locator("#btn-guard"), 400, "re-run with FinalCheck");
  await page.locator("#verdict.on").waitFor();
  await highlight(page.locator("#inj1"), 2400, { label: "“ignore the price limit” — shown, never obeyed" });
  await highlight(page.locator("#flags"), 4200, { label: "3 blocked, each with its rule basis" });

  // "Sent back, the agent finds a £34.99 tea set. Priya approves…"
  await at(43.5);
  await click(page.locator("#btn-fix"), 1400, "reject — agent rebuilds the cart");
  await at(47.8);
  await click(page.locator("#btn-approve"), 400, "approve & sign");
  await page.locator("#receipt.on").waitFor();
  await highlight(page.locator("#receipt"), 3600, { label: "receipt of exactly what she authorised" });

  // 3. Trust: "Real… Mocked… No real money moves."
  await at(53.0);
  await highlight(page.locator("#dispute"), 2600, { zoom: false, label: "dispute-ready evidence" });
  await at(59.5);
  await highlight(page.locator("#demo-banner"), 4000, { label: "demo data — mocked agent, shops and payment" });

  // 4. Close: back to Priya's view — what her agent did, in plain English
  await at(64.0);
  await go(`${origin}/`, 300);
  await highlight(page.locator("#c-activity-section"), 5000, { label: "what her agent did" });
  await at(71.5);

  // camera cues for the compositor: kit-video feeds these to renderers that can
  // do post-capture zoom/callouts (hyperframes). `flat` marks whether this take
  // skipped in-page zoom (KIT_FLAT) so the renderer never double-zooms.
  writeFileSync(
    `${outDir}/cues.json`,
    JSON.stringify({ vw: SIZE.width, vh: SIZE.height, flat: FLAT, cues }, null, 1)
  );
  if (canScreencast) await (page as any).screencast.stop(); // flushes capture.webm
  await context.close(); // flushes the recordVideo file on old Playwright
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
