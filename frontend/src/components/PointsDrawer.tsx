/**
 * Drawer listing the Argo floats reporting in the current scenario, with their
 * position, depth and a button to open the profile graph. Closes on Escape or
 * on a click outside.
 */

import { useEffect, useRef, useState } from "react";
import { Radio, Activity, X } from "lucide-react";
import type { PlatformSummary } from "../api/client";
import "../styles/tool-dock.css";

export interface PointAnnotation {
  id: string;
  lat: number;
  lon: number;
  variableCode: string;
  value: string | number;
  units: string;
  maxDepth?: number;
  platform?: PlatformSummary;
}

export interface PointsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  points?: PointAnnotation[];
  selectedPointId?: string;
  onOpenGraphForPoint?: (point: PointAnnotation) => void;
}

export function PointsDrawer({
  isOpen,
  onClose,
  points = [],
  selectedPointId,
  onOpenGraphForPoint,
}: PointsDrawerProps) {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = window.setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 260);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  // Escape closes it.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // If a profile panel is open, let that close first.
        const profilePanel = document.querySelector(".profile-panel, .point-panel");
        if (profilePanel) return;
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Close on click outside.
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Ignore clicks on the navbar button.
      const navBtn = document.getElementById("btn-nav-points");
      if (navBtn && navBtn.contains(target)) return;

      // Ignore clicks inside the profile or point panel.
      const profilePanel = document.querySelector(".profile-panel, .point-panel");
      if (profilePanel && profilePanel.contains(target)) return;

      if (drawerRef.current && !drawerRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen, onClose]);

  if (!shouldRender) return null;

  return (
    <div
      ref={drawerRef}
      id="ocean3d-points-drawer"
      className={`points-standalone-drawer ${isClosing ? "points-standalone-drawer--closing" : ""}`}
      role="dialog"
      aria-label="In-Situ Float Probes"
    >
      <div className="tool-dock-drawer-header">
        <span className="tool-dock-drawer-title">
          <Radio className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
          In-Situ Float Probes ({points.length})
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="tool-dock-badge-pill">Live Argo</span>
          <button
            type="button"
            className="points-drawer-close-btn"
            onClick={onClose}
            title="Close points drawer (Esc)"
            aria-label="Close points drawer"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <p className="tool-dock-drawer-desc">
        In-situ profiling floats measuring temperature and salinity. Click <strong>Graph</strong> to plot model vs cast validation.
      </p>

      {points.length === 0 ? (
        <div className="tool-dock-empty-hint">
          No floats reporting in this scenario time window.
        </div>
      ) : (
        <div className="tool-dock-points-list">
          {points.map((pt) => {
            const isSelected = selectedPointId === pt.id;
            return (
              <div
                key={pt.id}
                className={`tool-dock-point-row ${isSelected ? "tool-dock-point-row--active" : ""}`}
              >
                <div className="tool-dock-point-main">
                  <div className="tool-dock-point-top">
                    <span className="tool-dock-point-id">Float #{pt.id}</span>
                    <span className="tool-dock-point-depth">
                      Max Depth: {pt.value} {pt.units}
                    </span>
                  </div>
                  <div className="tool-dock-point-coord">
                    {Math.abs(pt.lat).toFixed(3)}°{pt.lat >= 0 ? "N" : "S"},{" "}
                    {Math.abs(pt.lon).toFixed(3)}°{pt.lon >= 0 ? "E" : "W"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenGraphForPoint?.(pt)}
                  className={`tool-dock-graph-btn ${isSelected ? "tool-dock-graph-btn--active" : ""}`}
                  title={`Plot graph comparison for Float #${pt.id}`}
                >
                  <Activity className="w-3.5 h-3.5" style={{ width: 14, height: 14 }} />
                  {isSelected ? "Graphed" : "Graph"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
