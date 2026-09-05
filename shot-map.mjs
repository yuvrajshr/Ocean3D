/**
 * Capture the 2D map view.
 *
 * The existing shot.mjs waits on `window.__oceanScene`, which the map does not
 * use — it has its own canvas and never touches viz/scene.ts. Readiness here is
 * "a layer has finished colouring", which the layer housing reports by replacing
 * its "Loading scale…" placeholder with a real range.
 *
 *   node shot-map.mjs <label> [--point] [--area] [--reduced] [--mobile]
 *
 * As always: this runs on SwiftShader. It verifies composition and correctness
 * and tells you nothing about real performance.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import puppeteer from "puppeteer";

const OUT_DIR = join(process.cwd(), "temporary screenshots");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const label = process.argv[2] ?? "map";
const wantPoint = process.argv.includes("--point");
const wantArea = process.argv.includes("--area");
const reduced = process.argv.includes("--reduced");
const mobile = process.argv.includes("--mobile");
const wantStack = process.argv.includes("--stack");
const wantZoom = process.argv.includes("--zoom");

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
await page.setViewport(
  mobile
    ? { width: 414, height: 896, deviceScaleFactor: 1 }
    : { width: 1600, height: 1000, deviceScaleFactor: 1 },
);
if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 260));
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 260)}`));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 120000 });

// Wait for a layer to finish colouring rather than guessing a delay: the first
// HYCOM slice is a real network fetch and its timing varies.
const until = Date.now() + 90000;
let ready = false;
while (Date.now() < until) {
  ready = await page.evaluate(() => {
    const scale = document.querySelector(".layer-bar__scale");
    if (!scale) return false;
    return !scale.textContent.includes("Loading");
  });
  if (ready) break;
  await sleep(700);
}
await sleep(1800); // let the raster composite and the flow field seed


if (wantPoint) {
  const box = await page.$eval(".map", (n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // A point in the Bay of Bengal region of the frame.
  await page.mouse.click(box.x + box.w * 0.66, box.y + box.h * 0.46);
  await sleep(32000);
}

if (wantZoom) {
  // Zoom into the Bay of Bengal: past the threshold the map must swap the 110m
  // reference geography for the 50m set.
  const box = await page.$eval(".map", (n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w * 0.745;
  const cy = box.y + box.h * 0.47;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 9; i++) {
    await page.mouse.wheel({ deltaY: -240 });
    await sleep(420);
  }
  await sleep(9000);
}

if (wantStack) {
  // Add chlorophyll: a SURFACE field on a different cadence. Stacking it tests
  // the cadence rules and the "no depth ruler for a surface field" rule at once.
  await page.select(".layer-stack__add", "viirs_chlorophyll");
  await sleep(1500);
  // Make it the active layer, so the depth ruler must disappear.
  const titles = await page.$$(".layer-card__title");
  if (titles[0]) await titles[0].click();
  await sleep(14000);
}

if (wantArea) {
  await page.click(".tool-rail__button:nth-child(2)");
  const box = await page.$eval(".map", (n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.72, box.y + box.h * 0.52, { steps: 12 });
  await page.mouse.up();
  await sleep(900);
}

const report = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll(".map__canvas")];
  // Is the data canvas actually painted, or is it a blank sheet?
  const data = canvases[1];
  let painted = 0;
  if (data) {
    const ctx = data.getContext("2d");
    const w = data.width;
    const h = data.height;
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4 * 97) if (px[i] > 8) painted++;
  }
  return {
    canvases: canvases.length,
    dataPaintedSamples: painted,
    layers: [...document.querySelectorAll(".layer-card__title")].map((n) => n.textContent),
    source: document.querySelector(".layer-card__source")?.textContent ?? null,
    state: document.querySelector(".layer-card__state")?.textContent ?? null,
    pointValue: document.querySelector(".point-panel__number")?.textContent ?? null,
    pointMeta: document.querySelector(".point-panel__meta")?.textContent ?? null,
    pointCharts: [...document.querySelectorAll(".point-panel__chart-title")].map((n) => n.textContent),
    pointStats: document.querySelector(".point-panel__stats")?.textContent ?? null,
    pointEmpty: document.querySelector(".point-panel__empty")?.textContent ?? null,
    scale: document.querySelector(".layer-bar__scale")?.textContent ?? null,
    depthStops: document.querySelectorAll(".map-depth__stop").length,
    layerSources: [...document.querySelectorAll(".layer-card__source")].map((n) => n.textContent),
    layerStates: [...document.querySelectorAll(".layer-card__state")].map((n) => n.textContent),
    offsets: [...document.querySelectorAll(".layer-card__offset")].map((n) => n.textContent),
    areaAction: document.querySelector(".map__area-action")?.textContent ?? null,
    depthNote: document.querySelector(".panel__note")?.textContent ?? null,
    gridLabels: [...document.querySelectorAll(".map__grid-label")].slice(0, 6).map((n) => n.textContent),
    extentLabel: document.querySelector(".map__extent-label")?.textContent ?? null,
    geoScale: window.__mapGeoScale ?? null,
    basemapInk: (() => {
      // Are the coast/border strokes actually on the basemap canvas? Count
      // pixels that are neither transparent nor the flat land fill.
      const c = document.querySelectorAll(".map__canvas")[0];
      if (!c) return null;
      const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let land = 0, ink = 0;
      for (let i = 0; i < px.length; i += 4 * 31) {
        if (px[i + 3] < 8) continue;
        if (px[i] > 40) ink++; else land++;
      }
      return { landSamples: land, strokeSamples: ink };
    })(),
    provenance: document.querySelector(".provenance__text")?.textContent ?? null,
    subtitle: document.querySelector(".header__subtitle")?.textContent ?? null,
    timelineYears: [...document.querySelectorAll(".map-timeline__year")].map((n) => n.textContent),
    tickRows: document.querySelectorAll(".map-timeline__row").length,
    readout: document.querySelector(".map-timeline__readout")?.textContent ?? null,
    docWidth: document.documentElement.scrollWidth,
    winWidth: window.innerWidth,
  };
});

const n = nextIndex();
const suffix = [wantPoint && "point", wantArea && "area", reduced && "reduced", mobile && "mobile"]
  .filter(Boolean)
  .join("-") + (wantStack ? "-stack" : "") + (wantZoom ? "-zoom" : "");
const file = join(OUT_DIR, `screenshot-${n}-${label}${suffix ? `-${suffix}` : ""}.png`);
await page.screenshot({ path: file });

console.log(JSON.stringify({ ready, file, ...report, errors }, null, 2));
await browser.close();
