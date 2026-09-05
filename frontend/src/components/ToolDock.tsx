/**
 * ToolDock Component.
 *
 * Right-hand floating tool dock matching modern oceanographic GIS tools:
 * - Points Tool (Functional): Lists real in-situ Argo float profiles with coordinates, depth, and 1-click Graph inspection
 * - Lines Tool (Representational): Ocean transects cross-section analysis
 * - Areas Tool (Representational): Marine bounding box spatial averages
 * - Import Tool (Representational): Custom dataset dropzone (.nc / .csv / .geojson)
 * - Settings Tool (Representational): Display settings and 2D/3D projection toggle
 * - Projection Toggle: Quick 2D/3D toggle
 */

import { useEffect, useRef, useState } from "react";
import {
  MapPin,
  /*
  Ruler,
  Square,
  UploadCloud,
  Settings2,
  Clock,
  FlaskConical,
  */
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
  // Internal state fallbacks if not supplied externally
  const [internalTool, setInternalTool] = useState<ToolMode>("none");
  const [internalProj, setInternalProj] = useState<ProjectionMode>("3d");
  const autoCloseTimerRef = useRef<number | null>(null);

  const activeTool = externalActiveTool ?? internalTool;
  const projectionMode = externalProjectionMode ?? internalProj;

  // Clear auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current !== null) {
        window.clearTimeout(autoCloseTimerRef.current);
      }
    };
  }, []);

  const handleSelectTool = (tool: ToolMode) => {
    // Clear any running auto-close timer
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

    // Auto-close representational tools after 2 seconds (lines, areas, import, settings)
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
        {/* Points Tool (Functional for Argo float points) */}
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

        {/* Temporarily commented out: lines, areas, import, settings */}
        {/*
        <button
          type="button"
          id="btn-tool-lines"
          onClick={() => handleSelectTool("lines")}
          className={`tool-dock-btn ${activeTool === "lines" ? "tool-dock-btn--active" : ""}`}
          title="Transect Line Tool (draw ocean cross-sections)"
        >
          <Ruler className="w-5 h-5" style={{ width: 20, height: 20 }} />
          <span className="tool-dock-btn-label">Lines</span>
        </button>

        <button
          type="button"
          id="btn-tool-areas"
          onClick={() => handleSelectTool("areas")}
          className={`tool-dock-btn ${activeTool === "areas" ? "tool-dock-btn--active" : ""}`}
          title="Area Polygon Tool (calculate regional marine averages)"
        >
          <Square className="w-5 h-5" style={{ width: 20, height: 20 }} />
          <span className="tool-dock-btn-label">Areas</span>
        </button>

        <button
          type="button"
          id="btn-tool-import"
          onClick={() => handleSelectTool("import")}
          className={`tool-dock-btn ${activeTool === "import" ? "tool-dock-btn--active" : ""}`}
          title="Import custom GeoJSON, NetCDF or CSV"
        >
          <UploadCloud className="w-5 h-5" style={{ width: 20, height: 20 }} />
          <span className="tool-dock-btn-label">Import</span>
        </button>

        <button
          type="button"
          id="btn-tool-settings"
          onClick={() => handleSelectTool("settings")}
          className={`tool-dock-btn ${activeTool === "settings" ? "tool-dock-btn--active" : ""}`}
          title="Display settings, 2D/3D projection, grid lines"
        >
          <Settings2 className="w-5 h-5" style={{ width: 20, height: 20 }} />
          <span className="tool-dock-btn-label">Settings</span>
        </button>
        */}

        <div className="tool-dock-divider" />

        {/* Quick Projection Mode Toggle (2D / 3D Globe) */}
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

      {/* Floating Side Drawer for Active Tool */}
      {activeTool !== "none" && (
        <div className={`tool-dock-drawer ${activeTool === "points" ? "tool-dock-drawer--points" : ""}`}>
          {/* POINTS DRAWER (FUNCTIONAL & EXPANDED) */}
          {activeTool === "points" && (
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

          {/* Commented out drawers: lines, areas, import, settings */}
          {/*
          {activeTool === "lines" && (
            <div>
              <div className="tool-dock-drawer-header">
                <span className="tool-dock-drawer-title">
                  <Ruler className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
                  Ocean Transects
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="tool-dock-testing-badge">
                    <FlaskConical style={{ width: 11, height: 11, color: "#f59e0b" }} />
                    Under Testing
                  </span>
                  <span className="tool-dock-timer-badge">
                    <Clock style={{ width: 10, height: 10 }} /> 2s
                  </span>
                </div>
              </div>
              <p className="tool-dock-drawer-desc">
                Draw a cross-section line across ocean basins (e.g. Bay of Bengal equatorial transect) to inspect vertical depth profiles.
              </p>
              <div className="tool-dock-stat-card">
                <div>Sample Transect: Bay of Bengal 15°N</div>
                <div>Length: 1,240 km</div>
                <div>Thermocline Depth: ~85 m</div>
              </div>
            </div>
          )}

          {activeTool === "areas" && (
            <div>
              <div className="tool-dock-drawer-header">
                <span className="tool-dock-drawer-title">
                  <Square className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
                  Regional Bounding Box
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="tool-dock-testing-badge">
                    <FlaskConical style={{ width: 11, height: 11, color: "#f59e0b" }} />
                    Under Testing
                  </span>
                  <span className="tool-dock-timer-badge">
                    <Clock style={{ width: 10, height: 10 }} /> 2s
                  </span>
                </div>
              </div>
              <p className="tool-dock-drawer-desc">
                Select a bounding box area to compute spatial mean, heat content anomalies, and cold wake signatures.
              </p>
              <div className="tool-dock-stat-card">
                <div>Selected: Cyclone Phailin Box</div>
                <div>Extents: 5.0–23.0°N, 78.0–95.0°E</div>
                <div>Area: ~3,180,000 km²</div>
              </div>
            </div>
          )}

          {activeTool === "import" && (
            <div>
              <div className="tool-dock-drawer-header">
                <span className="tool-dock-drawer-title">
                  <UploadCloud className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
                  Import Marine Data
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="tool-dock-testing-badge">
                    <FlaskConical style={{ width: 11, height: 11, color: "#f59e0b" }} />
                    Under Testing
                  </span>
                  <span className="tool-dock-timer-badge">
                    <Clock style={{ width: 10, height: 10 }} /> 2s
                  </span>
                </div>
              </div>
              <p className="tool-dock-drawer-desc">
                Upload in situ drifter tracks, glider profiles, or NetCDF/GeoJSON rasters.
              </p>
              <label className="tool-dock-dropzone">
                <UploadCloud className="w-6 h-6" style={{ width: 24, height: 24, color: "#94a3b8", marginBottom: 4 }} />
                <span style={{ fontSize: "11px", fontWeight: 600, color: "#22d3ee" }}>
                  Click or Drag NetCDF / GeoJSON / CSV
                </span>
                <span style={{ fontSize: "9px", color: "#64748b", marginTop: 2, fontFamily: "var(--font-readout, monospace)" }}>
                  Supports Argo floats, CTD casts, satellite tracks
                </span>
                <input
                  type="file"
                  style={{ display: "none" }}
                  accept=".csv,.geojson,.json,.nc"
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      alert(`Imported "${e.target.files[0].name}" successfully! Processed spatial coordinates.`);
                    }
                  }}
                />
              </label>
            </div>
          )}

          {activeTool === "settings" && (
            <div>
              <div className="tool-dock-drawer-header">
                <span className="tool-dock-drawer-title">
                  <Settings2 className="w-4 h-4" style={{ width: 16, height: 16, color: "#22d3ee" }} />
                  Visualization Settings
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="tool-dock-testing-badge">
                    <FlaskConical style={{ width: 11, height: 11, color: "#f59e0b" }} />
                    Under Testing
                  </span>
                  <span className="tool-dock-timer-badge">
                    <Clock style={{ width: 10, height: 10 }} /> 2s
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: "#cbd5e1" }}>Map Projection:</span>
                  <button
                    type="button"
                    onClick={handleToggleProj}
                    style={{
                      padding: "4px 10px",
                      background: "#1e293b",
                      border: "1px solid #334155",
                      color: "#22d3ee",
                      borderRadius: 4,
                      fontFamily: "var(--font-readout, monospace)",
                      fontWeight: 700,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {projectionMode === "2d" ? "2D Flat Map" : "3D Spherical Globe"}
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: "#cbd5e1" }}>Grid Lines:</span>
                  <button
                    type="button"
                    onClick={handleToggleGridInternal}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      border: 0,
                      cursor: "pointer",
                      background: showGrid ? "#06b6d4" : "#1e293b",
                      color: showGrid ? "#020617" : "#94a3b8",
                    }}
                  >
                    {showGrid ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={{ paddingTop: 8, borderTop: "1px solid #1e293b", fontSize: 10, color: "#64748b" }}>
                  Ocean 3D Platform · INCOIS MoES SIH 2026
                </div>
              </div>
            </div>
          )}
          */}
        </div>
      )}
    </div>
  );
}
