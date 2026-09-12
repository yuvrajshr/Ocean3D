/**
 * The chunk timeline. T12/30 is the step index. Playback speed multiplies a fixed
 * 620 ms frame, so the date is still readable at 4×.
 */

import { dateLabel } from "../../viz/chunk/model";
import type { SceneSpec } from "../../viz/chunk/spec";

const SPEEDS = [1, 2, 4];

interface Props {
  spec: SceneSpec;
  /** The window's actual timestamps, one per step, from the upstream. */
  times: string[];
  playing: boolean;
  speed: number;
  specOpen: boolean;
  onTogglePlay: () => void;
  onSeek: (index: number) => void;
  onSpeed: (speed: number) => void;
  onToggleSpec: () => void;
}

export function TimeBar({
  spec,
  times,
  playing,
  speed,
  specOpen,
  onTogglePlay,
  onSeek,
  onSpeed,
  onToggleSpec,
}: Props) {
  const { index, steps } = spec.time;
  // Show the time the upstream actually served, not the one we asked for (a product
  // with gaps answers with its nearest step).
  const label = dateLabel(times[index] ?? "");

  return (
    <div className="chunk-time chunk-panel chunk-panel--lifted">
      <button
        type="button"
        className="chunk-time__play"
        onClick={onTogglePlay}
        aria-label={playing ? "Pause timeline" : "Play timeline"}
      >
        {playing ? "■" : "▶"}
      </button>
      <div className="chunk-time__date">{label}</div>
      <input
        type="range"
        className="chunk-time__scrub"
        min={0}
        max={steps - 1}
        step={1}
        value={index}
        aria-label="Timeline"
        aria-valuetext={label}
        onChange={(e) => onSeek(+e.target.value)}
      />
      <div className="chunk-time__step">
        {"T" + String(index + 1).padStart(2, "0") + "/" + steps}
      </div>
      <div className="chunk-time__speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`chunk-time__speed${speed === s ? " chunk-time__speed--on" : ""}`}
            aria-pressed={speed === s}
            onClick={() => onSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`chunk-time__spec${specOpen ? " chunk-time__spec--on" : ""}`}
        aria-pressed={specOpen}
        onClick={onToggleSpec}
      >
        Scene spec
      </button>
    </div>
  );
}
