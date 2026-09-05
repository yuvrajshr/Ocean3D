/**
 * Depth ruler for the map: a slice, not a window.
 *
 * `components/DepthRuler.tsx` is a two-handle *window* over a continuous axis,
 * because the 3D column integrates a band. The map shows one level, and the
 * levels are irregular (HYCOM: 0, 2, 4 … 3000, 4000, 5000 m). A continuous
 * slider over those would imply the data interpolates between them, which it
 * does not — so this snaps to real stops and labels the ones it can fit.
 *
 * The component is never rendered at all for a surface field. That is deliberate
 * and stronger than disabling it: a greyed-out ruler still asserts that a depth
 * exists to slice (context.md §10, "depth markings are suppressed for surface
 * variables").
 */

import { useMemo } from "react";

import { depthToNorm } from "../viz/depth";

interface Props {
  levels: number[];
  index: number;
  onChange: (index: number) => void;
  label: string;
}

function fmtDepth(d: number): string {
  if (d >= 100) return d.toFixed(0);
  if (d >= 10) return d.toFixed(1);
  return d.toFixed(2).replace(/\.?0+$/, "");
}

export function MapDepthRuler({ levels, index, onChange, label }: Props) {
  const maxDepth = levels[levels.length - 1] ?? 1;
  // The same power-0.65 axis the 3D column and the profile chart use, so a depth
  // sits in the same relative place everywhere in the product (viz/depth.ts).
  const pos = (d: number) => depthToNorm(d, maxDepth) * 100;

  // Which stops get a printed label. Walking the axis with a running note of
  // the last label placed means a dense cluster near the surface yields the ones
  // that fit, instead of none: comparing only to the immediate neighbour (the
  // first attempt) dropped every label in a tight run.
  const labelAt = useMemo(() => {
    let last = -Infinity;
    return levels.map((depth, i) => {
      const p = depthToNorm(depth, levels[levels.length - 1] ?? 1) * 100;
      const keep = i === 0 || i === levels.length - 1 || p - last > 6.5;
      if (keep) last = p;
      return keep;
    });
  }, [levels]);

  const step = (delta: number) => {
    onChange(Math.max(0, Math.min(levels.length - 1, index + delta)));
  };

  return (
    <div className="map-depth">
      <div className="map-depth__track">
        {levels.map((depth, i) => {
          const labelled = labelAt[i] ?? false;
          return (
            <button
              key={depth}
              type="button"
              className={`map-depth__stop${i === index ? " map-depth__stop--on" : ""}`}
              style={{ top: `${pos(depth)}%` }}
              aria-label={`${fmtDepth(depth)} metres`}
              aria-pressed={i === index}
              onClick={() => onChange(i)}
              title={`${fmtDepth(depth)} m`}
            >
              <span className="map-depth__tick" />
              {labelled ? <span className="map-depth__label readout">{fmtDepth(depth)}</span> : null}
            </button>
          );
        })}
        <div
          className="map-depth__cursor"
          style={{ top: `${pos(levels[index] ?? 0)}%` }}
          aria-hidden="true"
        />
      </div>

      <div
        className="map-depth__readout readout"
        role="slider"
        tabIndex={0}
        aria-label={`${label} depth`}
        aria-valuemin={levels[0]}
        aria-valuemax={maxDepth}
        aria-valuenow={levels[index]}
        aria-valuetext={`${fmtDepth(levels[index] ?? 0)} metres`}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            onChange(0);
          } else if (e.key === "End") {
            e.preventDefault();
            onChange(levels.length - 1);
          }
        }}
      >
        {fmtDepth(levels[index] ?? 0)} m
      </div>
    </div>
  );
}
