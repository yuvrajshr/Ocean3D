/**
 * Timeline scrubber over the scenario's real model timesteps.
 *
 * Steps are drawn where data actually exists rather than at even intervals, so
 * the gaps in the 10-daily analysis are visible instead of implied away. This
 * is the only place in the product where a sequence is shown, and it has a real
 * scrubber — which is why numbered markers appear nowhere else (context.md §5.2).
 */

import { useCallback, useRef } from "react";

interface TimelineProps {
  timesteps: string[];
  index: number;
  playing: boolean;
  disabled: boolean;
  onSeek: (index: number) => void;
  onTogglePlay: () => void;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function formatFull(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function Timeline({
  timesteps, index, playing, disabled, onSeek, onTogglePlay,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const count = timesteps.length;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || count === 0) return;
      const rect = track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(Math.round(t * (count - 1)));
    },
    [count, onSeek],
  );

  const handleKey = (event: React.KeyboardEvent) => {
    let next = index;
    if (event.key === "ArrowLeft") next = index - 1;
    else if (event.key === "ArrowRight") next = index + 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(count - 1, next)));
  };

  const current = timesteps[index];
  const position = count > 1 ? (index / (count - 1)) * 100 : 0;

  return (
    <div className="timeline">
      <button
        type="button"
        className="timeline__button"
        onClick={onTogglePlay}
        disabled={disabled || count < 2}
      >
        {playing ? "Pause timeline" : "Play timeline"}
      </button>

      <span className="timeline__bound">{count > 0 ? formatDay(timesteps[0]!) : "—"}</span>

      <div
        className="timeline__track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Model run date"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={index}
        aria-valuetext={current ? formatFull(current) : "No model runs available"}
        onKeyDown={handleKey}
        onPointerDown={(event) => seekFromClientX(event.clientX)}
      >
        <div className="timeline__rail" />
        {timesteps.map((step, i) => (
          <span
            key={step}
            className="timeline__step timeline__step--has-data"
            style={{ left: `${count > 1 ? (i / (count - 1)) * 100 : 0}%` }}
          />
        ))}
        {count > 0 ? <span className="timeline__thumb" style={{ left: `${position}%` }} /> : null}
      </div>

      <span className="timeline__bound">
        {count > 0 ? formatDay(timesteps[count - 1]!) : "—"}
      </span>

      <span className="timeline__readout">
        {current ? formatFull(current) : "No model runs in range"}
      </span>
    </div>
  );
}
