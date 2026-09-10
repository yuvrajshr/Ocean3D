/**
 * What one point measures: values, a depth profile, a time series, and a
 * depth-time section.
 *
 * All four are views of a single (depth x time) block from one request — values
 * are one cell, the profile a column, the series a row, and the section the
 * whole thing. That is why there is one endpoint rather than four.
 *
 * Charts are hand-written SVG, matching `components/ProfilePanel.tsx`, which
 * says why in its own header: the depth axis has to agree exactly with
 * `viz/depth.ts`, and no charting library will do that for us.
 *
 * The profile and section sections do not render for a surface field. That falls
 * out of the data (one depth level) rather than being special-cased, which is
 * the behaviour context.md §10 requires.
 */

import { useState, useMemo } from "react";

import type { MapPointBlock } from "../api/client";
import { encodeRange, sampleCss } from "../viz/colormaps";
import { depthToNorm } from "../viz/depth";

const W = 330;
const H_SERIES = 92;
const H_PROFILE = 150;
const H_SECTION = 118;
const PAD_L = 40;
const PAD_R = 10;

interface Props {
  block: MapPointBlock | null;
  loading: boolean;
  error: string | null;
  /** The index into `block.depths` the map is currently slicing. */
  depthIndex: number;
  /** The index into `block.times` nearest the map's clock. */
  timeIndex: number;
  onClose: () => void;
  onLoadSection: () => void;
  sectionLoaded: boolean;
  sectionLoading: boolean;
}

/** Depth levels arrive at full float precision; a readout prints what a reader
 *  can use. Same rule as the depth ruler and the layer housing. */
