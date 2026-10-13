// record_ui.ts — scripted walkthrough of the FinalCheck mock, recorded by Playwright.
import { writeFileSync } from "node:fs";
import { chromium, type Locator, type Page } from "playwright";

const outDir = process.env.KIT_VIDEO_DIR ?? "demo/raw/ui";
const appUrl = process.env.KIT_APP_URL ?? "http://localhost:8000";
const ZOOM = Number(process.env.KIT_UI_ZOOM ?? 1.2);
const SIZE = { width: Math.round(1920 / ZOOM), height: Math.round(960 / ZOOM) };

const FLAT = !!process.env.KIT_FLAT; // skip in-page zoom — post-capture camera instead

let page: Page;
let pos = { x: SIZE.width / 2, y: SIZE.height / 2 };
const cues: any[] = [];

const hold = (ms: number) => page.waitForTimeout(ms);

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

async function click(target: Locator, after = 700, label?: string) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`not visible: ${target}`);
  await cue("click", target, label);
  await glide({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await hold(500);
  await page.mouse.down();
  await page.mouse.up();
  await hold(after);
}

async function type(target: Locator, text: string, after = 600) {
  await click(target, 200);
  await target.fill("");
  await target.pressSequentially(text, { delay: 45 });
  await hold(after);
}

async function highlight(
  target: Locator,
  ms = 2200,
  opts: { zoom?: boolean; maxScale?: number; label?: string } = {}
) {
  const { zoom: wantZoom = true, maxScale = 1.8, label } = opts;
  const zoom = wantZoom && !FLAT;
  const easeIn = 700, easeOut = 900;
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

async function go(url: string, after = 1200) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.mouse.move(pos.x, pos.y);
  await hold(after);
}

function installCursor() {
  // function declaration, not a const-arrow: tsx/esbuild wraps `const f = () => {}`
  // in a __name() helper call, and this whole function is serialized into the page
  // by addInitScript — __name doesn't exist there, so install never ran.
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
    // documentElement, not body: a transform on body (highlight's zoom) re-anchors
    // position:fixed descendants — the cursor would scale + drift off the pointer.
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
  const probe = await browser.newContext({ viewport: SIZE });
  const canScreencast = typeof ((await probe.newPage()) as any).screencast?.start === "function";
  await probe.close();
  const context = await browser.newContext({
    viewport: SIZE,
    ...(canScreencast ? {} : { recordVideo: { dir: outDir, size: SIZE } }),
  });
  // tsx/esbuild decorates serialized functions with __name() calls that don't exist
  // inside the page — inject a no-op shim first so installCursor can run.
  await context.addInitScript("globalThis.__name=function(f){return f};");
  await context.addInitScript(installCursor);
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  if (canScreencast) {
    await (page as any).screencast.start({ path: `${outDir}/capture.webm`, size: SIZE, fps: 30, quality: 90 });
  }

  // land — first frame reads as "what it is"
  await go(appUrl, 300);
  markStart();

  // "So I set a mandate…" @13.0 — type during the lead-in, card lands as it's named
  await at(11.0);
  await type(page.locator("#intent"), "Gift for my mum — under £40, no subscriptions", 250);
  await click(page.locator("#btn-mandate"));
  await highlight(page.locator("#mandate-card"), 3400, { label: "mandate → hard spending rules" });

  // "Unguarded, the agent picks a £52 hamper…" @18.1 → wrong cart @20
  await at(19.7);
  await click(page.locator("#btn-run"), 700, "agent runs unguarded");
  await hold(1200);
  await highlight(page.locator(".cart"), 2600, { label: "£56.99 — over budget + hidden add-on" });

  // "the listing hid instructions only the agent could read" @23.6 — ring the picked listing
  await highlight(page.locator(".listing.picked"), 2600, { zoom: false, label: "agent-only instructions in the listing" });

  // "With FinalCheck on, every action is checked…" @26.9 → flags land on "over budget…quarantined"
  await at(27.9);
  await click(page.locator("#btn-guard"));
  await hold(600);
  await at(30.2);
  await highlight(page.locator("#verdict"), 3600, { label: "3 violations caught" });
  await at(34.2);
  await highlight(page.locator("#inj1"), 1600, { zoom: false, label: "injected text quarantined" });

  // "Approve the safe cart, and we sign an intent receipt" @35.1
  await at(35.9);
  await click(page.locator("#btn-fix"));
  await hold(500);
  await at(38.2);
  await click(page.locator("#btn-approve"));
  await highlight(page.locator("#receipt"), 5200, { label: "signed intent receipt — dispute-ready" });

  // closing line lands on the signed receipt @39.8–42.9
  await at(45.0);

  writeFileSync(
    `${outDir}/cues.json`,
    JSON.stringify({ vw: SIZE.width, vh: SIZE.height, flat: FLAT, cues }, null, 1)
  );
  if (canScreencast) await (page as any).screencast.stop();
  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
