/**
 * Download coastlines and national borders and pack them small.
 *
 * Bundled into public/ (committed) so the app doesn't depend on outside hosts.
 *
 *   node scripts/fetch-geography.mjs
 *
 * Two levels of detail: 110m for the world view, 50m once you zoom in. The output
 * isn't GeoJSON: each line is a flat [lon, lat, lon, lat, ...] array rounded to 3
 * decimals (~110 m), about a third of the size.
 *
 * Source: Natural Earth (nvkelso/natural-earth-vector), public domain.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const OUT = join(process.cwd(), "public");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const LEVELS = [
  {
    scale: "110m",
    coast: "ne_110m_coastline.geojson",
    borders: "ne_110m_admin_0_boundary_lines_land.geojson",
  },
  {
    scale: "50m",
    coast: "ne_50m_coastline.geojson",
    borders: "ne_50m_admin_0_boundary_lines_land.geojson",
  },
];

/** GeoJSON line geometries to flat, rounded coordinate arrays. */
function flatten(geojson) {
  const out = [];
  const push = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const flat = new Array(coords.length * 2);
    for (let i = 0; i < coords.length; i++) {
      flat[i * 2] = Math.round(coords[i][0] * 1000) / 1000;
      flat[i * 2 + 1] = Math.round(coords[i][1] * 1000) / 1000;
    }
    out.push(flat);
  };
  for (const feature of geojson.features ?? []) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === "LineString") push(g.coordinates);
    else if (g.type === "MultiLineString") g.coordinates.forEach(push);
    else if (g.type === "Polygon") g.coordinates.forEach(push);
    else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => p.forEach(push));
  }
  return out;
}

async function get(name) {
  const res = await fetch(NE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

for (const level of LEVELS) {
  const [coastRaw, bordersRaw] = await Promise.all([get(level.coast), get(level.borders)]);
  const payload = { coast: flatten(coastRaw), borders: flatten(bordersRaw) };
  const file = join(OUT, `geography-${level.scale}.json`);
  const text = JSON.stringify(payload);
  writeFileSync(file, text);

  const points = [...payload.coast, ...payload.borders].reduce((n, l) => n + l.length / 2, 0);
  console.log(
    `  geography-${level.scale}.json  ${(text.length / 1024).toFixed(0).padStart(5)} KB  ` +
      `${payload.coast.length} coast + ${payload.borders.length} border lines, ` +
      `${points.toLocaleString()} points`,
  );
}

console.log("\n  Natural Earth (public domain), via nvkelso/natural-earth-vector.");
