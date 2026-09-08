/**
 * The 2D map viewport.
 *
 * Three canvases and an SVG, separated by how often each redraws:
 *
 *   basemap   land silhouette          on data change
 *   data      the coloured layers      on data change or pan/zoom  (a blit)
 *   flow      streamline particles     every frame while animating
 *   overlay   graticule, extent, pin   React/SVG, so it stays keyboard-reachable
 *
 * They all sit inside `--z-viewport`. They are NOT a fourth chrome z-plane —
 * §5.1's three-plane rule governs the console (viewport / docked / floating),
 * and this is all one plane's internals.
 *
 * Pan and zoom never re-colour anything. The expensive step is rasterizing a
 * field into pixels, and that is keyed on the data, not on the camera; moving
 * the map is a `drawImage` of a bitmap that already exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type MapSliceMeta } from "../api/client";
import { rasterizeLandMask, rasterizeSlice, sampleAt, type SliceGrid } from "./raster";
import {
  formatLat,
  formatLon,
  graticuleStep,
  MapTransform,
  worldFitZoom,
  wrapLon,
  type Size,
} from "./projection";
import {
  drawGeography,
  loadGeography,
  scaleFor,
  type Geography,
  type GeographyScale,
} from "./geography";
import { ParticleField, type VectorField } from "./streamlines";
import { datasetOf, type MapAction, type MapState } from "./state";

/** The INCOIS analysis extent, drawn as a measured mark — the same treatment the
 *  globe gives it, so the two views agree about where our own data lives. */
const INCOIS_EXTENT = { latRange: [-29.5, 29.5], lonRange: [30.5, 119.5] } as const;

const TOKEN = {
  land: "#050B12",
  extent: "#4FE8C4",
  graticule: "rgba(234, 243, 241, 0.10)",
  label: "rgba(234, 243, 241, 0.45)",
  flow: "rgba(234, 243, 241, 0.55)",
  // Reference geography. Both are `foam` at low alpha, so they read as chrome
  // rather than as anything measured. The coast is the stronger of the two
  // because it is the edge of the data; a border is only a line on the land.
  coast: "rgba(234, 243, 241, 0.62)",
  // abyss at high alpha: separates the coast from the bright end of a ramp.
  coastCasing: "rgba(5, 11, 18, 0.78)",
  border: "rgba(234, 243, 241, 0.38)",
};

interface LayerRender {
  meta: MapSliceMeta;
  bitmap: HTMLCanvasElement;
  values: Float32Array;
  grid: SliceGrid;
}

interface Props {
  state: MapState;
  dispatch: (a: MapAction) => void;
  onMetas: (metas: Record<string, MapSliceMeta>) => void;
  onLoading: (loading: Record<string, boolean>) => void;
  onOpenColumn: (extent: { latRange: [number, number]; lonRange: [number, number] }) => void;
}

function toBitmap(image: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d")!.putImageData(image, 0, 0);
  return c;
}

