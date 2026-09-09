/**
 * Variable picker and colour-range editor.
 *
 * The range handles sit directly on the value histogram rather than on two
 * number fields, so clipping is something you can see yourself doing: drag the
 * minimum past the bulk of the distribution and the bars you just excluded grey
 * out. Auto snaps to the chunk's true extremes; picking a variable resets to
 * that variable's published range, because a forecaster reads the same scale
 * every day and a range that moves under them is worse than one that clips.
 */

import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { CMAPS, VARIABLES, type CmapName, type Histogram, type VariableKey } from "../../viz/chunk/model";
import { sampleCmap } from "../../viz/chunk/registry";
import type { SceneSpec } from "../../viz/chunk/spec";
import { fmt, gradient } from "./util";

const HIST_WIDTH = 260;
const HIST_HEIGHT = 58;

interface Props {
  spec: SceneSpec;
  hist: Histogram;
  onCommit: (rebuildAxis?: boolean) => void;
  onVariable: (key: VariableKey) => void;
}

export function FieldPanel({ spec, hist, onCommit, onVariable }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const cr = spec.colorRange;
  const info = VARIABLES[spec.field.variable];
  const span = hist.hi - hist.lo || 1;

  const barWidth = HIST_WIDTH / Math.max(1, hist.counts.length);
  const bars = hist.counts.map((count, i) => {
    const h = Math.max(0.6, (count / (hist.max || 1)) * 52);
    const v = hist.lo + ((i + 0.5) / hist.counts.length) * span;
    const inRange = v >= cr.min && v <= cr.max;
    const t = (v - cr.min) / (cr.max - cr.min || 1);
    const rgb = sampleCmap(CMAPS[cr.palette] ?? CMAPS.thermal, t);
    return {
      x: i * barWidth,
      y: HIST_HEIGHT - 2 - h,
      w: Math.max(0.8, barWidth - 0.7),
      h,
      fill: inRange
        ? "rgb(" + rgb.map((n) => Math.round(n)).join(",") + ")"
        : "rgba(126,166,196,0.16)",
    };
  });

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const fMin = clamp01((cr.min - hist.lo) / span);
  const fMax = clamp01((cr.max - hist.lo) / span);

  const setEnd = (which: "min" | "max", val: number): void => {
    // The two ends can never cross, and never close to nothing: a zero-width
    // range renders one flat colour and reads as a broken field.
    if (which === "min") cr.min = Math.min(val, cr.max - span * 0.02);
    else cr.max = Math.max(val, cr.min + span * 0.02);
    onCommit();
  };

  const dragRange = (which: "min" | "max", e: ReactPointerEvent<HTMLButtonElement>): void => {
    const host = barRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const move = (ev: PointerEvent): void => {
      const f = clamp01((ev.clientX - rect.left) / rect.width);
      setEnd(which, hist.lo + f * span);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e.nativeEvent);
  };

  /** The handles are draggable, but they must also be reachable by keyboard. */
  const nudge = (which: "min" | "max", dir: number): void => {
    setEnd(which, (which === "min" ? cr.min : cr.max) + (dir * span) / 100);
  };

  const handleProps = (which: "min" | "max", f: number) => ({
    className: "chunk-range__handle",
    style: { left: (f * 100).toFixed(2) + "%" },
    role: "slider" as const,
    tabIndex: 0,
    "aria-label": which === "min" ? "Colour range minimum" : "Colour range maximum",
    "aria-valuemin": hist.lo,
    "aria-valuemax": hist.hi,
    "aria-valuenow": which === "min" ? cr.min : cr.max,
    "aria-valuetext": `${fmt(which === "min" ? cr.min : cr.max, info.dec)} ${info.unit}`,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => dragRange(which, e),
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        nudge(which, -1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        nudge(which, 1);
      }
    },
  });

  return (
    <div className="chunk-inspector chunk-panel chunk-panel--lifted">
      <div className="chunk-panel__title">Variable</div>

      <div className="chunk-vars">
        {(Object.keys(VARIABLES) as VariableKey[]).map((key) => {
          const on = spec.field.variable === key;
          return (
            <button
              key={key}
              type="button"
              className={`chunk-var${on ? " chunk-var--on" : ""}`}
              aria-pressed={on}
              onClick={() => onVariable(key)}
            >
              <span className="chunk-var__label">{VARIABLES[key].label}</span>
              <span className="chunk-var__unit">{VARIABLES[key].unit}</span>
            </button>
          );
        })}
      </div>

      <div className="chunk-range">
        <div className="chunk-range__head">
          <div className="chunk-range__title">Color range</div>
          <button
            type="button"
            className="chunk-range__auto"
            onClick={() => {
              cr.min = hist.lo;
              cr.max = hist.hi;
              onCommit();
            }}
          >
            Auto
          </button>
        </div>

        <div className="chunk-range__bar" ref={barRef}>
          <svg
            className="chunk-range__hist"
            viewBox={`0 0 ${HIST_WIDTH} ${HIST_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {bars.map((b, i) => (
              <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />
            ))}
          </svg>
          <div className="chunk-range__ramp" style={{ background: gradient(cr.palette) }}>
            <div
              className="chunk-range__mask chunk-range__mask--min"
              style={{ width: (fMin * 100).toFixed(2) + "%" }}
            />
            <div
              className="chunk-range__mask chunk-range__mask--max"
              style={{ width: ((1 - fMax) * 100).toFixed(2) + "%" }}
            />
          </div>
          <button type="button" {...handleProps("min", fMin)} />
          <button type="button" {...handleProps("max", fMax)} />
        </div>

        <div className="chunk-range__ends">
          <span>{fmt(cr.min, info.dec)}</span>
          <span className="chunk-range__unit">{info.unit}</span>
          <span>{fmt(cr.max, info.dec)}</span>
        </div>

        <div className="chunk-caption chunk-range__palette-title">Palette · cmocean</div>
        <div className="chunk-palettes" role="group" aria-label="Palette">
          {(Object.keys(CMAPS) as CmapName[]).map((name) => {
            const on = cr.palette === name;
            return (
              <button
                key={name}
                type="button"
                className={`chunk-palette${on ? " chunk-palette--on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  cr.palette = name;
                  onCommit();
                }}
              >
                <span className="chunk-palette__chip" style={{ background: gradient(name) }} />
                <span className="chunk-palette__name">{name}</span>
              </button>
            );
          })}
        </div>

        <div className="chunk-seg chunk-range__scale" role="group" aria-label="Colour scale">
          {(
            [
              ["linear", "Linear"],
              ["log", "Log"],
            ] as ["linear" | "log", string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chunk-seg__btn${cr.scale === id ? " chunk-seg__btn--on" : ""}`}
              aria-pressed={cr.scale === id}
              onClick={() => {
                cr.scale = id;
                onCommit();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
