/**
 * Download coastlines and national borders, and pack them small.
 *
 * Bundled into `public/` rather than fetched at runtime, for the same reason the
 * Blue Marble basemaps are: the deployment target cannot depend on outside
 * hosts. Run once; the output is committed.
 *
 *   node scripts/fetch-geography.mjs
 *
 * Two levels of detail. 110m is what the world view can actually resolve; 50m
 * is loaded only once you zoom past the point where 110m turns visibly angular.
 * Shipping only the fine one would mean drawing far more segments than the
 * screen can show on every pan.
 *
 * The output is NOT GeoJSON. Each line becomes a flat [lon, lat, lon, lat, ...]
 * array with coordinates rounded to 3 decimals (~110 m, far finer than either
 * source), which drops the file to roughly a third of the GeoJSON size and needs
 * no parsing beyond JSON.parse.
 *
 * Source: Natural Earth via nvkelso/natural-earth-vector. Public domain.
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

/** GeoJSON line geometries → flat coordinate arrays, rounded. */
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
