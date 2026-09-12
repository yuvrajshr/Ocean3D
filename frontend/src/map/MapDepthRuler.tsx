/**
 * Depth ruler for the map: picks one level.
 *
 * Unlike DepthRuler.tsx (a range over a continuous axis for the 3D column), this
 * snaps to the dataset's real levels, which are uneven (HYCOM: 0, 2, 4 ... 5000 m).
 * It isn't rendered at all for surface fields.
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
  // Same 0.65 power axis as the 3D column and profile chart (viz/depth.ts).
  const pos = (d: number) => depthToNorm(d, maxDepth) * 100;

  // Which stops get a label. Track the last placed label, so a dense cluster near
  // the surface still gets the labels that fit.
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
