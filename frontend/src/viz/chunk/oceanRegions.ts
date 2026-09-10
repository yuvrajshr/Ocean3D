/**
 * Named ocean regions mapped to coordinate bounding boxes.
 *
 * The chunk view snaps every click to a 5°×5° tile. This module resolves that
 * tile's centre to a human-readable region name — "Bay of Bengal" rather than
 * "10°N–15°N, 85°E–90°E".
 *
 * Regions are ordered most-specific-first so that a tile in the Andaman Sea is
 * not swallowed by the broader "Bay of Bengal" or "North Indian Ocean" entries.
 * The first match wins.
 */

import type { Bbox } from "./loader";

interface OceanRegion {
  name: string;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

/**
 * Ordered most-specific → least-specific.  The lookup returns the first region
 * whose box contains the tile centre, so narrow seas must come before the ocean
 * basin they sit inside.
 */
const REGIONS: OceanRegion[] = [
  // ---- Narrow seas & gulfs (most specific) ----
  { name: "Gulf of Aden",         lonMin:  43, lonMax:  51, latMin:  11, latMax:  15 },
  { name: "Gulf of Oman",         lonMin:  56, lonMax:  62, latMin:  22, latMax:  27 },
  { name: "Persian Gulf",         lonMin:  48, lonMax:  57, latMin:  24, latMax:  31 },
  { name: "Red Sea",              lonMin:  32, lonMax:  44, latMin:  12, latMax:  30 },
  { name: "Laccadive Sea",        lonMin:  70, lonMax:  77, latMin:   8, latMax:  14 },
  { name: "Strait of Malacca",    lonMin:  98, lonMax: 105, latMin:   0, latMax:   8 },
  { name: "Andaman Sea",          lonMin:  92, lonMax: 100, latMin:   5, latMax:  18 },

  // ---- Medium basins ----
  { name: "Arabian Sea",          lonMin:  50, lonMax:  77, latMin:   5, latMax:  25 },
  { name: "Bay of Bengal",        lonMin:  77, lonMax: 100, latMin:   5, latMax:  23 },
  { name: "South China Sea",      lonMin: 100, lonMax: 121, latMin:   0, latMax:  23 },
  { name: "Java Sea",             lonMin: 105, lonMax: 120, latMin:  -8, latMax:  -3 },
  { name: "Mozambique Channel",   lonMin:  35, lonMax:  50, latMin: -25, latMax: -10 },
  { name: "East China Sea",       lonMin: 120, lonMax: 132, latMin:  24, latMax:  33 },
  { name: "Sea of Japan",         lonMin: 128, lonMax: 142, latMin:  33, latMax:  52 },
  { name: "Mediterranean Sea",    lonMin:  -6, lonMax:  36, latMin:  30, latMax:  46 },
  { name: "Caribbean Sea",        lonMin: -89, lonMax: -60, latMin:   9, latMax:  22 },
  { name: "Gulf of Mexico",       lonMin: -98, lonMax: -81, latMin:  18, latMax:  31 },
  { name: "Coral Sea",            lonMin: 143, lonMax: 170, latMin: -24, latMax:  -8 },
  { name: "Tasman Sea",           lonMin: 150, lonMax: 175, latMin: -47, latMax: -24 },
  { name: "Philippine Sea",       lonMin: 120, lonMax: 140, latMin:   5, latMax:  24 },

  // ---- Broad ocean basins (least specific) ----
  { name: "Equatorial Indian Ocean", lonMin:  40, lonMax: 100, latMin: -10, latMax:   5 },
  { name: "North Indian Ocean",      lonMin:  40, lonMax: 100, latMin:   5, latMax:  25 },
  { name: "South Indian Ocean",      lonMin:  20, lonMax: 120, latMin: -60, latMax: -10 },
  { name: "North Pacific Ocean",     lonMin: 100, lonMax: 180, latMin:   0, latMax:  60 },
  { name: "South Pacific Ocean",     lonMin: 100, lonMax: 180, latMin: -60, latMax:   0 },
  { name: "NE Pacific Ocean",        lonMin:-180, lonMax:-100, latMin:   0, latMax:  60 },
  { name: "SE Pacific Ocean",        lonMin:-180, lonMax: -70, latMin: -60, latMax:   0 },
  { name: "North Atlantic Ocean",    lonMin: -80, lonMax:   0, latMin:   0, latMax:  60 },
  { name: "South Atlantic Ocean",    lonMin: -70, lonMax:  20, latMin: -60, latMax:   0 },
  { name: "Southern Ocean",          lonMin:-180, lonMax: 180, latMin: -90, latMax: -60 },
  { name: "Arctic Ocean",            lonMin:-180, lonMax: 180, latMin:  60, latMax:  90 },
];

/**
 * Resolve a 5°×5° tile bbox to a human-readable ocean region name.
 *
 * Uses the tile's centre point and returns the first matching region.
 * Falls back to the raw coordinate extent string so the breadcrumb is never blank.
 */
export function resolveRegionName(bbox: Bbox): string {
  const centLon = (bbox[0] + bbox[2]) / 2;
  const centLat = (bbox[1] + bbox[3]) / 2;

  for (const r of REGIONS) {
    if (
      centLon >= r.lonMin &&
      centLon <= r.lonMax &&
      centLat >= r.latMin &&
      centLat <= r.latMax
    ) {
      return r.name;
    }
  }

  // Fallback: raw extent — always computable, never blank.
  return `${bbox[1]}°N–${bbox[3]}°N, ${bbox[0]}°E–${bbox[2]}°E`;
}
