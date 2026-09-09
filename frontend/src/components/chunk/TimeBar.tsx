/**
 * The timeline.
 *
 * The only numbered structural markers in this view live here, on a real
 * scrubber: T12/30 is a step index, not a decorative label. Playback speed is a
 * multiplier on a fixed 620 ms frame, so the date readout stays legible at 4×.
 */

import { dateLabel } from "../../viz/chunk/model";
import type { SceneSpec } from "../../viz/chunk/spec";

const SPEEDS = [1, 2, 4];

interface Props {
  spec: SceneSpec;
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
  playing,
  speed,
  specOpen,
  onTogglePlay,
  onSeek,
  onSpeed,
  onToggleSpec,
}: Props) {
  const { index, steps } = spec.time;

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
      <div className="chunk-time__date">{dateLabel(index)}</div>
      <input
        type="range"
        className="chunk-time__scrub"
        min={0}
        max={steps - 1}
        step={1}
        value={index}
        aria-label="Timeline"
        aria-valuetext={dateLabel(index)}
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
