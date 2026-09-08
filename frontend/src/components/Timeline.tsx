/**
 * Timeline scrubber console over INCOIS scenario model timesteps.
 *
 * Designed with a precision glassmorphic instrument console aesthetic:
 * - Direct Year/Month/Day readouts with interactive micro-step adjustments
 * - Play/pause transport with step backward, forward, jump-to-latest and 4K animation export
 * - 48-tick precision ruler with glowing position line and pentagon grip handle
 * - Interactive pointer scrubbing and full keyboard accessibility
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Minimize2,
} from "lucide-react";
import "../styles/timeline.css";

export type TimeGranularity = "DAY" | "RUN" | "MONTH" | "YEAR";

export interface TimelineProps {
  timesteps: string[];
  index: number;
  playing: boolean;
  disabled?: boolean;
  onSeek: (index: number) => void;
  onTogglePlay: () => void;
  stepUnit?: TimeGranularity;
  onStepUnitChange?: (unit: TimeGranularity) => void;
}

const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

export function Timeline({
  timesteps,
  index,
  playing,
  disabled = false,
  onSeek,
  onTogglePlay,
  stepUnit: externalStepUnit,
  onStepUnitChange,
}: TimelineProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPercent, setScrubPercent] = useState<number | null>(null);
  const [internalStepUnit, setInternalStepUnit] = useState<TimeGranularity>("DAY");

  const rulerRef = useRef<HTMLDivElement>(null);

  const stepUnit = externalStepUnit ?? internalStepUnit;
  const count = timesteps.length;

  const currentIso = timesteps[index];
  const currentDate = useMemo(() => {
    return currentIso ? new Date(currentIso) : new Date("2013-10-10T00:00:00Z");
  }, [currentIso]);

  const minDate = useMemo(() => {
    const first = timesteps[0];
    return first ? new Date(first) : new Date("2013-10-01T00:00:00Z");
  }, [timesteps]);

  const maxDate = useMemo(() => {
    const last = count > 0 ? timesteps[count - 1] : undefined;
    return last ? new Date(last) : new Date("2013-10-25T00:00:00Z");
  }, [timesteps, count]);

  // Position percentage along the timeline
  const discretePercent = count > 1 ? (index / (count - 1)) * 100 : 0;
  const currentPercent = isScrubbing && scrubPercent !== null ? scrubPercent : discretePercent;

  // Formatted date values
  const year = currentDate.getUTCFullYear();
  const month = MONTH_NAMES[currentDate.getUTCMonth()] ?? "OCT";
  const day = String(currentDate.getUTCDate()).padStart(2, "0");

  // Step calculations
  const stepBy = (direction: 1 | -1) => {
    if (disabled || count === 0) return;
    const nextIndex = Math.max(0, Math.min(count - 1, index + direction));
    onSeek(nextIndex);
  };

  const jumpToEnd = () => {
    if (disabled || count === 0) return;
    onSeek(count - 1);
  };

  // Micro adjustments on Year / Month / Day
  const adjustDate = (field: "year" | "month" | "day", delta: number) => {
    if (disabled || count === 0) return;
    const target = new Date(currentDate);
    if (field === "year") target.setUTCFullYear(target.getUTCFullYear() + delta);
    else if (field === "month") target.setUTCMonth(target.getUTCMonth() + delta);
    else if (field === "day") target.setUTCDate(target.getUTCDate() + delta);

    const targetMs = target.getTime();
    let bestIdx = 0;
    let minDiff = Infinity;
    timesteps.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    });

    onSeek(bestIdx);
  };

  // Scrubber drag logic
  const updateScrubberPosition = useCallback(
    (clientX: number, commit = false) => {
      const ruler = rulerRef.current;
      if (!ruler || count === 0) return;
      const rect = ruler.getBoundingClientRect();
      const relativeX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const fraction = rect.width > 0 ? relativeX / rect.width : 0;
      const percent = fraction * 100;
      setScrubPercent(percent);

      const targetIndex = Math.round(fraction * (count - 1));
      const clampedIndex = Math.max(0, Math.min(count - 1, targetIndex));
      onSeek(clampedIndex);

      if (commit) {
        setScrubPercent(null);
      }
    },
    [count, onSeek]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || count === 0) return;
    setIsScrubbing(true);
    updateScrubberPosition(e.clientX, false);
  };

  useEffect(() => {
    if (!isScrubbing) return;
    const handlePointerMove = (e: PointerEvent) => {
      updateScrubberPosition(e.clientX, false);
    };
    const handlePointerUp = (e: PointerEvent) => {
      setIsScrubbing(false);
      updateScrubberPosition(e.clientX, true);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isScrubbing, updateScrubberPosition]);

  // Keyboard navigation for accessibility
  const handleKey = (event: React.KeyboardEvent) => {
    if (disabled || count === 0) return;
    let next = index;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = index - 1;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = index + 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === " ") {
      event.preventDefault();
      onTogglePlay();
      return;
    } else return;

    event.preventDefault();
    onSeek(Math.max(0, Math.min(count - 1, next)));
  };

  // Cycle step granularity unit
  const cycleStepUnit = () => {
    const units: TimeGranularity[] = ["DAY", "RUN", "MONTH", "YEAR"];
    const nextUnit = units[(units.indexOf(stepUnit) + 1) % units.length] ?? "DAY";
    if (onStepUnitChange) {
      onStepUnitChange(nextUnit);
    } else {
      setInternalStepUnit(nextUnit);
    }
  };

  // Dynamic ruler bottom labels with clean non-overlapping positioning
  const rulerLabels = useMemo(() => {
    if (count === 0) return [];

    const formatFull = (d: Date) =>
      `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

    if (count === 1) {
      return [{ label: formatFull(minDate), highlight: true, pos: "center" as const }];
    }

    const startStr = formatFull(minDate);
    const endStr = formatFull(maxDate);

    // If start and end represent the exact same day
    if (startStr === endStr) {
      return [{ label: startStr, highlight: true, pos: "center" as const }];
    }

    // Include middle landmark if 3 or more distinct timesteps
    if (count >= 3) {
      const midDate = new Date(timesteps[Math.floor(count / 2)]!);
      const midStr = formatFull(midDate);

      // Only show mid label if distinct from both start and end
      if (midStr !== startStr && midStr !== endStr) {
        return [
          { label: startStr, highlight: false, pos: "left" as const },
          { label: midStr, highlight: false, pos: "center" as const },
          { label: endStr, highlight: true, pos: "right" as const },
        ];
      }
    }

    return [
      { label: startStr, highlight: false, pos: "left" as const },
      { label: endStr, highlight: true, pos: "right" as const },
    ];
  }, [timesteps, count, minDate, maxDate]);

  return (
    <div
      id="ocean3d-timeline-scrubber"
      className={`timeline-scrubber-wrapper ${isCollapsed ? "timeline-scrubber-wrapper--collapsed" : ""}`}
    >
      {/* Main Scrubber Bar */}
      <div className="timeline-scrubber__bar">
        {/* Left Block: Date Readout + Controls */}
        <div className="timeline-scrubber__left">
          {/* Micro Date Adjustments */}
          <div className="timeline-scrubber__date-group">
            {/* Year */}
            <div className="timeline-scrubber__date-col">
              <button
                type="button"
                onClick={() => adjustDate("year", 1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Next year"
                aria-label="Next year"
              >
                <ChevronUp className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
              <span className="timeline-scrubber__date-val">{year}</span>
              <button
                type="button"
                onClick={() => adjustDate("year", -1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Previous year"
                aria-label="Previous year"
              >
                <ChevronDown className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
            </div>

            {/* Month */}
            <div className="timeline-scrubber__date-col">
              <button
                type="button"
                onClick={() => adjustDate("month", 1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Next month"
                aria-label="Next month"
              >
                <ChevronUp className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
              <span className="timeline-scrubber__date-val timeline-scrubber__date-val--month">
                {month}
              </span>
              <button
                type="button"
                onClick={() => adjustDate("month", -1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Previous month"
                aria-label="Previous month"
              >
                <ChevronDown className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
            </div>

            {/* Day */}
            <div className="timeline-scrubber__date-col">
              <button
                type="button"
                onClick={() => adjustDate("day", 1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Next day"
                aria-label="Next day"
              >
                <ChevronUp className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
              <span className="timeline-scrubber__date-val">{day}</span>
              <button
                type="button"
                onClick={() => adjustDate("day", -1)}
                className="timeline-scrubber__micro-btn"
                disabled={disabled}
                title="Previous day"
                aria-label="Previous day"
              >
                <ChevronDown className="w-3 h-3" style={{ width: 12, height: 12 }} />
              </button>
            </div>
          </div>

          {/* Step Size indicator */}
          <div className="timeline-scrubber__step-indicator">
            <span className="timeline-scrubber__step-label">STEP</span>
            <span className="timeline-scrubber__step-val">1 {stepUnit}</span>
          </div>

          {/* Transport playback controls */}
          <div className="timeline-scrubber__transport">
            <button
              type="button"
              onClick={() => stepBy(-1)}
              className="timeline-scrubber__ctrl-btn"
              disabled={disabled || count === 0}
              title="Step backward"
              aria-label="Step backward"
            >
              <ChevronLeft className="w-4 h-4" style={{ width: 16, height: 16 }} />
            </button>

            <button
              type="button"
              id="btn-play-pause-timeline"
              onClick={onTogglePlay}
              className="timeline-scrubber__ctrl-btn timeline-scrubber__ctrl-btn--play"
              disabled={disabled || count < 2}
              title={playing ? "Pause animation" : "Play animation"}
              aria-label={playing ? "Pause animation" : "Play animation"}
            >
              {playing ? (
                <Pause className="w-4 h-4" style={{ width: 16, height: 16 }} />
              ) : (
                <Play className="w-4 h-4" style={{ width: 16, height: 16 }} />
              )}
            </button>

            <button
              type="button"
              onClick={() => stepBy(1)}
              className="timeline-scrubber__ctrl-btn"
              disabled={disabled || count === 0}
              title="Step forward"
              aria-label="Step forward"
            >
              <ChevronRight className="w-4 h-4" style={{ width: 16, height: 16 }} />
            </button>

            <button
              type="button"
              onClick={jumpToEnd}
              className="timeline-scrubber__ctrl-btn"
              disabled={disabled || count === 0}
              title="Jump to latest forecast"
              aria-label="Jump to latest forecast"
            >
              <ChevronsRight className="w-4 h-4" style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        {/* Center Ruler Block */}
        <div
          ref={rulerRef}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKey}
          className="timeline-scrubber__center"
          role="slider"
          tabIndex={0}
          aria-label="Ocean model run date"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, count - 1)}
          aria-valuenow={index}
          aria-valuetext={currentIso ? `${year} ${month} ${day}` : "No model runs"}
        >
          {/* Top colored progress bar */}
          <div className="timeline-scrubber__top-bar">
            <div
              className="timeline-scrubber__progress-fill"
              style={{ width: `${currentPercent}%` }}
            />
          </div>

          {/* Tick Marks Layer */}
          <div className="timeline-scrubber__ticks-layer">
            {Array.from({ length: 48 }).map((_, i) => {
              const isMajor = i % 6 === 0;
              return (
                <div
                  key={i}
                  className={`timeline-scrubber__tick ${
                    isMajor ? "timeline-scrubber__tick--major" : ""
                  }`}
                />
              );
            })}
          </div>

          {/* Vertical position line */}
          <div
            className="timeline-scrubber__cursor-line"
            style={{ left: `${currentPercent}%` }}
          />

          {/* Date range labels beneath ruler */}
          <div className="timeline-scrubber__labels">
            {rulerLabels.map((lbl, idx) => (
              <span
                key={idx}
                className="timeline-scrubber__label"
                style={{
                  textAlign: lbl.pos === "left" ? "left" : lbl.pos === "right" ? "right" : "center",
                }}
              >
                {lbl.label}
              </span>
            ))}
          </div>
        </div>

        {/* Right Section: Cadence Selector + Expand/Shrink Toggle */}
        <div className="timeline-scrubber__right">
          <button
            type="button"
            onClick={cycleStepUnit}
            className="timeline-scrubber__unit-btn"
            title="Step cadence: click to switch (DAY / RUN / MONTH / YEAR)"
            aria-label={`Step cadence: ${stepUnit}. Click to cycle.`}
          >
            <span className="timeline-scrubber__unit-tag">CADENCE</span>
            <span className="timeline-scrubber__unit-text">{stepUnit}</span>
          </button>

          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={`timeline-scrubber__collapse-btn ${isCollapsed ? "timeline-scrubber__collapse-btn--collapsed" : ""}`}
            title={isCollapsed ? "Expand timeline ruler" : "Shrink timeline ruler"}
            aria-label={isCollapsed ? "Expand timeline ruler" : "Shrink timeline ruler"}
          >
            {isCollapsed ? (
              <>
                <Maximize2 className="w-3.5 h-3.5" style={{ width: 13, height: 13 }} />
                <span className="timeline-scrubber__collapse-text">EXPAND</span>
              </>
            ) : (
              <>
                <Minimize2 className="w-3.5 h-3.5" style={{ width: 13, height: 13 }} />
                <span className="timeline-scrubber__collapse-text">SHRINK</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Named alias for convenience
export const TimelineScrubber = Timeline;