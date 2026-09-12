/**
 * Download and prepare the globe basemap and its overlay layers.
 *
 * The results are committed to public/ so the app doesn't depend on outside hosts;
 * this script just makes them reproducible (like backend/snapshot_fixtures.py
 * for the sample data).
 *
 * Basemap: NASA Blue Marble Next Generation with topography and bathymetry. The
 * relief is baked into the image, so no separate elevation or normal map is needed.
 *
 * Overlays, from the same NASA Earth Observatory family (Reto Stöckli / Robert
 * Simmon), mirrored on archive.org:
 *   - Clouds: a luminance image; the globe shader uses it for both colour and
 *     alpha (see viz/globe.ts).
 *   - Night lights: DMSP city lights (data: Marc Imhoff/NASA GSFC, Christopher
 *     Elvidge/NOAA NGDC; image: Craig Mayhew/Robert Simmon, NASA GSFC).
 *
 * The specular ocean/land mask isn't downloaded. We couldn't find an original,
 * attributable NASA version, so it's generated from the basemap (blue-dominant
 * pixels = ocean) in the same puppeteer step used for resizing.
 *
 * Sizes: NASA's basemap is 5400×2700, which isn't a power of two, and mipmapping
 * it broke the WebGL context on some drivers (the canvas went blank). 4096×2048 is
 * a power of two and still more detail than the globe can show (~5 px/degree on
 * screen vs 11 here). Overlays are soft, so 2048×1024 is enough.
 *
 * Two basemap months are included so a scenario can match its season (see
 * backend/app/config.py). Public domain; credit NASA Earth Observatory (plus the
 * night-lights credit above).
 *
 *   node scripts/fetch-textures.mjs          # skip files already present
 *   node scripts/fetch-textures.mjs --force  # rebuild everything
 *
 * Resizing runs in headless Chrome via puppeteer, so there's no extra image library.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Power of two, so mipmaps halve exactly. */
const BASEMAP_WIDTH = 4096;
const BASEMAP_HEIGHT = BASEMAP_WIDTH / 2;

/** Smaller than the basemap, since these overlays are soft. */
const OVERLAY_WIDTH = 2048;
const OVERLAY_HEIGHT = OVERLAY_WIDTH / 2;

const OCEAN_MASK_FILE = `world.ocean-mask.${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}.jpg`;

const BASEMAPS = [
  {
    month: "October 2004",
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73826/world.topo.bathy.200410.3x5400x2700.jpg",
    file: `world.topo.bathy.200410.${BASEMAP_WIDTH}x${BASEMAP_HEIGHT}.jpg`,
    // Only generate the ocean mask from one basemap; geography doesn't change by month.
    deriveOceanMask: true,
  },
  {
    month: "December 2004",
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg",
    file: `world.topo.bathy.200412.${BASEMAP_WIDTH}x${BASEMAP_HEIGHT}.jpg`,
    deriveOceanMask: false,
  },
];

const OVERLAYS = [
  {
    label: "clouds",
    url: "https://archive.org/download/VE-IMG-2432/cloud_combined_2048.jpg",
    file: `world.clouds.${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}.jpg`,
    credit: "NASA Earth Observatory (Blue Marble cloud composite)",
  },
  {
    label: "night lights",
    url: "https://archive.org/download/earth_lights/earth_lights_lrg.jpg",
    file: `world.night-lights.${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}.jpg`,
    credit:
      "Data: Marc Imhoff (NASA GSFC), Christopher Elvidge (NOAA NGDC). " +
      "Image: Craig Mayhew, Robert Simmon (NASA GSFC).",
  },
];

const force = process.argv.includes("--force");
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

