/**
 * Tests for the pure half of the map renderer.
 *
 * These target the bugs that would otherwise ship looking plausible: an ocean
 * drawn upside down, a feature that vanishes across the antimeridian, and a
 * diverging colour scale that disagrees with the 3D view of the same value.
 */

import { describe, expect, it } from "vitest";

import { buildLut, encodeRange, lutIndex, LUT_SIZE } from "../viz/colormaps";
import {
  clampViewport,
  formatLat,
  formatLon,
  graticuleStep,
  MapTransform,
  worldFitZoom,
  wrapLon,
} from "./projection";
import { rasterizeLandMaskBytes, rasterizeSliceBytes, sampleAt, type SliceGrid } from "./raster";

const SIZE = { width: 1200, height: 700 };

describe("projection", () => {
  it("round-trips longitude and latitude through pixels", () => {
    const t = new MapTransform({ lonCentre: 20, latCentre: -10, zoom: 4 }, SIZE);
    for (const lon of [-179, -90, 0, 45, 178]) {
      expect(t.xToLon(t.lonToX(lon))).toBeCloseTo(lon, 9);
    }
    for (const lat of [-80, -30, 0, 25, 60]) {
      expect(t.yToLat(t.latToY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it("puts north at the top", () => {
    const t = new MapTransform({ lonCentre: 0, latCentre: 0, zoom: 3 }, SIZE);
    expect(t.latToY(40)).toBeLessThan(t.latToY(-40));
  });

  it("finds the nearest copy of a longitude across the antimeridian", () => {
    // Zoomed right in, because `clampViewport` no longer lets the centre sit at
    // 179 from far out: it stops at 180 - halfLon. At this zoom halfLon is 1
    // degree, so 179 survives the clamp and the case stays reachable.
    //
    // The method is still needed even though the VIEWPORT can no longer straddle
    // the date line: a streamline advecting past 180 re-enters at -180, and
    // without this it would draw one segment straight across the whole frame.
    const ZOOM = 600;
    const t = new MapTransform({ lonCentre: 179, latCentre: 0, zoom: ZOOM }, SIZE);
    expect(t.viewport.lonCentre).toBeCloseTo(179, 9);
    // 179E and 179W are two degrees apart, not 358.
    const near = t.lonToXNearest(-179);
    expect(Math.abs(near - SIZE.width / 2)).toBeCloseTo(2 * ZOOM, 6);
    // The naive form is the one that would push it off screen.
    expect(Math.abs(t.lonToX(-179) - SIZE.width / 2)).toBeCloseTo(358 * ZOOM, 6);
  });

  it("wraps longitude into [-180, 180)", () => {
    expect(wrapLon(190)).toBeCloseTo(-170, 9);
    expect(wrapLon(-190)).toBeCloseTo(170, 9);
    expect(wrapLon(540)).toBeCloseTo(180 - 360, 9);
    expect(wrapLon(0)).toBe(0);
  });

  it("covers the frame at minimum zoom, leaving no empty band on any aspect", () => {
    // `min` used to fit the world INSIDE the canvas, which was only safe while
    // longitude wrapped and the repeats filled the leftover width.
    for (const size of [SIZE, { width: 1918, height: 860 }, { width: 900, height: 1200 }]) {
      const z = worldFitZoom(size);
      expect(360 * z).toBeGreaterThanOrEqual(size.width - 1e-9);
      expect(180 * z).toBeGreaterThanOrEqual(size.height - 1e-9);
    }
  });

  it("clamps longitude to the world instead of scrolling past the date line", () => {
    const min = worldFitZoom(SIZE);
    for (const zoom of [min, min * 2, min * 8]) {
      for (const lonCentre of [-900, -181, 0, 181, 900]) {
        const t = new MapTransform(clampViewport({ lonCentre, latCentre: 0, zoom }, SIZE), SIZE);
        const [west, east] = t.bounds().lonRange;
        expect(west).toBeGreaterThanOrEqual(-180 - 1e-9);
        expect(east).toBeLessThanOrEqual(180 + 1e-9);
      }
    }
  });

  it("never zooms out past a world fit, and keeps the poles at the frame edge", () => {
    const min = worldFitZoom(SIZE);
    const v = clampViewport({ lonCentre: 0, latCentre: 85, zoom: min / 10 }, SIZE);
    expect(v.zoom).toBeCloseTo(min, 9);
    // At world-fit the whole latitude range is visible, so it must stay centred
    // rather than drifting to leave empty space above the pole.
    expect(v.latCentre).toBe(0);
  });

  it("holds the point under the cursor fixed while zooming", () => {
    const t = new MapTransform({ lonCentre: 10, latCentre: 5, zoom: 6 }, SIZE);
    const x = 300;
    const y = 200;
    const lon = t.xToLon(x);
    const lat = t.yToLat(y);
    const zoomed = t.zoomAbout(x, y, 2);
    expect(zoomed.xToLon(x)).toBeCloseTo(lon, 6);
    expect(zoomed.yToLat(y)).toBeCloseTo(lat, 6);
  });

  it("steps the graticule at round intervals rather than sliding", () => {
    const steps = [0.05, 0.5, 2, 8, 30].map((z) => graticuleStep(z));
    for (const s of steps) {
      expect([30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1]).toContain(s);
    }
    // Zooming in never coarsens the grid.
    expect(graticuleStep(20)).toBeLessThanOrEqual(graticuleStep(1));
  });

  it("labels degrees the way a chart does", () => {
    expect(formatLat(0)).toBe("0°");
    expect(formatLat(23)).toBe("23°N");
    expect(formatLat(-23)).toBe("23°S");
    expect(formatLon(88)).toBe("88°E");
    expect(formatLon(-88)).toBe("88°W");
    expect(formatLon(180)).toBe("180°");
    expect(formatLon(-180)).toBe("180°");
  });
});

// A 3x4 grid, latitude ascending: row 0 is the SOUTHERNMOST.
const grid: SliceGrid = { lat0: -10, dlat: 10, n_lat: 3, lon0: 0, dlon: 10, n_lon: 4 };

describe("raster", () => {
  it("draws north at the top: the last data row becomes the first image row", () => {
    // Southern row all 0, northern row all 100.
    const values = new Float32Array([
      0, 0, 0, 0, //
      50, 50, 50, 50, //
      100, 100, 100, 100,
    ]);
    const px = rasterizeSliceBytes(values, grid, [0, 100], "thermal");
    const lut = buildLut("thermal");
    const topPixel = [px[0], px[1], px[2]];
    const bottomPixel = [px[(2 * 4 + 0) * 4], px[(2 * 4 + 0) * 4 + 1], px[(2 * 4 + 0) * 4 + 2]];
    // Top of the image is the value 100 row (north), bottom is the value 0 row.
    expect(topPixel).toEqual([lut[(LUT_SIZE - 1) * 3], lut[(LUT_SIZE - 1) * 3 + 1], lut[(LUT_SIZE - 1) * 3 + 2]]);
    expect(bottomPixel).toEqual([lut[0], lut[1], lut[2]]);
  });

  it("makes no-data fully transparent and never a colour", () => {
    const values = new Float32Array(12).fill(NaN);
    const px = rasterizeSliceBytes(values, grid, [0, 1], "thermal");
    for (let i = 0; i < 12; i++) {
      expect(px[i * 4 + 3]).toBe(0);
    }
  });

  it("maps the range endpoints to the ends of the ramp", () => {
    const values = new Float32Array(12).fill(5);
    values[0] = 0;
    values[11] = 10;
    const px = rasterizeSliceBytes(values, grid, [0, 10], "haline");
    const lut = buildLut("haline");
    // values[0] is the south-west cell, which lands in the LAST image row.
    const swOffset = (2 * 4 + 0) * 4;
    expect([px[swOffset], px[swOffset + 1], px[swOffset + 2]]).toEqual([lut[0], lut[1], lut[2]]);
  });

  it("centres a diverging map exactly as the 3D volume does", () => {
    // The whole point of sharing encodeRange: the same value must be the same
    // colour in the map and in the water column.
    const range: [number, number] = [-2, 8];
    const encoded = encodeRange(range, "delta");
    expect(encoded).toEqual([-8, 8]);
    // Zero sits at the middle of the ramp, not off to one side.
    const mid = lutIndex(0, encoded);
    expect(Math.abs(mid - (LUT_SIZE - 1) / 2)).toBeLessThanOrEqual(1);
    // And a sequential map is left alone.
    expect(encodeRange(range, "thermal")).toEqual(range);
  });

  it("applies opacity to data but never to no-data", () => {
    const values = new Float32Array(12).fill(1);
    values[5] = NaN;
    const px = rasterizeSliceBytes(values, grid, [0, 2], "algae", { opacity: 0.5 });
    const alphas = new Set<number>();
    for (let i = 0; i < 12; i++) alphas.add(px[i * 4 + 3]!);
    expect(alphas.has(0)).toBe(true); // the NaN cell
    expect(alphas.has(128)).toBe(true); // everything else
  });

  it("rejects a payload that does not match its declared grid", () => {
    expect(() => rasterizeSliceBytes(new Float32Array(11), grid, [0, 1], "thermal")).toThrow();
  });

  it("draws the land mask from the data's own gaps", () => {
    const values = new Float32Array(12).fill(1);
    values[0] = NaN;
    const px = rasterizeLandMaskBytes(values, grid, [5, 11, 18]);
    const swOffset = (2 * 4 + 0) * 4;
    expect(px[swOffset + 3]).toBe(255); // land is opaque
    expect(px[3]).toBe(0); // ocean is clear
  });
});

describe("sampleAt", () => {
  const values = new Float32Array([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);

  it("reads the nearest cell", () => {
    expect(sampleAt(values, grid, -10, 0)).toBe(0);
    expect(sampleAt(values, grid, 10, 30)).toBe(23);
    expect(sampleAt(values, grid, 9, 21)).toBe(22); // nearest, not floor
  });

  it("returns null off the grid and for no-data", () => {
    expect(sampleAt(values, grid, 80, 0)).toBeNull();
    const holed = Float32Array.from(values);
    holed[0] = NaN;
    expect(sampleAt(holed, grid, -10, 0)).toBeNull();
  });

  it("wraps longitude only on a global grid", () => {
    const global: SliceGrid = { lat0: -10, dlat: 10, n_lat: 3, lon0: -180, dlon: 90, n_lon: 4 };
    const g = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // 190E is the same meridian as 170W, which is the first column.
    expect(sampleAt(g, global, -10, 190)).toBe(sampleAt(g, global, -10, -170));
  });
});
