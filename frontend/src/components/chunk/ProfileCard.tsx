/**
 * Observation vs model for one platform, at its position and the timeline's date.
 *
 * It doesn't move the camera, so you keep the 3D view you clicked from. Depth is
 * in true metres on the y axis (not the viewport's stretched axis), so there's
 * only one depth scale to read.
 */

import { VARIABLES, dateLabel, type Profile, type VariableKey } from "../../viz/chunk/model";

/**
 * Either a pair of curves, or the reason there isn't one ("this float doesn't
 * measure chlorophyll" is different from "the request failed").
 */
export type ProfileView =
  | (Profile & { variable: VariableKey; unavailable?: undefined })
  | { unavailable: string; id: string; variable: VariableKey };

interface Props {
  profile: ProfileView;
  /** The model step the profile is compared against. */
  modelTime: string;
  onClose: () => void;
}

const PLOT = { left: 46, top: 10, width: 300, height: 266 };

export function ProfileCard({ profile, modelTime, onClose }: Props) {
  const info = VARIABLES[profile.variable];

  if (profile.unavailable !== undefined) {
    return (
      <div className="chunk-profile" role="dialog" aria-label={`Profile for ${profile.id}`}>
        <div className="chunk-profile__head">
          <div style={{ flex: 1 }}>
            <div className="chunk-profile__id">{profile.id}</div>
            <div className="chunk-profile__meta">{info.label}</div>
          </div>
          <button
            type="button"
            className="chunk-profile__close"
            onClick={onClose}
            aria-label="Close profile"
          >
            ×
          </button>
        </div>
        <div className="chunk-profile__empty">{profile.unavailable}</div>
      </div>
    );
  }

  const all = profile.obs.concat(profile.model).map((p) => p[0]);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 0.5;
  lo -= pad;
  hi += pad;

  const X = (v: number): number => PLOT.left + ((v - lo) / (hi - lo)) * PLOT.width;
  const Y = (d: number): number => PLOT.top + (d / profile.top) * PLOT.height;
  const points = (arr: [number, number][]): string =>
    arr.map((p) => X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ");

  // Gliders stop at 700 m, so use ticks for their range instead of 2000 m.
  const tickDepths =
    profile.top < 900 ? [0, 100, 200, 300, 500, 700] : [0, 200, 500, 1000, 1500, 2000];
  const yTicks = tickDepths
    .filter((d) => d <= profile.top)
    .map((d) => ({ y: Y(d).toFixed(1), ty: (Y(d) + 3).toFixed(1), label: String(d) }));

  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const v = lo + (hi - lo) * (i / 4);
    return { x: X(v).toFixed(1), label: v.toFixed(info.dec === 3 ? 2 : 1) };
  });

  let sum = 0;
  for (let i = 0; i < profile.obs.length; i++) {
    sum += Math.pow(profile.obs[i]![0] - profile.model[i]![0], 2);
  }
  const rmsd = Math.sqrt(sum / profile.obs.length).toFixed(3) + " " + info.unit;

  // Show the profile's own time, not the model step; they're usually a few hours
  // apart, sometimes a day.
  const platformLabel = profile.type === "argo_float" ? "Argo float" : profile.type;
  const cycle = profile.cycle === null ? "" : ` · cycle ${profile.cycle}`;
  const meta =
    platformLabel +
    cycle +
    " · " +
    profile.lat.toFixed(3) +
    "°N " +
    profile.lon.toFixed(3) +
    "°E · " +
    dateLabel(profile.observedTime) +
    (profile.observedTime.slice(0, 10) === modelTime.slice(0, 10)
      ? ""
      : ` · model ${dateLabel(modelTime)}`);

  return (
    <div className="chunk-profile" role="dialog" aria-label={`Profile for ${profile.id}`}>
      <div className="chunk-profile__head">
        <div style={{ flex: 1 }}>
          <div className="chunk-profile__id">{profile.id}</div>
          <div className="chunk-profile__meta">{meta}</div>
        </div>
        <button
          type="button"
          className="chunk-profile__close"
          onClick={onClose}
          aria-label="Close profile"
        >
          ×
        </button>
      </div>

      <div className="chunk-profile__legend">
        <div className="chunk-profile__key">
          <div className="chunk-profile__swatch" style={{ background: "var(--cv-accent)" }} />
          <div className="chunk-profile__key-label">Observed</div>
        </div>
        <div className="chunk-profile__key">
          {/* Striped to match the dashed model line; copper and amber are hard to tell apart */}
          <div className="chunk-profile__swatch chunk-profile__swatch--model" />
          <div className="chunk-profile__key-label">Model</div>
        </div>
        <div className="chunk-profile__rmsd">RMSD {rmsd}</div>
      </div>

      <div className="chunk-profile__chart">
        <svg viewBox="0 0 366 316">
          <rect
            x="46"
            y="10"
            width="300"
            height="266"
            fill="var(--cv-inset)"
            stroke="var(--cv-edge)"
            strokeWidth="0.7"
          />
          {yTicks.map((tk) => (
            <g key={tk.label}>
              <line
                x1="46"
                y1={tk.y}
                x2="346"
                y2={tk.y}
                stroke="var(--cv-rule-faint)"
                strokeWidth="0.7"
              />
              <text
                x="40"
                y={tk.ty}
                textAnchor="end"
                fill="var(--cv-ink-caption)"
                style={{ fontFamily: "var(--cv-mono)" }}
                fontSize="9"
              >
                {tk.label}
              </text>
            </g>
          ))}
          {xTicks.map((tk) => (
            <g key={tk.x}>
              <line
                x1={tk.x}
                y1="10"
                x2={tk.x}
                y2="276"
                stroke="var(--cv-rule-faint)"
                strokeWidth="0.7"
              />
              <text
                x={tk.x}
                y="291"
                textAnchor="middle"
                fill="var(--cv-ink-caption)"
                style={{ fontFamily: "var(--cv-mono)" }}
                fontSize="9"
              >
                {tk.label}
              </text>
            </g>
          ))}
          {/* Model is dashed, observation solid; the colours are too close to rely on alone */}
          <polyline
            points={points(profile.model)}
            fill="none"
            stroke="var(--cv-model)"
            strokeWidth="1.6"
            strokeDasharray="4 2.5"
            strokeLinejoin="round"
          />
          <polyline
            points={points(profile.obs)}
            fill="none"
            stroke="var(--cv-accent)"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <text
            x="196"
            y="308"
            textAnchor="middle"
            fill="var(--cv-ink-faint)"
            style={{ fontFamily: "var(--cv-mono)" }}
            fontSize="9"
            letterSpacing="1.4"
          >
            {info.label.toUpperCase() + " (" + info.unit + ")"}
          </text>
          <text
            x="13"
            y="143"
            textAnchor="middle"
            fill="var(--cv-ink-faint)"
            style={{ fontFamily: "var(--cv-mono)" }}
            fontSize="9"
            letterSpacing="1.4"
            transform="rotate(-90 13 143)"
          >
            DEPTH (m)
          </text>
        </svg>
      </div>
    </div>
  );
}
