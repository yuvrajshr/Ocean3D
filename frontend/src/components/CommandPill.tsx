/**
 * CommandPill.tsx — Top Navigation Bar for Ocean 3D
 *
 * Fixed top rectangular navigation bar containing:
 * - Circular logo mark
 * - Contextual title (truncating)
 * - Provenance/status dot with tooltip
 * - View mode segmented control (Map / Globe / Water column) always showing icon + name
 *
 * The Ops/Explore tabs were removed on 2026-09-08: they promised to hide advanced
 * controls that were never built, and two of their four behaviours were already
 * dead code. See context.md §5.1 Principle 4.
 */

import {
  Map as MapIcon,
  Globe as GlobeIcon,
  Waves as WavesIcon,
  MapPin,
} from "lucide-react";
import type { Scenario, SourceStatus } from "../api/client";
import type { SceneView } from "../viz/scene";
import "../styles/command-pill.css";

export type AppView = SceneView | "map";

export interface CommandPillProps {
  scenario: Scenario | null;
  source: SourceStatus | null;
  mapLoadingLabel: string | null;
  provenanceLabel: string;
  view: AppView;
  onViewChange: (view: AppView) => void;
  entryDone: boolean;
  pointsCount?: number;
  isPointsOpen?: boolean;
  onTogglePoints?: () => void;
  /** True when at least one map layer exists — distinguishes "waiting for first
   *  slice" (loading) from "genuinely unreachable" (offline). */
  hasLayers?: boolean;
}

export function CommandPill({
  scenario,
  source,
  mapLoadingLabel,
  provenanceLabel,
  view,
  onViewChange,
  entryDone,
  pointsCount,
  isPointsOpen,
  onTogglePoints,
  hasLayers = false,
}: CommandPillProps) {
  // Status dot: "loading" wins when data is in flight OR when we have layers
  // but the first slice hasn't returned yet (Copernicus takes ~10-15s on cold
  // start). Without this, a freshly-added Copernicus layer reads as OFFLINE
  // for 15 s while it's actually just fetching.
  const statusType = mapLoadingLabel || (!source && hasLayers)
    ? "loading"
    : !source
      ? "offline"
      : source.provenance === "live"
        ? "live"
        : "cached";

  const fullStatusText = mapLoadingLabel ?? provenanceLabel;

  // View mode options
  const viewModes: { id: AppView; label: string; icon: typeof MapIcon }[] = [
    { id: "map", label: "Map", icon: MapIcon },
    { id: "globe", label: "Globe", icon: GlobeIcon },
    { id: "column", label: "Water column", icon: WavesIcon },
  ];

  return (
    <nav className="command-pill-container" role="navigation" aria-label="Main Navigation">
      <div className="command-pill">
        {/* 1. Ratio Brand Block with 3px Red Vertical Rule */}
        <div className="command-pill__brand">
          <div className="command-pill__logo" title="INCOIS · Ocean 3D">
            <img
              src="/incois-logo-128.png"
              alt="INCOIS"
              className="command-pill__logo-img"
            />
          </div>
          <span className="command-pill__brand-name">OCEAN3D</span>
          <span className="command-pill__red-rule" aria-hidden="true" />
          <div className="command-pill__sub-brand">
            <span className="command-pill__org-tag">INCOIS · ERDDAP</span>
            <span className="command-pill__title-sub">
              {scenario ? `${scenario.title}` : "INDIAN OCEAN"}
            </span>
          </div>
        </div>

        {/* 3. Status Beacon */}
        <div
          className="command-pill__status-wrap"
          title={fullStatusText}
          aria-label={fullStatusText}
        >
          <span className={`command-pill__status-beacon command-pill__status-beacon--${statusType}`}>
            <span className="command-pill__status-beacon-pulse" />
            <span className="command-pill__status-beacon-core" />
          </span>
          <span className="command-pill__status-label">
            {statusType === "live" ? "STREAM" : statusType === "cached" ? "CACHED" : statusType === "loading" ? "FETCHING" : "OFFLINE"}
          </span>
          <div className="command-pill__status-tooltip" role="tooltip">
            {fullStatusText}
          </div>
        </div>

        {/* 4. Navigation & Mode Controls Cluster (Aligned to Right End) */}
        <div className="command-pill__right-group">
          {/* View-Mode Segmented Control: always shows icon + name */}
          <div
            className="command-pill__view-rail"
            role="group"
            aria-label="View Mode"
          >
            {viewModes.map(({ id, label, icon: Icon }) => {
              const isActive = view === id;
              const isDisabled = !entryDone && (id === "globe" || id === "column");

              return (
                <button
                  key={id}
                  type="button"
                  id={`btn-view-${id}`}
                  className={`command-pill__view-btn command-pill__view-btn--${id} ${
                    isActive ? "command-pill__view-btn--active" : ""
                  }`}
                  aria-pressed={isActive}
                  aria-label={`${label} view`}
                  disabled={isDisabled}
                  onClick={() => onViewChange(id)}
                >
                  <span className="command-pill__view-icon">
                    <Icon size={16} strokeWidth={isActive ? 2.5 : 2} />
                  </span>
                  <span className="command-pill__view-label">{label}</span>
                </button>
              );
            })}
          </div>

          {/* Vertical Divider */}
          <div className="command-pill__divider" />

          {/* Points / In-Situ Floats Toggle */}
          {onTogglePoints && (
            <>
              <button
                type="button"
                id="btn-nav-points"
                className={`command-pill__points-btn ${
                  isPointsOpen ? "command-pill__points-btn--active" : ""
                }`}
                onClick={onTogglePoints}
                title="Inspect in-situ Argo float profiles"
                aria-pressed={isPointsOpen}
              >
                <span className="command-pill__points-icon">
                  <MapPin size={14} strokeWidth={isPointsOpen ? 2.5 : 2} />
                </span>
                <span className="command-pill__points-label">Floats</span>
                {pointsCount !== undefined && pointsCount > 0 && (
                  <span className="command-pill__points-badge">
                    <span className="command-pill__points-live-dot" />
                    {pointsCount}
                  </span>
                )}
              </button>

              <div className="command-pill__divider" />
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