function fmtDepth(d: number): string {
  if (d >= 100) return d.toFixed(0);
  if (d >= 10) return d.toFixed(1);
  return d.toFixed(2).replace(/\.?0+$/, "");
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

function stats(values: (number | null)[]) {
  const f = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (f.length === 0) return null;
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  return { mean, min: Math.min(...f), max: Math.max(...f) };
}

export function PointReadout({
  block,
  loading,
  error,
  depthIndex,
  timeIndex,
  onClose,
  onLoadSection,
  sectionLoaded,
  sectionLoading,
}: Props) {
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  const derived = useMemo(() => {
    if (!block) return null;
    const nD = block.depths.length;
    const nT = block.times.length;
    const at = (d: number, t: number) => block.values[d * nT + t] ?? null;

    const t = Math.max(0, Math.min(nT - 1, timeIndex));
    const d = Math.max(0, Math.min(nD - 1, depthIndex));
    return {
      nD,
      nT,
      at,
      value: at(d, t),
      profile: Array.from({ length: nD }, (_, i) => at(i, t)),
      series: Array.from({ length: nT }, (_, i) => at(d, i)),
      depth: block.depths[d],
    };
  }, [block, depthIndex, timeIndex]);

  if (error) {
    return (
      <aside
        className={`point-panel ${isClosing ? "point-panel--closing" : "point-panel--open"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="point-panel__head">
          <span className="point-panel__id readout">Point</span>
          <button
            type="button"
            className="profile-panel__close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="point-panel__empty">{error}</p>
      </aside>
    );
  }

  if (loading || !block || !derived) {
    return (
      <aside
        className={`point-panel ${isClosing ? "point-panel--closing" : "point-panel--open"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="point-panel__head">
          <span className="point-panel__id readout">Point</span>
          <button
            type="button"
            className="profile-panel__close"
            onClick={handleClose}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="point-panel__empty">
          Reading the water column — 40 levels and a month of history.
        </p>
      </aside>
    );
  }

  const seriesStats = stats(derived.series);
  const profileStats = stats(derived.profile);
  const encoded = encodeRange(block.value_range, block.colormap);
  const hasDepth = derived.nD > 1;

  // --- series path -------------------------------------------------------
  const sx = (i: number) => PAD_L + (i / Math.max(1, derived.nT - 1)) * (W - PAD_L - PAD_R);
  const sLo = seriesStats?.min ?? 0;
  const sHi = seriesStats?.max ?? 1;
  const sy = (v: number) => H_SERIES - 16 - ((v - sLo) / (sHi - sLo || 1)) * (H_SERIES - 28);
  let seriesPath = "";
  let pen = false;
  derived.series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    seriesPath += `${pen ? "L" : "M"}${sx(i).toFixed(1)} ${sy(v).toFixed(1)} `;
    pen = true;
  });

  // --- profile path (power-0.65 depth axis, shared with the 3D column) ----
  const maxDepth = block.depths[derived.nD - 1] ?? 1;
  const py = (d: number) => 14 + depthToNorm(d, maxDepth) * (H_PROFILE - 28);
  const pLo = profileStats?.min ?? 0;
  const pHi = profileStats?.max ?? 1;
  const px = (v: number) => PAD_L + ((v - pLo) / (pHi - pLo || 1)) * (W - PAD_L - PAD_R);
  let profilePath = "";
  pen = false;
  derived.profile.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const d = block.depths[i] ?? 0;
    profilePath += `${pen ? "L" : "M"}${px(v).toFixed(1)} ${py(d).toFixed(1)} `;
    pen = true;
  });

  return (
    <aside
      className={`point-panel ${isClosing ? "point-panel--closing" : "point-panel--open"}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="point-panel__head">
        <span className="point-panel__id readout">
          {Math.abs(block.lat).toFixed(3)}°{block.lat >= 0 ? "N" : "S"}{" "}
          {Math.abs(block.lon).toFixed(3)}°{block.lon >= 0 ? "E" : "W"}
        </span>
        <button
          type="button"
          className="profile-panel__close"
          onClick={handleClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Close point"
        >
          ×
        </button>
      </div>

      <div className="point-panel__value">
        <span className="point-panel__label">{block.label}</span>
        <span className="point-panel__number readout">
          {fmt(derived.value)} <em>{block.units}</em>
        </span>
      </div>
      <p className="point-panel__meta readout">
        {hasDepth && derived.depth !== undefined ? `${fmtDepth(derived.depth)} m · ` : "surface · "}
        grid cell {block.offset_km < 0.05 ? "exact" : `${block.offset_km.toFixed(0)} km away`}
      </p>

      {/* --- time series ------------------------------------------------- */}
      <section className="point-panel__chart">
        <h3 className="point-panel__chart-title">Over time</h3>
        <svg width={W} height={H_SERIES} role="img" aria-label={`${block.label} over time`}>
          <line x1={PAD_L} y1={H_SERIES - 16} x2={W - PAD_R} y2={H_SERIES - 16} className="pp-axis" />
          <path d={seriesPath.trim()} className="pp-line" />
          <line
            x1={sx(timeIndex)}
            y1={8}
            x2={sx(timeIndex)}
            y2={H_SERIES - 16}
            className="pp-cursor"
          />
          <text x={2} y={14} className="pp-tick">{fmt(sHi, 1)}</text>
          <text x={2} y={H_SERIES - 18} className="pp-tick">{fmt(sLo, 1)}</text>
        </svg>
        {seriesStats ? (
          <p className="point-panel__stats readout">
            mean {fmt(seriesStats.mean)} · min {fmt(seriesStats.min)} · max {fmt(seriesStats.max)}{" "}
            {block.units}
          </p>
        ) : null}
      </section>

      {/* --- depth profile ------------------------------------------------ */}
      {hasDepth ? (
        <section className="point-panel__chart">
          <h3 className="point-panel__chart-title">With depth</h3>
          <svg width={W} height={H_PROFILE} role="img" aria-label={`${block.label} against depth`}>
            <line x1={PAD_L} y1={14} x2={PAD_L} y2={H_PROFILE - 14} className="pp-axis" />
            {[0, 200, 1000, maxDepth].map((d) =>
              d <= maxDepth ? (
                <g key={d}>
                  <line x1={PAD_L - 3} y1={py(d)} x2={W - PAD_R} y2={py(d)} className="pp-grid" />
                  <text x={2} y={py(d) + 3} className="pp-tick">{d}</text>
                </g>
              ) : null,
            )}
            <path d={profilePath.trim()} className="pp-line" />
            <circle
              cx={px(derived.value ?? pLo)}
              cy={py(derived.depth ?? 0)}
              r={3}
              className="pp-dot"
            />
          </svg>
          <p className="point-panel__stats readout">depth in metres · {block.units}</p>
        </section>
      ) : null}

      {/* --- depth-time section ------------------------------------------- */}
      {hasDepth ? (
        <section className="point-panel__chart">
          <h3 className="point-panel__chart-title">Depth over time</h3>
          {sectionLoaded || derived.nD > 1 ? (
            <svg
              width={W}
              height={H_SECTION}
              role="img"
              aria-label={`${block.label} by depth and time`}
            >
              {derived.profile.map((_, di) =>
                derived.series.map((__, ti) => {
                  const v = derived.at(di, ti);
                  if (v === null || !Number.isFinite(v)) return null;
                  const t = (v - encoded[0]) / (encoded[1] - encoded[0] || 1);
                  const d0 = block.depths[di] ?? 0;
                  const d1 = block.depths[di + 1] ?? maxDepth;
                  const yTop = 6 + depthToNorm(d0, maxDepth) * (H_SECTION - 18);
                  const yBot = 6 + depthToNorm(d1, maxDepth) * (H_SECTION - 18);
                  return (
                    <rect
                      key={`${di}-${ti}`}
                      x={PAD_L + (ti / derived.nT) * (W - PAD_L - PAD_R)}
                      y={yTop}
                      width={(W - PAD_L - PAD_R) / derived.nT + 0.6}
                      height={Math.max(1.2, yBot - yTop)}
                      fill={sampleCss(block.colormap, Math.max(0, Math.min(1, t)))}
                    />
                  );
                }),
              )}
              <line
                x1={sx(timeIndex)}
                y1={4}
                x2={sx(timeIndex)}
                y2={H_SECTION - 10}
                className="pp-cursor"
              />
              <text x={2} y={14} className="pp-tick">0</text>
              <text x={2} y={H_SECTION - 8} className="pp-tick">{maxDepth}</text>
            </svg>
          ) : (
            <button
              type="button"
              className="point-panel__load"
              onClick={onLoadSection}
              disabled={sectionLoading}
            >
              {sectionLoading ? "Reading the full column…" : "Show depth over time"}
            </button>
          )}
        </section>
      ) : null}

      <p className="point-panel__source readout">
        {block.dataset} · {block.source.provenance}
      </p>
    </aside>
  );
}
