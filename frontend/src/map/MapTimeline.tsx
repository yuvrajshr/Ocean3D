/**
 * Timeline for the map: one clock, several cadences.
 *
 * Timeline.tsx works with one axis by index; the map has up to three axes and
 * works with ISO times. The rail covers every visible layer's range, and each
 * layer gets its own row of ticks, so you can see a monthly layer next to a daily
 * one. Step and play use the active layer's cadence.
 */

import { datasetOf, timelineBounds, resolveLayerTime, activeLayer, type MapState } from "./state";

interface Props {
  state: MapState;
  onSeek: (iso: string) => void;
  onStep: (steps: number) => void;
  onTogglePlay: () => void;
}

const DAY_MS = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function MapTimeline({ state, onSeek, onStep, onTogglePlay }: Props) {
  const bounds = timelineBounds(state);
  const active = activeLayer(state);
  const activeInfo = active ? datasetOf(state, active) : undefined;

  if (!bounds || !state.time) {
    return (
      <div className="timeline map-timeline">
        <span className="timeline__readout readout">No layers to scrub.</span>
      </div>
    );
  }

  const start = Date.parse(`${bounds.start}T00:00:00Z`);
  const end = Date.parse(`${bounds.end}T00:00:00Z`);
  const span = Math.max(1, end - start);
  const now = Date.parse(state.time);
  const frac = Math.max(0, Math.min(1, (now - start) / span));

  const stepLabel =
    activeInfo?.cadence === "monthly"
      ? "month"
      : activeInfo?.cadence === "10-daily"
        ? "10 days"
        : "day";

  const seekTo = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(iso(start + t * span));
  };

  // One tick row per visible layer, sampled down to what the rail can show.
  const rows = state.layers
    .filter((l) => l.visible)
    .map((layer) => {
      const info = datasetOf(state, layer);
      if (!info) return null;
      const axis = state.axes[layer.datasetId];
      const stamps = axis?.times ?? [];
      const sampleEvery = Math.max(1, Math.ceil(stamps.length / 240));
      return {
        id: layer.id,
        label: info.label,
        resolved: resolveLayerTime(state, layer),
        ticks: stamps
          .filter((_, i) => i % sampleEvery === 0)
          .map((t) => (Date.parse(t) - start) / span)
          .filter((p) => p >= 0 && p <= 1),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const years = [];
  const y0 = new Date(start).getUTCFullYear();
  const y1 = new Date(end).getUTCFullYear();
  const yearStep = Math.max(1, Math.ceil((y1 - y0) / 8));
  for (let y = Math.ceil(y0 / yearStep) * yearStep; y <= y1; y += yearStep) {
    const at = Date.UTC(y, 0, 1);
    if (at >= start && at <= end) years.push({ y, p: (at - start) / span });
  }

  return (
    <div className="timeline map-timeline">
      <button
        type="button"
        className="timeline__button"
        aria-label={state.playing ? "Pause timeline" : "Play timeline"}
        onClick={onTogglePlay}
      >
        {state.playing ? "❚❚" : "▶"}
      </button>

      <button
        type="button"
        className="timeline__button"
        aria-label={`Back one ${stepLabel}`}
        onClick={() => onStep(-1)}
      >
        ◀
      </button>

      <div
        className="map-timeline__rail"
        role="slider"
        tabIndex={0}
        aria-label="Date"
        aria-valuemin={start}
        aria-valuemax={end}
        aria-valuenow={now}
        aria-valuetext={new Date(now).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e.clientX, e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekTo(e.clientX, e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            onStep(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            onStep(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            onSeek(iso(start));
          } else if (e.key === "End") {
            e.preventDefault();
            onSeek(iso(end));
          }
        }}
      >
        {years.map(({ y, p }) => (
          <span key={y} className="map-timeline__year readout" style={{ left: `${p * 100}%` }}>
            {y}
          </span>
        ))}

        {rows.map((row, rowIndex) => (
          <div
            key={row.id}
            className="map-timeline__row"
            /* Explicit offset instead of :nth-child, which also counted the year labels. */
            style={{ bottom: 3 + rowIndex * 8 }}
            title={`${row.label} steps`}
          >
            {row.ticks.map((p, i) => (
              <span key={i} className="map-timeline__tick" style={{ left: `${p * 100}%` }} />
            ))}
            {row.resolved && !row.resolved.outOfCoverage ? (
              <span
                className="map-timeline__at"
                style={{
                  left: `${((Date.parse(row.resolved.time) - start) / span) * 100}%`,
                }}
              />
            ) : null}
          </div>
        ))}

        <div className="map-timeline__thumb" style={{ left: `${frac * 100}%` }} />
      </div>

      <button
        type="button"
        className="timeline__button"
        aria-label={`Forward one ${stepLabel}`}
        onClick={() => onStep(1)}
      >
        ▶
      </button>

      <div className="map-timeline__readout readout">
        <strong>
          {new Date(now).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          })}
        </strong>
        <span>
          {activeInfo ? `${activeInfo.label} · ${activeInfo.cadence}` : ""} · step 1 {stepLabel}
        </span>
      </div>
    </div>
  );
}

export const TIMELINE_DAY_MS = DAY_MS;
