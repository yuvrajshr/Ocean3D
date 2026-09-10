/**
 * Observation against model for one platform, at the platform's own position
 * and the timeline's own date.
 *
 * This is the comparison the whole view exists for, so it is the only floating
 * element on the screen and it deliberately does not move the camera: the
 * reader keeps the 3D context they clicked from. Depth runs down the y axis in
 * true metres — the chart never inherits the viewport's stretched axis, because
 * two different depth scales on one screen is how a reader misreads a
 * thermocline.
 */

import { VARIABLES, dateLabel, type Profile, type VariableKey } from "../../viz/chunk/model";

/**
 * Either a real pair of curves, or the reason there is not one.
 *
 * "This float does not measure chlorophyll" is an answer worth showing, and a
 * different one from "the request failed" — both land here rather than leaving
 * the card empty or, worse, drawing one curve and letting the missing one read
 * as a gap in the data.
 */
export type ProfileView =
  | (Profile & { variable: VariableKey; unavailable?: undefined })
  | { unavailable: string; id: string; variable: VariableKey };

interface Props {
  profile: ProfileView;
  /** The model step the cast is being compared against, as a real stamp. */
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

  // A glider stops at 700 m, so its axis gets its own ticks rather than a
  // 2000 m ruler with everything crammed into the top third.
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

  // The cast's own time, not the model step it is being compared against. They
  // are usually a few hours apart and occasionally a day, and saying which is
  // which is the whole point of putting the two curves on one axis.
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
          {/* Striped, because the trace it stands for is dashed. Copper and
              advisory amber are near neighbours (context.md §10, 2026-09-08),
              so the legend carries the same non-colour cue the chart does. */}
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
          {/* The model is DASHED and the observation is solid. The two hues
              chosen for them — copper and advisory amber — are close enough
              that §10 (2026-09-08) records mistaking one for the other, so the
              dash carries the distinction and colour only reinforces it. This
              is §5.4's "never colour alone" applied to a chart. */}
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
