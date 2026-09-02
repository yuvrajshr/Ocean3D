/**
 * The floating profile panel — the product's reason to exist.
 *
 * It puts the INCOIS gridded analysis and a real Argo cast on one depth axis so
 * "where does the model disagree with the ocean?" is answered by looking.
 *
 * Two plots share a single depth axis, the Ocean Data View convention. The
 * left panel carries both curves; the right panel carries their difference on
 * its own scale. That second panel is not decoration: a 1.2 °C disagreement is
 * about 4% of a 2-31 °C axis and simply cannot be seen in the left plot, which
 * would leave the headline feature illegible.
 *
 * The chart is hand-drawn SVG rather than a chart library so the depth axis can
 * use the exact transform in viz/depth.ts — the same one the 3D column and the
 * depth ruler use. A library's own linear axis would put 100 m at a different
 * height than the ruler does.
 */

import { useMemo } from "react";

import type { Comparison, PlatformSummary } from "../api/client";
import { depthToNorm, LABELLED_TICKS, RULER_TICKS } from "../viz/depth";

interface ProfilePanelProps {
  platform: PlatformSummary;
  comparison: Comparison | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

const WIDTH = 340;
const HEIGHT = 290;
const PAD = { top: 16, right: 8, bottom: 34, left: 40 };
const PROFILE_W = 182;
const GAP = 22;
const RESIDUAL_W = WIDTH - PAD.left - PAD.right - PROFILE_W - GAP;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const RESIDUAL_X0 = PAD.left + PROFILE_W + GAP;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

export function ProfilePanel({ platform, comparison, loading, error, onClose }: ProfilePanelProps) {
  const chart = useMemo(() => {
    if (!comparison) return null;
    const { observed, model, residual } = comparison;
    if (observed.length === 0) return null;

    const values = [...observed.map((p) => p.value), ...model.map((p) => p.value)];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo) * 0.06 || 0.5;
    const vMin = lo - pad;
    const vMax = hi + pad;

    const maxDepth = Math.max(...observed.map((p) => p.depth), ...model.map((p) => p.depth), 1);

    const x = (v: number) => PAD.left + ((v - vMin) / (vMax - vMin || 1)) * PROFILE_W;
    const y = (d: number) => PAD.top + depthToNorm(d, maxDepth) * PLOT_H;

    const toPath = (points: { depth: number; value: number }[]) =>
      points
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.value).toFixed(2)},${y(p.depth).toFixed(2)}`)
        .join(" ");

    // Residual panel, scaled to the residual itself and centred on zero so the
    // sign is readable at a glance.
    const rValues = residual.map((r) => r.value);
    const rExtent = rValues.length ? Math.max(...rValues.map(Math.abs)) * 1.15 || 0.5 : 0.5;
    const rx = (v: number) => RESIDUAL_X0 + RESIDUAL_W / 2 + (v / rExtent) * (RESIDUAL_W / 2);

    const residualPath = residual.length
      ? residual
          .map((p, i) => `${i === 0 ? "M" : "L"}${rx(p.value).toFixed(2)},${y(p.depth).toFixed(2)}`)
          .join(" ")
      : "";

    const residualArea = residual.length
      ? `M${rx(0).toFixed(2)},${y(residual[0]!.depth).toFixed(2)} ` +
        residual.map((p) => `L${rx(p.value).toFixed(2)},${y(p.depth).toFixed(2)}`).join(" ") +
        ` L${rx(0).toFixed(2)},${y(residual[residual.length - 1]!.depth).toFixed(2)} Z`
      : "";

    return {
      observedPath: toPath(observed),
      modelPath: toPath(model),
      residualPath,
      residualArea,
      zeroX: rx(0),
      rExtent,
      ticks: RULER_TICKS.filter((d) => d <= maxDepth && LABELLED_TICKS.has(d)).map((d) => ({
        depth: d, y: y(d),
      })),
      valueTicks: [vMin, vMax].map((v) => ({ value: v, x: x(v) })),
    };
  }, [comparison]);

  const stats = useMemo(() => {
    if (!comparison || comparison.residual.length === 0) return null;
    const values = comparison.residual.map((r) => r.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let worst = comparison.residual[0]!;
    for (const r of comparison.residual) {
      if (Math.abs(r.value) > Math.abs(worst.value)) worst = r;
    }
    return { mean, worst };
  }, [comparison]);

  return (
    <aside className="profile-panel" aria-label={`Profile for float ${platform.platform_id}`}>
      <header className="profile-panel__header">
        <div className="profile-panel__identity">
          <span className="profile-panel__id">{platform.platform_id}</span>
          <span className="profile-panel__meta">
            {platform.lat.toFixed(3)}°N {platform.lon.toFixed(3)}°E
            {platform.cycle_number !== null ? ` · cycle ${platform.cycle_number}` : ""}
          </span>
          <span className="profile-panel__meta">{formatTime(platform.time)}</span>
        </div>
        <button type="button" className="profile-panel__close" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="profile-panel__body">
        {loading ? (
          <p className="profile-panel__empty">Loading profile and matching model run…</p>
        ) : error ? (
          <p className="notice">
            <span className="notice__icon" aria-hidden="true">!</span>
            <span>{error}</span>
          </p>
        ) : !chart || !comparison ? (
          <p className="profile-panel__empty">
            This float has no quality-controlled levels for the selected variable. Try
            temperature, or pick another float.
          </p>
        ) : (
          <>
            <div className="profile-panel__legend">
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: "var(--bioluminescence)" }} />
                Float
              </span>
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: "var(--current)" }} />
                INCOIS analysis
              </span>
              <span className="legend-item">
                <span
                  className="legend-swatch legend-swatch--band"
                  style={{ background: "color-mix(in srgb, var(--advisory) 40%, transparent)" }}
                />
                Float − analysis
              </span>
            </div>

            <svg
              width="100%"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={
                `Depth profile of ${comparison.variable} for float ${platform.platform_id}. ` +
                (stats
                  ? `The float differs from the INCOIS analysis by ${stats.mean.toFixed(2)} ${comparison.units} on average, ` +
                    `with a largest difference of ${stats.worst.value.toFixed(2)} ${comparison.units} at ${Math.round(stats.worst.depth)} metres.`
                  : "")
              }
            >
              {/* Shared depth grid */}
              {chart.ticks.map((tick) => (
                <g key={tick.depth}>
                  <line
                    x1={PAD.left} x2={WIDTH - PAD.right} y1={tick.y} y2={tick.y}
                    stroke="var(--hairline-strong)" strokeWidth="1"
                  />
                  <text
                    x={PAD.left - 6} y={tick.y + 3} textAnchor="end"
                    fill="var(--text-faint)" fontSize="10" fontFamily="var(--font-readout)"
                  >
                    {tick.depth}
                  </text>
                </g>
              ))}
              <text
                x={PAD.left - 6} y={PAD.top - 5} textAnchor="end"
                fill="var(--text-faint)" fontSize="9" fontFamily="var(--font-readout)"
              >
                m
              </text>

              {/* --- Left: both curves ---
                  The analysis is drawn ON TOP of the float, dashed. Where the
                  two agree — which, at 0.1 °C on a 30 °C axis, is most of the
                  column — they are within a pixel of each other, so a line
                  drawn underneath would be completely hidden and the legend
                  would promise something invisible. Dashed-over-solid reads as
                  agreement, and separates visibly wherever they diverge. */}
              <path
                d={chart.observedPath} fill="none" stroke="var(--bioluminescence)"
                strokeWidth="2" strokeLinejoin="round"
              />
              <path
                d={chart.modelPath} fill="none" stroke="var(--current)"
                strokeWidth="1.5" strokeDasharray="5 4" strokeLinecap="butt"
              />
              {chart.valueTicks.map((tick, i) => (
                <text
                  key={tick.value}
                  x={tick.x} y={HEIGHT - 18}
                  textAnchor={i === 0 ? "start" : "end"}
                  fill="var(--text-faint)" fontSize="10" fontFamily="var(--font-readout)"
                >
                  {tick.value.toFixed(1)}
                </text>
              ))}
              <text
                x={PAD.left + PROFILE_W / 2} y={HEIGHT - 5} textAnchor="middle"
                fill="var(--text-muted)" fontSize="9" fontFamily="var(--font-readout)"
              >
                {comparison.units}
              </text>

              {/* --- Right: the difference, on its own scale --- */}
              <line
                x1={chart.zeroX} x2={chart.zeroX} y1={PAD.top} y2={PAD.top + PLOT_H}
                stroke="var(--text-faint)" strokeWidth="1"
              />
              {chart.residualArea ? (
                <path d={chart.residualArea} fill="var(--advisory)" fillOpacity="0.32" stroke="none" />
              ) : null}
              {chart.residualPath ? (
                <path d={chart.residualPath} fill="none" stroke="var(--advisory)" strokeWidth="1.25" />
              ) : null}
              <text
                x={RESIDUAL_X0} y={HEIGHT - 18} textAnchor="start"
                fill="var(--text-faint)" fontSize="10" fontFamily="var(--font-readout)"
              >
                {(-chart.rExtent).toFixed(1)}
              </text>
              <text
                x={RESIDUAL_X0 + RESIDUAL_W} y={HEIGHT - 18} textAnchor="end"
                fill="var(--text-faint)" fontSize="10" fontFamily="var(--font-readout)"
              >
                +{chart.rExtent.toFixed(1)}
              </text>
              <text
                x={RESIDUAL_X0 + RESIDUAL_W / 2} y={HEIGHT - 5} textAnchor="middle"
                fill="var(--text-muted)" fontSize="9" fontFamily="var(--font-readout)"
              >
                difference
              </text>
            </svg>

            {stats ? (
              <>
                <div className="stat-row">
                  <span className="stat-row__label">Mean difference</span>
                  <span className="stat-row__value">
                    {stats.mean >= 0 ? "+" : ""}{stats.mean.toFixed(2)} {comparison.units}
                  </span>
                </div>
                <div className="stat-row">
                  <span className="stat-row__label">Largest difference</span>
                  <span className="stat-row__value">
                    {stats.worst.value >= 0 ? "+" : ""}{stats.worst.value.toFixed(2)}{" "}
                    {comparison.units} at {Math.round(stats.worst.depth)} m
                  </span>
                </div>
                <div className="stat-row">
                  <span className="stat-row__label">Levels measured</span>
                  <span className="stat-row__value">{comparison.observed.length}</span>
                </div>
              </>
            ) : null}

            <p className="profile-panel__footnote">
              The analysis is sampled at its nearest grid point,{" "}
              {comparison.grid_point.offset_km} km away on a{" "}
              {comparison.grid_point.resolution_deg}° grid, from the model run of{" "}
              {new Date(comparison.model_time).toLocaleDateString("en-GB", {
                day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
              })}
              . Differences smaller than the grid spacing are expected.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
