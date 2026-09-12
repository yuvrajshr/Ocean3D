/**
 * Floats reporting with the selected model run, as a keyboard-accessible list
 * (3D markers can't be tabbed to).
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