/** Draw an equirectangular bitmap, repeating it across the antimeridian.
 *
 *  A global grid is a cylinder. Without the +/-360 copies, panning past the
 *  date line leaves a blank half-frame where the world continues. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  bitmap: HTMLCanvasElement,
  grid: SliceGrid,
  t: MapTransform,
  alpha: number,
): void {
  const west = grid.lon0 - grid.dlon / 2;
  const east = grid.lon0 + (grid.n_lon - 0.5) * grid.dlon;
  const south = grid.lat0 - grid.dlat / 2;
  const north = grid.lat0 + (grid.n_lat - 0.5) * grid.dlat;

  const yTop = t.latToY(north);
  const yBot = t.latToY(south);
  ctx.globalAlpha = alpha;
  for (const shift of [-360, 0, 360]) {
    const xL = t.lonToX(west + shift);
    const xR = t.lonToX(east + shift);
    // t.size is CSS pixels, matching xL/xR; ctx.canvas.width is device pixels.
    if (xR < -2 || xL > t.size.width + 2) continue;
    ctx.drawImage(bitmap, xL, yTop, xR - xL, yBot - yTop);
  }
  ctx.globalAlpha = 1;
}

export function MapView({ state, dispatch, onMetas, onLoading, onOpenColumn }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const basemapRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<HTMLCanvasElement>(null);
  const flowRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState<Size>({ width: 960, height: 600 });
  const [renders, setRenders] = useState<Record<string, LayerRender>>({});
  const [flowField, setFlowField] = useState<VectorField | null>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null);
  const [geo, setGeo] = useState<Geography | null>(null);
  const [geoScale, setGeoScale] = useState<GeographyScale>("110m");
  const particles = useRef(new ParticleField());
  const dragRef = useRef<{ x: number; y: number; moved: boolean; mode: "pan" | "area" } | null>(null);

  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const transform = useMemo(
    () => new MapTransform(state.viewport, size),
    [state.viewport, size],
  );

  // ---------------------------------------------------------------- sizing
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w > 0 && h > 0) setSize({ width: w, height: h });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Open at a world fit once the canvas has a real size.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.width < 2) return;
    fitted.current = true;
    dispatch({
      type: "viewport/set",
      viewport: { lonCentre: 0, latCentre: 0, zoom: worldFitZoom(size) },
    });
  }, [size, dispatch]);

  // --------------------------------------------------------- reference geography
  // Loaded by level of detail rather than all at once: 110m is all the world
  // view can resolve, and the 1.1 MB fine set is only worth its redraw cost
  // once you are zoomed in far enough to see the difference.
  const wantScale = scaleFor(transform.viewport.zoom, worldFitZoom(size));
  useEffect(() => {
    let cancelled = false;
    loadGeography(wantScale).then((loaded) => {
      if (cancelled || !loaded) return;
      setGeo(loaded);
      setGeoScale(wantScale);
      // Verification hook, same idea as window.__oceanScene for the 3D views.
      (window as unknown as Record<string, unknown>).__mapGeoScale = wantScale;
    });
    return () => {
      cancelled = true;
    };
  }, [wantScale]);

  // ------------------------------------------------------------ data fetch
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      const nextLoading: Record<string, boolean> = {};
      for (const layer of state.layers) nextLoading[layer.id] = true;
      onLoading(nextLoading);

      const out: Record<string, LayerRender> = {};
      const metas: Record<string, MapSliceMeta> = {};

      for (const layer of state.layers) {
        const info = datasetOf(state, layer);
        if (!info || !state.time) continue;
        // Skip a fetch the clock cannot satisfy rather than asking for nothing.
        const t = Date.parse(state.time);
        if (t < Date.parse(`${info.time_start}T00:00:00Z`) || t > Date.parse(`${info.time_end}T00:00:00Z`)) {
          continue;
        }
        const depth = info.depth_levels[layer.depthIndex];
        try {
          const meta = await api.mapSliceMeta(
            {
              dataset: info.id,
              time: state.time.slice(0, 10),
              ...(info.depth_levels.length > 0 && depth !== undefined ? { depth } : {}),
            },
            controller.signal,
          );
          const values = await api.mapSliceData(meta, controller.signal);
          if (cancelled) return;
          const grid: SliceGrid = meta.grid;
          const image = rasterizeSlice(values, grid, layer.range ?? meta.value_range, layer.colormap, {
            log: layer.log,
          });
          out[layer.id] = { meta, bitmap: toBitmap(image), values, grid };
          metas[layer.id] = meta;
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
        }
      }
      if (cancelled) return;
      setRenders(out);
      onMetas(metas);
      onLoading({});
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Deliberately keyed on what changes the DATA, not the camera: panning and
    // zooming must never trigger a refetch or a re-colour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.time,
    state.layers.map((l) => `${l.id}:${l.datasetId}:${l.depthIndex}:${l.log}:${l.colormap}`).join("|"),
    state.catalogue.length,
  ]);

  // -------------------------------------------------------- streamline data
  const flowLayer = state.layers.find((l) => l.visible && l.streamlines);
  const flowInfo = flowLayer ? datasetOf(state, flowLayer) : undefined;
  useEffect(() => {
    if (!flowLayer || !flowInfo?.has_vectors || !state.time) {
      setFlowField(null);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const depth = flowInfo.depth_levels[flowLayer.depthIndex];
        const field = await api.mapVectorData(
          {
            dataset: flowInfo.id,
            time: state.time.slice(0, 10),
            ...(depth !== undefined ? { depth } : {}),
            stride: 16,
          },
          controller.signal,
        );
        setFlowField({
          u: field.u,
          v: field.v,
          nLat: field.nLat,
          nLon: field.nLon,
          latRange: flowInfo.lat_range,
          lonRange: flowInfo.lon_range,
        });
      } catch {
        setFlowField(null);
      }
    })();
    return () => controller.abort();
  }, [flowLayer?.id, flowLayer?.depthIndex, flowInfo?.id, state.time]);

  useEffect(() => {
    particles.current.setField(flowField);
  }, [flowField]);

  // ------------------------------------------------------------- rendering
  const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return null;
      const w = Math.round(size.width * dpr);
      const h = Math.round(size.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    },
    [size, dpr],
  );

  // Basemap: land derived from the data's own gaps, per context.md §10.
  useEffect(() => {
    const ctx = prepare(basemapRef.current);
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);

    // The land mask is derived from a layer's own no-data gaps, so it exists
    // only when a layer has loaded. The coastlines are not: they are reference
    // geography, and a map with no layer yet still has to look like the Earth.
    // Returning early here left an empty grid with nothing on it, which read as
    // "the map is broken" rather than "no layer is selected".
    const first = state.layers.map((l) => renders[l.id]).find((r) => r !== undefined);
    if (first) {
      const mask = toBitmap(rasterizeLandMask(first.values, first.grid, [5, 11, 18]));
      ctx.imageSmoothingEnabled = false;
      drawGrid(ctx, mask, first.grid, transform, 1);
    }

    // Strokes on top of the mask, never instead of it. The fill is still the
    // data's own no-data mask, so nothing here can hide or invent an ocean cell.
    if (geo) {
      drawGeography(ctx, geo, transform, {
        coast: TOKEN.coast,
        coastCasing: TOKEN.coastCasing,
        border: TOKEN.border,
        coastWidth: 1.5,
        borderWidth: 1.25,
      });
    }
  }, [renders, transform, size, prepare, state.layers, geo, geoScale]);

  useEffect(() => {
    const ctx = prepare(dataRef.current);
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    // Nearest-neighbour on purpose: bilinear scaling interpolates BETWEEN LUT
    // entries and invents colours that are not in the cmocean ramp. Blocky at
    // low zoom is honest — it shows the real grid.
    ctx.imageSmoothingEnabled = false;
    // layers[0] is the top of the list, so it must be painted last.
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i]!;
      if (!layer.visible) continue;
      const r = renders[layer.id];
      if (!r) continue;
      drawGrid(ctx, r.bitmap, r.grid, transform, layer.opacity);
    }
  }, [renders, transform, size, prepare, state.layers]);

  // Flow: the only per-frame cost in the view.
  useEffect(() => {
    const canvas = flowRef.current;
    if (!canvas) return;
    let raf = 0;
    const tick = () => {
      // Sized through `prepare`, which compares BOTH axes. The old guard here
      // tested width alone, so a height-only resize — the timeline expanding, a
      // panel opening, the browser's own chrome appearing — left this canvas
      // with its previous backing-store height while its CSS box followed the
      // new one. The browser then stretched it, and the streamlines drifted off
      // the coastlines under them by whatever the height had changed by.
      const ctx = prepare(canvas);
      if (ctx) {
        particles.current.draw(ctx, transform, TOKEN.flow, reduced);
      }
      // Under reduced motion the traces are drawn once and left standing: the
      // paths carry direction, and only the animation is motion.
      if (!reduced) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [transform, prepare, reduced, flowField]);

  // -------------------------------------------------------------- pointers
  const pointToGeo = (e: { clientX: number; clientY: number }) => {
    const rect = hostRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { lat: transform.yToLat(y), lon: wrapLon(transform.xToLon(x)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const mode = state.tool === "area" ? "area" : "pan";
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false, mode };
    if (mode === "area") dispatch({ type: "area/begin", corner: pointToGeo(e) });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    setHover(pointToGeo(e));
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === "area") {
      dispatch({ type: "area/update", corner: pointToGeo(e) });
    } else if (drag.moved) {
      dispatch({ type: "viewport/set", viewport: transform.panBy(dx, dy).viewport });
      drag.x = e.clientX;
      drag.y = e.clientY;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === "area") {
      dispatch({ type: "area/commit" });
    } else if (!drag.moved && state.tool === "inspect") {
      dispatch({ type: "pin/set", point: pointToGeo(e) });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = hostRef.current!.getBoundingClientRect();
    const next = transform.zoomAbout(
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.deltaY < 0 ? 1.18 : 1 / 1.18,
    );
    dispatch({ type: "viewport/set", viewport: next.viewport });
  };

  // ---------------------------------------------------------- overlay maths
  const step = graticuleStep(transform.viewport.zoom);
  const bounds = transform.bounds();
  const lons: number[] = [];
  for (let l = Math.ceil(bounds.lonRange[0] / step) * step; l <= bounds.lonRange[1]; l += step) {
    lons.push(l);
  }
  const lats: number[] = [];
  for (let l = Math.ceil(bounds.latRange[0] / step) * step; l <= bounds.latRange[1]; l += step) {
    lats.push(l);
  }

  const extentBox = {
    x: transform.lonToXNearest(INCOIS_EXTENT.lonRange[0]),
    x2: transform.lonToXNearest(INCOIS_EXTENT.lonRange[1]),
    y: transform.latToY(INCOIS_EXTENT.latRange[1]),
    y2: transform.latToY(INCOIS_EXTENT.latRange[0]),
  };

  const pinXY = state.pin
    ? { x: transform.lonToXNearest(state.pin.lon), y: transform.latToY(state.pin.lat) }
    : null;

  const areaBox = state.area
    ? {
        x: Math.min(
          transform.lonToXNearest(state.area.lonRange[0]),
          transform.lonToXNearest(state.area.lonRange[1]),
        ),
        w: Math.abs(
          transform.lonToXNearest(state.area.lonRange[1]) -
            transform.lonToXNearest(state.area.lonRange[0]),
        ),
        y: Math.min(
          transform.latToY(state.area.latRange[0]),
          transform.latToY(state.area.latRange[1]),
        ),
        h: Math.abs(
          transform.latToY(state.area.latRange[1]) - transform.latToY(state.area.latRange[0]),
        ),
      }
    : null;

  const hoverValue = (() => {
    if (!hover) return null;
    const top = state.layers.find((l) => l.visible && renders[l.id]);
    if (!top) return null;
    const r = renders[top.id]!;
    const v = sampleAt(r.values, r.grid, hover.lat, hover.lon);
    return v === null ? null : { value: v, units: r.meta.units, label: r.meta.label };
  })();

  const areaSpan = state.area
    ? {
        lat: Math.abs(state.area.latRange[1] - state.area.latRange[0]),
        lon: Math.abs(state.area.lonRange[1] - state.area.lonRange[0]),
      }
    : null;

  const areaInsideIncois =
    state.area !== null &&
    state.area.latRange[0] < INCOIS_EXTENT.latRange[1] &&
    state.area.latRange[1] > INCOIS_EXTENT.latRange[0] &&
    state.area.lonRange[0] < INCOIS_EXTENT.lonRange[1] &&
    state.area.lonRange[1] > INCOIS_EXTENT.lonRange[0];

  return (
    <div
      ref={hostRef}
      className={`map${state.tool === "area" ? " map--area" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onWheel={onWheel}
    >
      <canvas ref={basemapRef} className="map__canvas" style={{ width: size.width, height: size.height }} />
      <canvas ref={dataRef} className="map__canvas" style={{ width: size.width, height: size.height }} />
      <canvas ref={flowRef} className="map__canvas" style={{ width: size.width, height: size.height }} />

      <svg className="map__overlay" width={size.width} height={size.height} aria-hidden="true">
        {/* Meridians converge at the poles; drawing them past 90 degrees would
            put a grid over space that is not on the Earth. */}
        {lons.map((lon) => (
          <line
            key={`x${lon}`}
            x1={transform.lonToXNearest(lon)}
            y1={Math.max(0, transform.latToY(90))}
            x2={transform.lonToXNearest(lon)}
            y2={Math.min(size.height, transform.latToY(-90))}
            stroke={TOKEN.graticule}
          />
        ))}
        {lats.map((lat) => (
          <line
            key={`y${lat}`}
            x1={0}
            y1={transform.latToY(lat)}
            x2={size.width}
            y2={transform.latToY(lat)}
            stroke={TOKEN.graticule}
          />
        ))}
        {lons.map((lon) => (
          <text
            key={`xl${lon}`}
            className="map__grid-label"
            x={transform.lonToXNearest(lon) + 4}
            y={14}
            fill={TOKEN.label}
          >
            {formatLon(lon, step)}
          </text>
        ))}
        {lats.map((lat) => (
          <text
            key={`yl${lat}`}
            className="map__grid-label"
            x={4}
            y={transform.latToY(lat) - 4}
            fill={TOKEN.label}
          >
            {formatLat(lat, step)}
          </text>
        ))}

        {/* The one measured mark on the map that is not a field. */}
        <rect
          x={extentBox.x}
          y={extentBox.y}
          width={extentBox.x2 - extentBox.x}
          height={extentBox.y2 - extentBox.y}
          fill="none"
          stroke={TOKEN.extent}
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.75}
        />
        <text
          className="map__extent-label"
          x={extentBox.x + 6}
          y={extentBox.y - 6}
          fill={TOKEN.extent}
        >
          INCOIS analysis
        </text>

        {areaBox ? (
          <rect
            x={areaBox.x}
            y={areaBox.y}
            width={areaBox.w}
            height={areaBox.h}
            fill="rgba(79, 232, 196, 0.10)"
            stroke={TOKEN.extent}
            strokeWidth={1}
          />
        ) : null}

        {pinXY ? (
          <>
            <line
              x1={pinXY.x}
              y1={pinXY.y}
              x2={pinXY.x + 26}
              y2={pinXY.y - 26}
              stroke={TOKEN.extent}
              strokeWidth={1}
            />
            <circle cx={pinXY.x} cy={pinXY.y} r={4} fill="none" stroke={TOKEN.extent} strokeWidth={1.5} />
            <circle cx={pinXY.x} cy={pinXY.y} r={1.5} fill={TOKEN.extent} />
          </>
        ) : null}
      </svg>

      <div className="map__hud">
        <span className="readout">
          {hover
            ? `${formatLat(hover.lat, 0.1)} ${formatLon(hover.lon, 0.1)}`
            : "Drag to pan · scroll to zoom"}
          {hoverValue ? ` · ${hoverValue.label} ${hoverValue.value.toFixed(2)} ${hoverValue.units}` : ""}
        </span>
      </div>

      {state.area && !state.area.dragging && areaSpan ? (
        <div className="map__area-action">
          <p className="readout">
            {areaSpan.lat.toFixed(1)}° × {areaSpan.lon.toFixed(1)}°
          </p>
          {areaInsideIncois ? (
            <button
              type="button"
              onClick={() =>
                onOpenColumn({ latRange: state.area!.latRange, lonRange: state.area!.lonRange })
              }
            >
              Open in 3D
            </button>
          ) : (
            <p className="map__area-warn">
              No INCOIS analysis here — the water column covers 30.5–119.5°E, 29.5°S–29.5°N.
            </p>
          )}
          <button type="button" onClick={() => dispatch({ type: "area/clear" })}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
