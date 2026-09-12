/**
 * Top navigation bar: logo, title, status dot and the view switcher
 * (Map / Globe / Chunk).
 */

import {
  Map as MapIcon,
  Globe as GlobeIcon,
  Box as BoxIcon,
  MapPin,
} from "lucide-react";
import type { Scenario, SourceStatus } from "../api/client";
import type { SceneView } from "../viz/scene";
import "../styles/command-pill.css";

/** The chunk view has its own canvas, like the map. */
export type AppView = SceneView | "map" | "chunk";

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
  /**
   * True when at least one map layer exists, to tell "waiting for the first
   * slice" apart from "offline".
   */
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
  // Show "loading" while data is in flight, or when we have layers but the first
  // slice hasn't arrived yet (Copernicus can take 10-15 s on a cold start),
  // otherwise a new layer would briefly show as offline.
  const statusType = mapLoadingLabel || (!source && hasLayers)
    ? "loading"
    : !source
      ? "offline"
      : source.provenance === "live"
        ? "live"
        : "cached";

  const fullStatusText = mapLoadingLabel ?? provenanceLabel;

  // View buttons. The water column isn't in the list anymore; the chunk view
  // covers it and is also opened by clicking the globe.
  const viewModes: { id: AppView; label: string; icon: typeof MapIcon }[] = [
    { id: "map", label: "Map", icon: MapIcon },
    { id: "globe", label: "Globe", icon: GlobeIcon },
    { id: "chunk", label: "Chunk", icon: BoxIcon },
  ];

  return (
    <nav className="command-pill-container" role="navigation" aria-label="Main Navigation">
      <div className="command-pill">
        {/* brand */}
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

        {/* status */}
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

        {/* view controls */}
        <div className="command-pill__right-group">
          <div
            className="command-pill__view-rail"
            role="group"
            aria-label="View Mode"
          >
            {viewModes.map(({ id, label, icon: Icon }) => {
              const isActive = view === id;
              const isDisabled = !entryDone && id === "globe";

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

          <div className="command-pill__divider" />

          {/* floats toggle */}
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
