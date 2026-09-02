/**
 * Screenshot harness for the verification loop (CLAUDE.md Step 8).
 *
 * No browser-automation MCP is connected in this environment, so this is the
 * Puppeteer fallback. Screenshots auto-increment into ./temporary screenshots/
 * and are never overwritten.
 *
 *   node screenshot.mjs [label]
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import puppeteer from "puppeteer";

const URL = process.env.VIZ_URL ?? "http://localhost:5173/";
const OUT_DIR = join(process.cwd(), "temporary screenshots");
const RUN_LABEL = process.argv[2] ?? "run";

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

function nextIndex() {
  const used = readdirSync(OUT_DIR)
    .map((f) => /^screenshot-(\d+)-/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 1;
}

let counter = nextIndex();

async function shot(page, label) {
  const name = `screenshot-${counter++}-${RUN_LABEL}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name) });
  console.log(`  saved ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusText(page) {
  return page.evaluate(() => document.querySelector(".viewport__status")?.textContent?.trim() ?? "");
}

/** Wait until the field has finished loading, or give up loudly. */
async function waitForField(page, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = await statusText(page);
    if (text && !text.startsWith("Loading")) return text;
    await sleep(600);
  }
  return `TIMED OUT (last status: ${await statusText(page)})`;
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--window-size=1600,1000",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
});
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${String(err).slice(0, 300)}`));

console.log(`opening ${URL}`);
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });

// The entry gesture is the one animation; catch it mid-flight.
await sleep(1400);
await shot(page, "entry-globe");

console.log("waiting for field…");
const status = await waitForField(page);
console.log(`  status: ${status}`);
await sleep(2600); // let the descent settle
await shot(page, "ops-temperature");

// --- WebGL actually drew something? ---------------------------------------
const canvasReport = await page.evaluate(() => {
  const canvas = document.querySelector(".viewport__canvas");
  if (!canvas) return { ok: false, reason: "no canvas element" };
  const gl = canvas.getContext("webgl2");
  if (!gl) return { ok: false, reason: "no webgl2 context" };

  // Read the framebuffer and count distinct non-background pixels.
  const w = canvas.width, h = canvas.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const seen = new Set();
  let nonBackground = 0;
  for (let i = 0; i < px.length; i += 4 * 97) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    // background token abyss = #050B12
    if (Math.abs(r - 5) > 6 || Math.abs(g - 11) > 6 || Math.abs(b - 18) > 6) nonBackground++;
    seen.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return {
    ok: true, width: w, height: h,
    sampled: Math.floor(px.length / (4 * 97)),
    nonBackground,
    distinctColours: seen.size,
    renderer: gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
  };
});
console.log("  canvas:", JSON.stringify(canvasReport));

// --- Ocean scene: is there actually an ocean, and does it run? -------------
await sleep(2500); // let the frame-rate average settle
const sceneReport = await page.evaluate(() => {
  const scene = window.__oceanScene;
  if (!scene) return { ok: false, reason: "scene not exposed" };
  return {
    ok: true,
    fps: Math.round(scene.fps),
    frames: scene.frameCount,
    underwater: scene.isUnderwater,
    exaggeration: Math.round(scene.verticalExaggeration),
  };
});
console.log("  scene:", JSON.stringify(sceneReport));

// --- Depth ruler ----------------------------------------------------------
const rulerReport = await page.evaluate(() => {
  const ticks = [...document.querySelectorAll(".depth-ruler__tick")].map((el) => ({
    label: el.querySelector(".depth-ruler__tick-label")?.textContent ?? null,
    top: el.style.top,
    fontSize: el.querySelector(".depth-ruler__tick-label")
      ? getComputedStyle(el.querySelector(".depth-ruler__tick-label")).fontSize
      : null,
    fontFamily: el.querySelector(".depth-ruler__tick-label")
      ? getComputedStyle(el.querySelector(".depth-ruler__tick-label")).fontFamily.split(",")[0]
      : null,
  }));
  return { count: ticks.length, ticks: ticks.filter((t) => t.label) };
});
console.log("  depth ruler:", JSON.stringify(rulerReport));

// --- Colorbar -------------------------------------------------------------
const colorbarReport = await page.evaluate(() => ({
  units: document.querySelector(".colorbar__units")?.textContent?.trim(),
  ticks: [...document.querySelectorAll(".colorbar__tick-label")].map((e) => e.textContent),
  note: document.querySelector(".colorbar__note")?.textContent?.trim(),
}));
console.log("  colorbar:", JSON.stringify(colorbarReport));

// --- Provenance -----------------------------------------------------------
console.log("  provenance:", await page.evaluate(
  () => document.querySelector(".provenance__text")?.textContent?.trim(),
));

// --- Depth window drag (keyboard, which also proves operability) -----------
await page.evaluate(() => {
  const handles = document.querySelectorAll(".depth-ruler__handle");
  handles[1]?.focus();
});
for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowUp");
await sleep(500);
await shot(page, "depth-window-narrowed");

// --- Markers must actually exist in the scene and be hoverable -------------
// Regression guard: reloading a field once wiped the marker meshes, and the
// only symptom was floats silently missing from the water column.
const canvasBox = await page.evaluate(() => {
  const c = document.querySelector(".viewport__canvas");
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
let hoverHit = null;
if (canvasBox) {
  outer: for (let dy = -170; dy <= 130; dy += 14) {
    for (let dx = -300; dx <= 300; dx += 14) {
      await page.mouse.move(canvasBox.x + dx, canvasBox.y + dy);
      await sleep(9);
      hoverHit = await page.evaluate(
        () => document.querySelector(".viewport__hover")?.textContent?.trim() ?? null,
      );
      if (hoverHit) break outer;
    }
  }
}
console.log(`  marker hover in 3D scene: ${hoverHit ? `HIT "${hoverHit}"` : "NONE — markers missing?"}`);

// --- Select a float -------------------------------------------------------
// Prefer a featured float (2901335 / 2901327), which is what the demo narrates.
const floatReport = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".float-list__item")];
  return {
    count: items.length,
    ids: items.map((i) => i.querySelector(".float-list__id")?.textContent?.trim()),
  };
});
console.log("  float list:", JSON.stringify(floatReport));

const picked = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".float-list__item")];
  const preferred =
    items.find((i) => i.querySelector(".float-list__id")?.textContent?.includes("2901327")) ??
    items.find((i) => i.querySelector(".float-list__pip--featured")) ??
    items[0];
  if (!preferred) return null;
  preferred.click();
  return preferred.querySelector(".float-list__id")?.textContent?.trim() ?? null;
});
await sleep(900);
const panelOpened = await page.evaluate(() => Boolean(document.querySelector(".profile-panel")));
console.log(`  selected float ${picked}; profile panel opened: ${panelOpened}`);

if (panelOpened) {
  await page.waitForFunction(
    () => !document.querySelector(".profile-panel__body")?.textContent?.includes("Loading"),
    { timeout: 90000 },
  ).catch(() => console.log("  (profile still loading at timeout)"));
  await sleep(700);
  await shot(page, "profile-panel");
  console.log("  panel:", await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".stat-row")].map(
      (r) => `${r.querySelector(".stat-row__label")?.textContent}: ${r.querySelector(".stat-row__value")?.textContent}`,
    );
    return JSON.stringify({
      id: document.querySelector(".profile-panel__id")?.textContent,
      rows,
      hasChart: Boolean(document.querySelector(".profile-panel svg path")),
    });
  }));
}

// --- Explore mode ---------------------------------------------------------
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll(".mode-toggle__button")];
  buttons.find((b) => b.textContent?.trim() === "Explore")?.click();
});
await sleep(900);
await shot(page, "explore-mode");

// --- Salinity -------------------------------------------------------------
await page.evaluate(() => {
  const options = [...document.querySelectorAll(".variable-option")];
  options.find((b) => b.textContent?.includes("Salinity"))?.click();
});
const salinityStatus = await waitForField(page);
console.log(`  salinity status: ${salinityStatus}`);
await sleep(1200);
await shot(page, "explore-salinity");

// --- Reduced motion: the entry gesture must be skipped entirely ------------
const reduced = await browser.newPage();
await reduced.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await reduced.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await reduced.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await sleep(1200);

// With reduced motion the globe must never appear and the skip button must be
// gone, because there is nothing to skip.
const reducedReport = await reduced.evaluate(() => ({
  skipButtonPresent: Boolean(document.querySelector(".skip-entry")),
  status: document.querySelector(".viewport__status")?.textContent?.trim(),
}));
console.log("  reduced-motion:", JSON.stringify(reducedReport));
const rName = `screenshot-${counter++}-${RUN_LABEL}-reduced-motion.png`;
await reduced.screenshot({ path: join(OUT_DIR, rName) });
console.log(`  saved ${rName}`);

// --- Narrow viewport: Explore must survive a phone -------------------------
const mobile = await browser.newPage();
await mobile.setViewport({ width: 414, height: 860, deviceScaleFactor: 2 });
await mobile.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await sleep(2500);
await mobile.evaluate(() => {
  [...document.querySelectorAll(".mode-toggle__button")]
    .find((b) => b.textContent?.trim() === "Explore")?.click();
});
await sleep(1200);
const overflow = await mobile.evaluate(() => ({
  bodyScrollW: document.body.scrollWidth,
  windowW: window.innerWidth,
  horizontalOverflow: document.body.scrollWidth > window.innerWidth,
}));
console.log("  mobile:", JSON.stringify(overflow));
const mName = `screenshot-${counter++}-${RUN_LABEL}-mobile-explore.png`;
await mobile.screenshot({ path: join(OUT_DIR, mName) });
console.log(`  saved ${mName}`);

console.log("\nconsole errors:", consoleErrors.length);
consoleErrors.slice(0, 12).forEach((e) => console.log("   !", e));

await browser.close();
console.log("done.");