async function existingSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function download(label, url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  // Otherwise an HTML 404 page with status 200 would get turned into a blank texture.
  if (!type.startsWith("image/")) throw new Error(`expected an image, got ${type}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`  got   ${label}  ${mb(bytes.length)} at source`);
  return bytes;
}

async function resample(page, bytes, width, height) {
  const dataUrl = await page.evaluate(
    async (b64, W, H) => {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + b64;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, W, H);
      return canvas.toDataURL("image/jpeg", 0.92);
    },
    bytes.toString("base64"),
    width,
    height,
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/**
 * Grayscale ocean/land mask generated from the resized basemap. Ocean is blue
 * dominant in Blue Marble; land and ice aren't. Uses a soft ramp so coastlines
 * don't get a jagged specular edge.
 */
async function deriveOceanMask(page, basemapBytes, width, height) {
  const dataUrl = await page.evaluate(
    async (b64, W, H) => {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + b64;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, W, H);

      const image = ctx.getImageData(0, 0, W, H);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const blueness = Math.max(0, Math.min(1, (b - Math.max(r, g * 0.85)) / 40));
        const v = Math.round(blueness * 255);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.9);
    },
    basemapBytes.toString("base64"),
    width,
    height,
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

console.log(`Globe textures → ${PUBLIC_DIR}`);
await mkdir(PUBLIC_DIR, { recursive: true });

let failed = 0;
let oceanMaskSourceBytes = null;

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("about:blank");

for (const basemap of BASEMAPS) {
  const path = join(PUBLIC_DIR, basemap.file);
  const already = await existingSize(path);
  const needsFetch = already === null || force;

  if (needsFetch) {
    try {
      const original = await download(basemap.month, basemap.url);
      const resized = await resample(page, original, BASEMAP_WIDTH, BASEMAP_HEIGHT);
      await writeFile(path, resized);
      console.log(`  wrote ${basemap.file}  ${BASEMAP_WIDTH}×${BASEMAP_HEIGHT}  ${mb(resized.length)}`);
    } catch (error) {
      console.error(`  FAIL  ${basemap.file}  ${error.message}`);
      failed++;
      continue;
    }
  } else {
    console.log(`  skip  ${basemap.file}  (${mb(already)} already present)`);
  }

  if (basemap.deriveOceanMask) {
    // Read from disk so this works whether the basemap was just downloaded or skipped.
    oceanMaskSourceBytes = await readFile(path);
  }
}

for (const overlay of OVERLAYS) {
  const path = join(PUBLIC_DIR, overlay.file);
  const already = await existingSize(path);
  if (already !== null && !force) {
    console.log(`  skip  ${overlay.file}  (${mb(already)} already present)`);
    continue;
  }
  try {
    const original = await download(overlay.label, overlay.url);
    const resized = await resample(page, original, OVERLAY_WIDTH, OVERLAY_HEIGHT);
    await writeFile(path, resized);
    console.log(`  wrote ${overlay.file}  ${OVERLAY_WIDTH}×${OVERLAY_HEIGHT}  ${mb(resized.length)}`);
  } catch (error) {
    console.error(`  FAIL  ${overlay.file}  ${error.message}`);
    failed++;
  }
}

const oceanMaskPath = join(PUBLIC_DIR, OCEAN_MASK_FILE);
const oceanMaskAlready = await existingSize(oceanMaskPath);
if (oceanMaskAlready !== null && !force) {
  console.log(`  skip  ${OCEAN_MASK_FILE}  (${mb(oceanMaskAlready)} already present)`);
} else if (oceanMaskSourceBytes) {
  try {
    const mask = await deriveOceanMask(page, oceanMaskSourceBytes, OVERLAY_WIDTH, OVERLAY_HEIGHT);
    await writeFile(oceanMaskPath, mask);
    console.log(`  wrote ${OCEAN_MASK_FILE}  ${OVERLAY_WIDTH}×${OVERLAY_HEIGHT}  ${mb(mask.length)}  (derived, not downloaded)`);
  } catch (error) {
    console.error(`  FAIL  ${OCEAN_MASK_FILE}  ${error.message}`);
    failed++;
  }
} else {
  console.error(`  FAIL  ${OCEAN_MASK_FILE}  no basemap available to derive it from`);
  failed++;
}

await browser.close();

if (failed === 0) {
  console.log("Done. Imagery courtesy NASA Earth Observatory (Blue Marble Next Generation).");
  console.log("Night lights: " + OVERLAYS[1].credit);
} else {
  console.error("\nOne or more assets failed. The globe falls back gracefully for each —");
  console.error("a plain sphere for the basemap, no clouds/lights/glint for the overlays —");
  console.error("but re-run this before demoing.");
  process.exitCode = 1;
}
