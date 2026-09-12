/**
 * Vertical colorbar drawn as a ruler: ticks show real values and units, so you
 * can read a colour in the water column back as a number.
 */

import { useMemo } from "react";

import { encodeRange, toCssGradient, type ColormapName } from "../viz/colormaps";

interface ColorbarProps {
  label: string;
  units: string;
  unitsDeclaredByUs: boolean;
  colormap: ColormapName;
  range: [number, number] | null;
  fullRange: [number, number] | null;
  clipped: boolean;
  loading: boolean;
}

/** Ticks on round numbers. */
function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [lo];
  const rawStep = span / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function format(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1);
  if (magnitude >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

export function Colorbar({
  label, units, unitsDeclaredByUs, colormap, range, fullRange, clipped, loading,
}: ColorbarProps) {
  const gradient = useMemo(() => toCssGradient(colormap), [colormap]);

  const [lo, hi] = useMemo<[number, number]>(
    () => (range ? encodeRange(range, colormap) : [0, 1]),
    [range, colormap],
  );

  const ticks = useMemo(() => (range ? niceTicks(lo, hi) : []), [range, lo, hi]);

  return (
    <div className="colorbar">
      <div className="colorbar__units" title={`${label} in ${units}`}>
        {units}
      </div>

      <div className="colorbar__body">
        <div
          className="colorbar__ramp"
          style={{ background: gradient }}
          role="img"
          aria-label={
            range
              ? `${label} colour scale, ${format(lo)} to ${format(hi)} ${units}`
              : `${label} colour scale`
          }
        />
        <div className="colorbar__scale">
          {ticks.map((value) => {
            const t = (value - lo) / (hi - lo || 1);
            return (
              <div key={value} className="colorbar__tick" style={{ bottom: `${t * 100}%` }}>
                <span className="colorbar__tick-line" />
                <span className="colorbar__tick-label">{format(value)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="colorbar__note">
        {loading ? (
          "Loading…"
        ) : (
          <>
            {clipped && fullRange ? (
              <span
                className="colorbar__note-line"
                title={`The colour scale spans the middle 96% of values. The data actually runs from ${format(
                  fullRange[0],
                )} to ${format(fullRange[1])} ${units}; outliers beyond the scale are drawn at its end colours.`}
              >
                scale 2–98%
              </span>
            ) : null}
            {unitsDeclaredByUs ? (
              <span
                className="colorbar__note-line"
                title="INCOIS publishes no units for this field. This label is our reading of the values, not the server's."
              >
                units inferred
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
