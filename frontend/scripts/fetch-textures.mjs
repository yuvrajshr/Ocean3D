/**
 * Download and prepare the globe basemaps.
 *
 * These are committed to `public/`, not fetched at runtime: context.md §10 already
 * established that the deployment target cannot depend on outside hosts, which is why the
 * coastline data was bundled too. This script exists so the assets are reproducible rather
 * than mysterious — the same arrangement as `backend/snapshot_fixtures.py`, which
 * regenerates the committed sample data in `data/`.
 *
 * The source is NASA's Blue Marble Next Generation, *with topography and bathymetry*. The
 * "topo.bathy" part is the whole point: NASA bakes shaded relief into the pixels, so one
 * colour texture carries the visible mid-ocean ridges and the Greenland ice dome without a
 * separate elevation or normal map. (The matching GEBCO elevation raster is published only
 * at 21600×10800 / 17.6 MB, far too large to commit, and is not needed for this.)
 *
 * ## Why the originals are resampled to 4096×2048
 *
 * NASA publishes these at 5400×2700, which is NOT a power of two. Uploaded with mipmaps,
 * that texture makes mip generation fail on some drivers — reproducibly under SwiftShader,
 * where it put the GL context into a state where three unrelated materials (PointsMaterial,
 * LineBasicMaterial, ShaderMaterial) all failed VALIDATE_STATUS and the canvas rendered
 * nothing at all. Dropping mipmaps silences it but is the wrong fix: ~900 px of globe on
 * screen against 5400 px of texture is 6:1 minification, which without mipmaps aliases
 * badly on real hardware.
 *
 * 4096×2048 is a power of two, so mip generation is exact halving. It is also still more
 * resolution than the globe can show — the visible hemisphere spans 180° of longitude
 * across roughly 900 px, about 5 px per degree, against 11 px per degree here — so this
 * costs no visible quality and saves about a third of the file size.
 *
 * Two months ship so a scenario can pick its own season; see BASEMAPS in
 * `backend/app/config.py`. Public domain, credit required: NASA Earth Observatory.
 *
 *   node scripts/fetch-textures.mjs          # skip basemaps already present
 *   node scripts/fetch-textures.mjs --force  # rebuild everything
 *
 * Note this is NASA Earth Observatory / Visible Earth (eoimages.gsfc.nasa.gov), a
 * different programme from the Scientific Visualization Studio that context.md §5.5 says
 * we study but do not redistribute.
 *
 * Resampling runs in headless Chrome via puppeteer, which the repo already uses for the
 * screenshot harness — chosen over adding an image-processing dependency for one resize.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Power of two, so mipmap generation is exact halving. See the note above. */
const WIDTH = 4096;
const HEIGHT = WIDTH / 2;

const BASEMAPS = [
  {
    month: "October 2004",
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73826/world.topo.bathy.200410.3x5400x2700.jpg",
    file: `world.topo.bathy.200410.${WIDTH}x${HEIGHT}.jpg`,
  },
  {
    month: "December 2004",
    url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg",
    file: `world.topo.bathy.200412.${WIDTH}x${HEIGHT}.jpg`,
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

async function download({ month, url, file }) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  // A 404 page served as HTML with a 200 would otherwise be resampled into a texture that
  // decodes to nothing, and the failure would surface much later as a blank globe.
  if (!type.startsWith("image/")) throw new Error(`expected an image, got ${type}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`  got   ${month}  ${mb(bytes.length)} at source`);
  return bytes;
}

async function resample(page, bytes) {
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
    WIDTH,
    HEIGHT,
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

console.log(`Blue Marble basemaps → ${PUBLIC_DIR}`);
await mkdir(PUBLIC_DIR, { recursive: true });

const pending = [];
for (const basemap of BASEMAPS) {
  const already = await existingSize(join(PUBLIC_DIR, basemap.file));
  if (already !== null && !force) {
    console.log(`  skip  ${basemap.file}  (${mb(already)} already present)`);
  } else {
    pending.push(basemap);
  }
}

let failed = 0;
if (pending.length > 0) {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("about:blank");

  for (const basemap of pending) {
    try {
      const original = await download(basemap);
      const resized = await resample(page, original);
      await writeFile(join(PUBLIC_DIR, basemap.file), resized);
      console.log(`  wrote ${basemap.file}  ${WIDTH}×${HEIGHT}  ${mb(resized.length)}`);
    } catch (error) {
      console.error(`  FAIL  ${basemap.file}  ${error.message}`);
      failed++;
    }
  }
  await browser.close();
}

if (failed === 0) {
  console.log("Done. Imagery courtesy NASA Earth Observatory (Blue Marble Next Generation).");
} else {
  console.error("\nOne or more basemaps failed. The globe falls back to an untextured");
  console.error("sphere, so the app still runs — but re-run this before demoing.");
  process.exitCode = 1;
}
