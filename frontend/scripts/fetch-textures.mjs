/**
 * Download and prepare the globe basemap and its overlay layers.
 *
 * These are committed to `public/`, not fetched at runtime: context.md §10 already
 * established that the deployment target cannot depend on outside hosts, which is why the
 * coastline data was bundled too. This script exists so the assets are reproducible rather
 * than mysterious — the same arrangement as `backend/snapshot_fixtures.py`, which
 * regenerates the committed sample data in `data/`.
 *
 * The basemap source is NASA's Blue Marble Next Generation, *with topography and
 * bathymetry*. The "topo.bathy" part is the whole point: NASA bakes shaded relief into the
 * pixels, so one colour texture carries the visible mid-ocean ridges and the Greenland ice
 * dome without a separate elevation or normal map. (The matching GEBCO elevation raster is
 * published only at 21600×10800 / 17.6 MB, far too large to commit, and is not needed for
 * this.)
 *
 * Two overlay layers ship alongside it, sourced from the same NASA Earth Observatory family
 * (Reto Stöckli / Robert Simmon compositing, same public-domain terms), mirrored on
 * archive.org as direct JPEG downloads:
 *   - Clouds — the companion Blue Marble cloud composite. A luminance image: the globe
 *     shader samples it for both the white cloud tint and the alpha (see viz/globe.ts),
 *     so no real alpha channel is needed.
 *   - Night lights — the classic DMSP city-lights composite (data: Marc Imhoff/NASA GSFC,
 *     Christopher Elvidge/NOAA NGDC; image: Craig Mayhew/Robert Simmon, NASA GSFC).
 *
 * A third layer — a specular ocean/land mask — needs no download at all. No NASA-original
 * specular mask could be traced to a directly verifiable, attributable source (only
 * third-party repacked texture sites turned up, which don't meet this project's "real,
 * attributable source" bar), so it is derived procedurally from the basemap already on
 * disk: a blue-dominance threshold per pixel, computed in the same puppeteer canvas step
 * used for resampling.
 *
 * ## Why the basemap is resampled to 4096×2048, and the overlays to 2048×1024
 *
 * NASA publishes the basemap at 5400×2700, which is NOT a power of two. Uploaded with
 * mipmaps, that texture makes mip generation fail on some drivers — reproducibly under
 * SwiftShader, where it put the GL context into a state where three unrelated materials
 * (PointsMaterial, LineBasicMaterial, ShaderMaterial) all failed VALIDATE_STATUS and the
 * canvas rendered nothing at all. Dropping mipmaps silences it but is the wrong fix: ~900 px
 * of globe on screen against 5400 px of texture is 6:1 minification, which without mipmaps
 * aliases badly on real hardware.
 *
 * 4096×2048 is a power of two, so mip generation is exact halving. It is also still more
 * resolution than the globe can show — the visible hemisphere spans 180° of longitude
 * across roughly 900 px, about 5 px per degree, against 11 px per degree here — so this
 * costs no visible quality and saves about a third of the file size.
 *
 * The overlays are soft, glow-like layers (clouds, city lights, a specular mask), not
 * detail-critical imagery, so they resample to a smaller power-of-two size — 2048×1024 —
 * which still costs no visible quality against a globe that can show ~11 px/degree, and
 * measurably reduces the GPU memory this already-heavy scene carries.
 *
 * Two basemap months ship so a scenario can pick its own season; see BASEMAPS in
 * `backend/app/config.py`. Public domain, credit required: NASA Earth Observatory (and,
 * for night lights specifically, the fuller credit above).
 *
 *   node scripts/fetch-textures.mjs          # skip assets already present
 *   node scripts/fetch-textures.mjs --force  # rebuild everything
 *
 * Note this is NASA Earth Observatory / Visible Earth (eoimages.gsfc.nasa.gov, mirrored via
 * archive.org since Visible Earth's own browsable catalogue has since been consolidated
 * into science.nasa.gov), a different programme from the Scientific Visualization Studio
 * that context.md §5.5 says we study but do not redistribute.
 *
 * Resampling runs in headless Chrome via puppeteer, which the repo already uses for the
 * screenshot harness — chosen over adding an image-processing dependency for one resize.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Power of two, so mipmap generation is exact halving. See the note above. */
const BASEMAP_WIDTH = 4096;
const BASEMAP_HEIGHT = BASEMAP_WIDTH / 2;

/** Smaller than the basemap — these are soft overlay layers, not detail-critical imagery. */
const OVERLAY_WIDTH = 2048;
const OVERLAY_HEIGHT = OVERLAY_WIDTH / 2;

const OCEAN_MASK_FILE = `world.ocean-mask.${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}.jpg`;

const BASEMAPS = [
  {
    month: "October 2004",
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73826/world.topo.bathy.200410.3x5400x2700.jpg",
    file: `world.topo.bathy.200410.${BASEMAP_WIDTH}x${BASEMAP_HEIGHT}.jpg`,
    // The ocean mask is derived from this one basemap — geography doesn't change month to
    // month, so deriving it twice would be redundant work for an identical result.
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
  // A 404 page served as HTML with a 200 would otherwise be resampled into a texture that
  // decodes to nothing, and the failure would surface much later as a blank globe.
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
 * A grayscale ocean/land mask, derived from an already-resampled basemap image rather than
 * a separate download — see the file header for why no directly-attributable NASA specular
 * mask could be sourced. Ocean reads blue-dominant in the Blue Marble imagery; land (browns,
 * greens) and ice/cloud (near-equal RGB, bright) both fail that test. A soft ramp rather
 * than a hard cutoff, so a coastline doesn't produce a jagged specular edge in the shader.
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
    // Read back from disk rather than reusing the in-memory buffer, so this works whether
    // the basemap was just downloaded or already present and skipped above.
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
