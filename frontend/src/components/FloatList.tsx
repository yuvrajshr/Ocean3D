/**
 * The floats reporting alongside the selected model run.
 *
 * This exists because a marker in a 3D scene cannot be reached with a keyboard.
 * Rather than bolt synthetic focus onto the canvas, the same selection is
 * offered as a real list — which turns out to be the faster path for a
 * forecaster who already knows which platform they want, and it doubles as the
 * scene's accessible name for the markers.
 */

import type { PlatformSummary } from "../api/client";

interface FloatListProps {
  platforms: PlatformSummary[];
  featured: Set<string>;
  selectedId: string | null;
  onSelect: (platform: PlatformSummary) => void;
}

export function FloatList({ platforms, featured, selectedId, onSelect }: FloatListProps) {
  if (platforms.length === 0) {
    return (
      <p className="float-list__empty">
        No Argo or Glider data in this window — try another date on the timeline.
      </p>
    );
  }

  return (
    <ul className="float-list">
      {platforms.map((platform) => {
        const isFeatured = featured.has(platform.platform_id);
        return (
          <li key={`${platform.platform_id}-${platform.cycle_number ?? 0}`}>
            <button
              type="button"
              className="float-list__item"
              aria-pressed={platform.platform_id === selectedId}
              onClick={() => onSelect(platform)}
            >
              <span
                className={`float-list__pip${isFeatured ? " float-list__pip--featured" : ""}`}
                aria-hidden="true"
              />
              <span className="float-list__id readout">{platform.platform_id}</span>
              <span className="float-list__depth readout">
                {platform.max_depth !== null ? `${Math.round(platform.max_depth)} m` : "—"}
              </span>
              {isFeatured ? <span className="sr-only">Featured in this scenario</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
