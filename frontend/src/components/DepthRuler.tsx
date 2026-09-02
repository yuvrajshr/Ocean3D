/**
 * The depth control is drawn as an actual ruler whose tick marks double as the
 * slider (context.md §5.1) — not a styled range input with a gradient behind it.
 *
 * Positions come from the shared square-root transform in viz/depth.ts, the
 * same one the 3D scene and the profile chart use, so 100 m is at the same
 * height in all three.
 */

import { useCallback, useRef } from "react";

import { depthToNorm, LABELLED_TICKS, MAX_DEPTH, normToDepth, RULER_TICKS } from "../viz/depth";

interface DepthRulerProps {
  window: [number, number];
  cursorDepth: number | null;
  onChange: (window: [number, number]) => void;
}

const STEP_SMALL = 10;
const STEP_LARGE = 100;

export function DepthRuler({ window: depthWindow, cursorDepth, onChange }: DepthRulerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"top" | "bottom" | null>(null);

  const [topDepth, bottomDepth] = depthWindow;

  const depthFromEvent = useCallback((clientY: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const norm = (clientY - rect.top) / rect.height;
    return normToDepth(Math.max(0, Math.min(1, norm)), MAX_DEPTH);
  }, []);

  const handlePointerDown = (which: "top" | "bottom") => (event: React.PointerEvent) => {
    event.preventDefault();
    dragging.current = which;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragging.current) return;
    const depth = depthFromEvent(event.clientY);
    if (dragging.current === "top") {
      onChange([Math.min(depth, bottomDepth - 20), bottomDepth]);
    } else {
      onChange([topDepth, Math.max(depth, topDepth + 20)]);
    }
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    dragging.current = null;
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const handleKey = (which: "top" | "bottom") => (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? STEP_LARGE : STEP_SMALL;
    let delta = 0;
    if (event.key === "ArrowUp") delta = -step;
    else if (event.key === "ArrowDown") delta = step;
    else if (event.key === "Home") delta = -MAX_DEPTH;
    else if (event.key === "End") delta = MAX_DEPTH;
    else return;

    event.preventDefault();
    if (which === "top") {
      const next = Math.max(0, Math.min(bottomDepth - 20, topDepth + delta));
      onChange([next, bottomDepth]);
    } else {
      const next = Math.min(MAX_DEPTH, Math.max(topDepth + 20, bottomDepth + delta));
      onChange([topDepth, next]);
    }
  };

  const topPercent = depthToNorm(topDepth) * 100;
  const bottomPercent = depthToNorm(bottomDepth) * 100;

  return (
    <div className="depth-ruler">
      <div className="depth-ruler__scale" aria-hidden="true">
        {RULER_TICKS.map((depth) => {
          const major = LABELLED_TICKS.has(depth);
          return (
            <div
              key={depth}
              className={`depth-ruler__tick${major ? " depth-ruler__tick--major" : ""}`}
              style={{ top: `${depthToNorm(depth) * 100}%` }}
            >
              {major ? <span className="depth-ruler__tick-label">{depth}</span> : null}
              <span className="depth-ruler__tick-line" />
            </div>
          );
        })}
      </div>

      <div
        className="depth-ruler__track"
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="depth-ruler__window"
          style={{ top: `${topPercent}%`, height: `${Math.max(0, bottomPercent - topPercent)}%` }}
        />

        {cursorDepth !== null ? (
          <div className="depth-ruler__cursor" style={{ top: `${depthToNorm(cursorDepth) * 100}%` }} />
        ) : null}

        <button
          type="button"
          className="depth-ruler__handle"
          style={{ top: `${topPercent}%` }}
          onPointerDown={handlePointerDown("top")}
          onKeyDown={handleKey("top")}
          role="slider"
          aria-label="Shallowest depth shown"
          aria-valuemin={0}
          aria-valuemax={MAX_DEPTH}
          aria-valuenow={Math.round(topDepth)}
          aria-valuetext={`${Math.round(topDepth)} metres`}
        />
        <button
          type="button"
          className="depth-ruler__handle"
          style={{ top: `${bottomPercent}%` }}
          onPointerDown={handlePointerDown("bottom")}
          onKeyDown={handleKey("bottom")}
          role="slider"
          aria-label="Deepest depth shown"
          aria-valuemin={0}
          aria-valuemax={MAX_DEPTH}
          aria-valuenow={Math.round(bottomDepth)}
          aria-valuetext={`${Math.round(bottomDepth)} metres`}
        />
      </div>
    </div>
  );
}
