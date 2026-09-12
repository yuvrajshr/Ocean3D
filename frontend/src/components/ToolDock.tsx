/**
 * Right-hand tool dock (not currently rendered). Only the Points tool works: it
 * lists the Argo floats with a button to open the profile graph.
 */

import { useEffect, useRef, useState } from "react";
import {
  MapPin,
  Globe2,
  Map,
  Activity,
  Radio,
} from "lucide-react";
import "../styles/tool-dock.css";

export type ToolMode = "none" | "points" | "lines" | "areas" | "import" | "settings";
export type ProjectionMode = "2d" | "3d";

export interface PointAnnotation {
  id: string;
  lat: number;
  lon: number;
  variableCode: string;
  value: string | number;
  units: string;
  maxDepth?: number;
  platform?: any;
}

export interface ToolDockProps {
  activeTool?: ToolMode;
  onSelectTool?: (tool: ToolMode) => void;
  projectionMode?: ProjectionMode;
  onToggleProjection?: () => void;
  points?: PointAnnotation[];
  selectedPointId?: string;
  onOpenGraphForPoint?: (point: PointAnnotation) => void;
  showGrid?: boolean;
  onToggleGrid?: () => void;
}

export function ToolDock({
  activeTool: externalActiveTool,
  onSelectTool: externalOnSelectTool,
  projectionMode: externalProjectionMode,
  onToggleProjection,
  points = [],
  selectedPointId,
  onOpenGraphForPoint,
  showGrid: _externalShowGrid,
  onToggleGrid: _onToggleGrid,
}: ToolDockProps) {
  // Internal state when not controlled from outside.
  const [internalTool, setInternalTool] = useState<ToolMode>("none");
  const [internalProj, setInternalProj] = useState<ProjectionMode>("3d");
  const autoCloseTimerRef = useRef<number | null>(null);

  const activeTool = externalActiveTool ?? internalTool;
  const projectionMode = externalProjectionMode ?? internalProj;
  const [displayedTool, setDisplayedTool] = useState<ToolMode>(activeTool === "none" ? "points" : activeTool);

  useEffect(() => {
    if (activeTool !== "none") {
      setDisplayedTool(activeTool);
    }
  }, [activeTool]);

  // Clear the auto-close timer on unmount.
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current !== null) {
        window.clearTimeout(autoCloseTimerRef.current);
      }
    };
  }, []);

  const handleSelectTool = (tool: ToolMode) => {
    if (autoCloseTimerRef.current !== null) {
      window.clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }

    const next = activeTool === tool ? "none" : tool;

    if (externalOnSelectTool) {
      externalOnSelectTool(next);
    } else {
      setInternalTool(next);
    }

    // Placeholder tools close again after 2 seconds.
    if (next === "lines" || next === "areas" || next === "import" || next === "settings") {
      autoCloseTimerRef.current = window.setTimeout(() => {
        if (externalOnSelectTool) {
          externalOnSelectTool("none");
        } else {
          setInternalTool("none");
        }
        autoCloseTimerRef.current = null;
      }, 2000);
    }
  };

  const handleToggleProj = () => {
    if (onToggleProjection) {
      onToggleProjection();
    } else {
      setInternalProj((p) => (p === "2d" ? "3d" : "2d"));
    }
  };

  return (
    <div id="ocean3d-tool-dock">
      <div className="tool-dock-bar">
        {/* points tool */}
        <button
          type="button"
          id="btn-tool-points"
          onClick={() => handleSelectTool("points")}
          className={`tool-dock-btn ${activeTool === "points" ? "tool-dock-btn--active" : ""}`}
          title="Point inspection tool (in-situ float markers)"
        >
          <MapPin className="w-5 h-5" style={{ width: 20, height: 20 }} />
          <span className="tool-dock-btn-label">Points</span>
          {points.length > 0 && (
            <span className="tool-dock-badge">{points.length}</span>
          )}
        </button>


        <div className="tool-dock-divider" />

        {/* 2D / 3D toggle */}
        <button
          type="button"
          onClick={handleToggleProj}
          className="tool-dock-projection-btn"
          title={`Switch to ${projectionMode === "2d" ? "3D Interactive Globe" : "2D Flat Map"}`}
        >
          {projectionMode === "2d" ? (
            <Globe2 className="w-5 h-5" style={{ width: 20, height: 20 }} />
          ) : (
            <Map className="w-5 h-5" style={{ width: 20, height: 20 }} />
          )}
          <span className="tool-dock-projection-text">
            {projectionMode.toUpperCase()}
          </span>
        </button>
      </div>

      {/* tool drawer */}
      <div
        className={`tool-dock-drawer ${displayedTool === "points" ? "tool-dock-drawer--points" : ""} ${activeTool !== "none" ? "tool-dock-drawer--open" : "tool-dock-drawer--closed"}`}
      >
        {/* points drawer */}
        {displayedTool === "points" && (
            <div>
              <div className="tool-dock-drawer-header">
                <span className="tool-dock-drawer-title">
                  <Radio className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
                  In-Situ Float Probes ({points.length})
                </span>
                <span className="tool-dock-badge-pill">Live Argo</span>
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
          )}

        </div>
    </div>
  );
}
