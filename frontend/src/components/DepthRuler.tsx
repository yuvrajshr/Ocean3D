/**
 * DepthRuler / DepthSlider Component
 *
 * Precision glassmorphic vertical ocean depth slider matching modern GIS instruments:
 * - Clean vertical D E P T H header
 * - Glassmorphic pill container with cyan accents
 * - Depth gradient fill tracking from surface down to active level
 * - Accurate 24-level INCOIS ERDDAP depth discretization
 * - Live left-anchored tooltip callout with active depth and oceanographic zone
 * - Synchronized with Three.js water column volume windowing
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import "../styles/depth-ruler.css";

/** Depth levels can arrive at full float precision from a model grid
 *  (Copernicus surface level is 0.49402499198913574 m). The built-in levels are
 *  round numbers, which is why this only shows up with an external `levels`. */
function formatDepth(d: number): string {
  if (d >= 100) return d.toFixed(0);
  if (d >= 10) return d.toFixed(1);
  return String(Number(d.toFixed(2)));
}

export interface DepthLevel {
  depthMeters: number;
  label: string;
  zone: string;
}

export const DEFAULT_DEPTH_LEVELS: DepthLevel[] = [
  { depthMeters: 0.5, label: "0.5 m", zone: "Sea Surface Interface" },
  { depthMeters: 5, label: "5 m", zone: "Near Surface" },
  { depthMeters: 10, label: "10 m", zone: "Surface Layer" },
  { depthMeters: 15, label: "15 m", zone: "Mixed Layer Top" },
  { depthMeters: 20, label: "20 m", zone: "Mixed Layer" },
  { depthMeters: 25, label: "25 m", zone: "Mixed Layer Core" },
  { depthMeters: 30, label: "30 m", zone: "Mixed Layer Base" },
  { depthMeters: 40, label: "40 m", zone: "Upper Thermocline" },
  { depthMeters: 50, label: "50 m", zone: "Thermocline Gradient" },
  { depthMeters: 75, label: "75 m", zone: "Thermocline Core" },
  { depthMeters: 100, label: "100 m", zone: "D26 Isotherm Level" },
  { depthMeters: 125, label: "125 m", zone: "Lower Thermocline" },
  { depthMeters: 150, label: "150 m", zone: "Barrier Layer Base" },
  { depthMeters: 200, label: "200 m", zone: "Base of Photic Zone" },
  { depthMeters: 250, label: "250 m", zone: "Mesopelagic Transition" },
  { depthMeters: 300, label: "300 m", zone: "Mesopelagic 300m" },
  { depthMeters: 400, label: "400 m", zone: "Intermediate Water" },
  { depthMeters: 500, label: "500 m", zone: "Central Water Mass" },
  { depthMeters: 750, label: "750 m", zone: "Oxygen Minimum Zone" },
  { depthMeters: 1000, label: "1000 m", zone: "Argo Parking Depth" },
  { depthMeters: 1250, label: "1250 m", zone: "Deep Ocean" },
  { depthMeters: 1500, label: "1500 m", zone: "Bathypelagic Upper" },
  { depthMeters: 1750, label: "1750 m", zone: "Bathypelagic Lower" },
  { depthMeters: 2000, label: "2000 m", zone: "Argo Profile Floor" },
];

export interface DepthRulerProps {
  currentDepthIndex?: number;
  onDepthChange?: (index: number) => void;
  window?: [number, number];
  onChange?: (window: [number, number]) => void;
  cursorDepth?: number | null;
  levels?: DepthLevel[];
}

