/**
 * Fast single-frame capture for iterating on the look.
 *
 * The full screenshot.mjs pass drives every interaction and takes minutes under
 * software rendering. This just loads, waits for data, and captures the main
 * view — enough to judge whether the scene reads as an ocean.
 *
 *   node shot.mjs <label> [--skip] [--dive]
 *   node shot.mjs <label> --chunk [--profile] [--spec] [--hover] [--at=ms]
 *                          [--preset=Top-down|Section] [--mode=Volume|Iso]
 *                          [--var=Salinity|Chlorophyll|Current speed] [--reduced]
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import puppeteer from "puppeteer";

const OUT_DIR = join(process.cwd(), "temporary screenshots");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const label = process.argv[2] ?? "look";
const skipIntro = process.argv.includes("--skip");
const dive = process.argv.includes("--dive");

function nextIndex() {
  const used = readdirSync(OUT_DIR)
    .map((f) => /^screenshot-(\d+)-/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
  ],
});

const page = await browser.newPage();
if (process.argv.includes("--reduced")) {
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
}
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 260)); });
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 260)}`));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 120000 });

// --globe: capture the entry gesture itself, before the dive begins.
if (process.argv.includes("--globe")) {
  // Poll for the globe rather than guessing a delay — the entry only starts
  // once the catalog request resolves, so its timing varies.
  const until = Date.now() + 30000;
  let seen = false;
  while (Date.now() < until) {
    seen = await page.evaluate(() => Boolean(window.__oceanScene?.isGlobeVisible));
    if (seen) break;
    await sleep(120);
  }
  console.log("globe visible:", seen);
  const extra = Number(process.argv.find((a) => a.startsWith("--at="))?.slice(5) ?? 600);
  await sleep(extra);
  const name = `screenshot-${nextIndex()}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name) });
  console.log("saved", name);
  console.log("console errors:", errors.length);
  errors.slice(0, 8).forEach((e) => console.log("  !", e));
  await browser.close();
  process.exit(0);
}

// --globe-mode: skip the entry, then switch to the globe via the header toggle. This is
// the view you can return to, which is a different thing from the entry globe above.
if (process.argv.includes("--globe-mode")) {
  await sleep(1800);
  await page.evaluate(() => document.querySelector(".skip-entry")?.click());
  await sleep(2500);
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll(".mode-toggle__button")].find(
      (b) => b.textContent.trim() === "Globe",
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  console.log("globe toggle clicked:", clicked);
  await sleep(Number(process.argv.find((a) => a.startsWith("--at="))?.slice(5) ?? 6000));
  const report = await page.evaluate(() => {
    const s = window.__oceanScene;
    return s ? { fps: Math.round(s.fps), view: s.currentView } : { error: "scene not exposed" };
  });
  console.log("scene:", JSON.stringify(report));
  const name = `screenshot-${nextIndex()}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name) });
  console.log("saved", name);
  console.log("console errors:", errors.length);
  errors.slice(0, 8).forEach((e) => console.log("  !", e));
  await browser.close();
  process.exit(0);
}

// --chunk: the chunk view, reached through the header's view toggle. It owns its
// own canvas and its own chrome, so none of the console selectors below apply —
// wait on .chunk-layers, which only mounts once the engine has started.
if (process.argv.includes("--chunk")) {
  await sleep(1500);
  await page.evaluate(() => document.querySelector(".skip-entry")?.click());
  const clicked = await page.evaluate(() => {
    const button = document.querySelector("#btn-view-chunk");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  console.log("chunk toggle clicked:", clicked);
  try {
    await page.waitForSelector(".chunk-layers", { timeout: 60000 });
  } catch {
    console.log("!! chunk panels never mounted");
  }
  // The load-in descent runs 1.5 s; the currents need a few frames beyond that.
  await sleep(Number(process.argv.find((a) => a.startsWith("--at="))?.slice(5) ?? 9000));

  const pick = (selector, text) =>
    page.evaluate(
      (sel, want) => {
        // Variable rows carry a unit alongside the label, so match on the
        // start of the text and click the button the match lives in.
        const el = [...document.querySelectorAll(sel)].find((b) =>
          b.textContent.trim().toLowerCase().startsWith(want.toLowerCase()),
        );
        const button = el?.closest("button") ?? el;
        if (!button) return false;
        button.click();
        return true;
      },
      selector,
      text,
    );

  const varName = process.argv.find((a) => a.startsWith("--var="))?.slice(6);
  if (varName) {
    console.log("variable:", varName, await pick(".chunk-var__label", varName));
    await sleep(1500);
  }
  const modeName = process.argv.find((a) => a.startsWith("--mode="))?.slice(7);
  if (modeName) {
    console.log("mode:", modeName, await pick(".chunk-seg__btn", modeName));
    await sleep(2500);
  }
  const presetName = process.argv.find((a) => a.startsWith("--preset="))?.slice(9);
  if (presetName) {
    console.log("preset:", presetName, await pick(".chunk-presets__btn", presetName));
    await sleep(2500);
  }

  if (process.argv.includes("--hover")) {
    // Park the cursor over the middle of the active plane and let one frame's
    // raycast land.
    await page.mouse.move(800, 430);
    await page.mouse.move(802, 432);
    await sleep(900);
  }

  if (process.argv.includes("--profile")) {
    await page.evaluate(() => {
      const layers = [...document.querySelectorAll(".chunk-layer")];
      const row = layers.find((l) => l.textContent.includes("Instrument traces"));
      row?.querySelector(".chunk-layer__chev")?.click();
    });
    await sleep(600);
    await page.evaluate(() => document.querySelector(".chunk-platform")?.click());
    await sleep(1200);
  }
  if (process.argv.includes("--spec")) {
    await page.evaluate(() => document.querySelector(".chunk-time__spec")?.click());
    await sleep(600);
  }

  const report = await page.evaluate(() => ({
    fps: document.querySelector(".chunk-fps")?.textContent ?? "?",
    res: document.querySelector(".chunk-res__label")?.textContent ?? "?",
    extent: document.querySelector(".chunk-crumb__extent")?.textContent ?? "?",
    layers: document.querySelectorAll(".chunk-layer").length,
    ticks: [...document.querySelectorAll(".chunk-ruler__tick")].filter(
      (t) => t.style.opacity === "1",
    ).length,
    canvas: (() => {
      const all = document.querySelectorAll(".chunk-view__canvas canvas");
      return all.length === 1 ? `${all[0].width}x${all[0].height}` : `count=${all.length}`;
    })(),
    rulerNodes: document.querySelectorAll(".chunk-ruler__tick").length,
  }));
  console.log("chunk:", JSON.stringify(report));
  const name = `screenshot-${nextIndex()}-${label}.png`;
  await page.screenshot({ path: join(OUT_DIR, name) });
  console.log("saved", name);
  console.log("console errors:", errors.length);
  errors.slice(0, 8).forEach((e) => console.log("  !", e));
  await browser.close();
  process.exit(0);
}

if (skipIntro) {
  await sleep(1500);
  await page.evaluate(() => document.querySelector(".skip-entry")?.click());
}

// Wait for the field, then give the terrain and a few frames time to land.
const deadline = Date.now() + 150000;
while (Date.now() < deadline) {
  const status = await page.evaluate(
    () => document.querySelector(".viewport__status")?.textContent?.trim() ?? "",
  );
  if (status && !status.startsWith("Loading")) break;
  await sleep(800);
}
await sleep(9000);

if (dive) {
  // Drag downward to push the camera under the waterline.
  const box = await page.evaluate(() => {
    const c = document.querySelector(".viewport__canvas");
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(box.x, box.y - i * 9);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(6000);
}

const report = await page.evaluate(() => {
  const s = window.__oceanScene;
  return s
    ? { fps: Math.round(s.fps), frames: s.frameCount, underwater: s.isUnderwater }
    : { error: "scene not exposed" };
});
console.log("scene:", JSON.stringify(report));
console.log("console errors:", errors.length);
errors.slice(0, 10).forEach((e) => console.log("  !", e));

const name = `screenshot-${nextIndex()}-${label}.png`;
await page.screenshot({ path: join(OUT_DIR, name) });
console.log("saved", name);

await browser.close();