export function DepthRuler({
  currentDepthIndex: externalIndex,
  onDepthChange: externalOnDepthChange,
  window: depthWindow,
  onChange: externalOnChangeWindow,
  cursorDepth: _cursorDepth,
  levels = DEFAULT_DEPTH_LEVELS,
}: DepthRulerProps) {
  const [internalIndex, setInternalIndex] = useState<number>(levels.length - 1);
  const [isDragging, setIsDragging] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  // Derive current active depth index
  let activeIndex: number;
  if (externalIndex !== undefined) {
    activeIndex = externalIndex;
  } else if (depthWindow !== undefined) {
    const bottomDepth = depthWindow[1];
    let closestIdx = 0;
    let minDiff = Infinity;
    levels.forEach((lvl, i) => {
      const diff = Math.abs(lvl.depthMeters - bottomDepth);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    });
    activeIndex = closestIdx;
  } else {
    activeIndex = internalIndex;
  }

  const totalLevels = levels.length;
  const safeIndex = Math.max(0, Math.min(totalLevels - 1, activeIndex));
  const currentLevel = levels[safeIndex] ?? levels[levels.length - 1]!;
  const percentage = (safeIndex / (totalLevels - 1)) * 100;

  const notifyDepthChange = useCallback(
    (targetIdx: number) => {
      const safeIdx = Math.max(0, Math.min(totalLevels - 1, targetIdx));
      const targetDepth = levels[safeIdx]?.depthMeters ?? 2000;

      if (externalOnDepthChange) {
        externalOnDepthChange(safeIdx);
      } else {
        setInternalIndex(safeIdx);
      }

      if (externalOnChangeWindow) {
        externalOnChangeWindow([0, targetDepth]);
      }
    },
    [externalOnDepthChange, externalOnChangeWindow, levels, totalLevels],
  );

  const updateFromPointer = useCallback(
    (clientY: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const relativeY = Math.max(0, Math.min(rect.height, clientY - rect.top));
      const fraction = relativeY / rect.height;
      const targetIdx = Math.round(fraction * (totalLevels - 1));
      if (targetIdx !== safeIndex && targetIdx >= 0 && targetIdx < totalLevels) {
        notifyDepthChange(targetIdx);
      }
    },
    [notifyDepthChange, safeIndex, totalLevels],
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setShowTooltip(true);
    updateFromPointer(e.clientY);
  };

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) {
        updateFromPointer(e.clientY);
      }
    };

    const handlePointerUp = () => {
      if (isDragging) {
        setIsDragging(false);
      }
    };

    if (isDragging) {
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    }
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDragging, updateFromPointer]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      notifyDepthChange(safeIndex - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      notifyDepthChange(safeIndex + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      notifyDepthChange(0);
    } else if (e.key === "End") {
      e.preventDefault();
      notifyDepthChange(totalLevels - 1);
    }
  };

  return (
    <div
      id="ocean3d-depth-slider"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => !isDragging && setShowTooltip(false)}
      role="region"
      aria-label="Ocean Depth Control"
    >
      {/* Current depth callout tooltip anchored to the left of the slider */}
      {showTooltip && (
        <div className="depth-slider-tooltip">
          <div className="depth-slider-tooltip-tag">Active Ocean Depth</div>
          <div className="depth-slider-tooltip-val">{currentLevel.label}</div>
          <div className="depth-slider-tooltip-sub">
            {currentLevel.depthMeters === 0.5
              ? "Sea Surface Interface"
              : `Level ${safeIndex + 1} of ${totalLevels} · ${currentLevel.zone}`}
          </div>
        </div>
      )}

      {/* Pill Container */}
      <div className="depth-slider-pill">
        {/* Vertical DEPTH text header */}
        <div className="depth-slider-header" title="Ocean Water Column Depth">
          <span>D</span>
          <span>E</span>
          <span>P</span>
          <span>T</span>
          <span>H</span>
        </div>

        {/* Vertical Track */}
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          className="depth-slider-track"
          title="Drag to adjust ocean depth slice"
        >
          {/* Depth Gradient Fill */}
          <div
            className="depth-slider-fill"
            style={{ height: `${percentage}%` }}
          />

          {/* Level Tick marks */}
          {levels.map((lvl, idx) => {
            const tickPercent = (idx / (totalLevels - 1)) * 100;
            const isSelected = idx === safeIndex;
            return (
              <div
                key={lvl.depthMeters}
                className={`depth-slider-tick ${isSelected ? "depth-slider-tick--active" : ""}`}
                style={{ top: `${tickPercent}%` }}
              />
            );
          })}

          {/* Draggable Cyan Handle */}
          <button
            type="button"
            className="depth-slider-handle"
            style={{ top: `${percentage}%` }}
            onKeyDown={handleKeyDown}
            role="slider"
            aria-label="Water Column Depth"
            aria-valuemin={0}
            aria-valuemax={2000}
            aria-valuenow={currentLevel.depthMeters}
            aria-valuetext={`${currentLevel.label} - ${currentLevel.zone}`}
          >
            <div className="depth-slider-handle-grip">
              <div className="depth-slider-handle-bar" />
              <div className="depth-slider-handle-bar" />
            </div>
          </button>
        </div>

        {/* Bottom Depth Readout */}
        <div className="depth-slider-footer">
          {formatDepth(currentLevel.depthMeters)}m
        </div>
      </div>
    </div>
  );
}

// Named alias export for compatibility
export const DepthSlider = DepthRuler;
