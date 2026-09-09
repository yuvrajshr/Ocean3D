/**
 * Chunk view — one 5°×5° block of ocean, 0–2000 m, opened from the globe.
 *
 * The globe answers "where"; this answers "what is in there". It is a full
 * screen of its own rather than a panel in the console because the question it
 * serves is different: not "what does the model say at this depth today" but
 * "what is the structure of this block of water, and does the instrument in it
 * agree". Everything on screen is derived from one scene spec, which the
 * inspector at the bottom right shows and edits live.
 *
 * React owns the spec and the chrome; ChunkEngine owns the renderer, the camera
 * and the picking. The two meet at exactly two places: the component mutates
 * the spec and calls commit, and the engine calls back with frame rate, hover
 * readouts and instrument picks.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { ChunkEngine, type HoverReadout } from "../../viz/chunk/engine";
import {
  GRID,
  VARIABLES,
  histogram,
  profile,
  type VariableKey,
} from "../../viz/chunk/model";
import { DEFAULT_SPEC, type PresetName } from "../../viz/chunk/spec";
import { FieldPanel } from "./FieldPanel";
import { LayerStackPanel } from "./LayerStackPanel";
import { ProfileCard, type ProfileView } from "./ProfileCard";
import { SpecInspector } from "./SpecInspector";
import { TimeBar } from "./TimeBar";
import { fmt } from "./util";

const PRESET_LABELS: [PresetName, string][] = [
  ["corner", "Corner"],
  ["top", "Top-down"],
  ["section", "Section"],
];

const SPEC_HINT = "Edit and press Apply. Layer types resolve through the registry.";

interface Props {
  /** Renders the breadcrumb's back control. Omitted, the crumb is read-only. */
  onBack?: () => void;
}

export function ChunkView({ onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ChunkEngine | null>(null);
  const specOpenRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const [fps, setFps] = useState(60);
  const [hover, setHover] = useState<HoverReadout | null>(null);
  const [prof, setProf] = useState<ProfileView | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ scalar: true });
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [specOpen, setSpecOpen] = useState(false);
  const [specText, setSpecText] = useState("");
  const [specMsg, setSpecMsg] = useState(SPEC_HINT);
  const [specOk, setSpecOk] = useState(true);

  const spec = engineRef.current?.spec ?? DEFAULT_SPEC;

  /* ---------------- engine lifecycle ---------------- */

  const openProfile = useCallback((id: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const variable = engine.spec.field.variable;
    setProf({ ...profile(id, engine.spec.time.index, variable), variable });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const ruler = rulerRef.current;
    if (!host || !ruler) return;

    let engine: ChunkEngine;
    try {
      engine = new ChunkEngine(host, ruler);
      engine.start();
    } catch (err) {
      // WebGL is the whole view here; say what happened and what to do rather
      // than leaving an empty black rectangle.
      console.error("chunk view failed to start", err);
      setError(
        "This browser cannot draw the chunk. The view needs WebGL2 — recent Chrome, Edge, " +
          "Firefox and Safari all have it, and enabling hardware acceleration usually brings " +
          "it back.",
      );
      return;
    }

    engine.onFps = setFps;
    engine.onHover = setHover;
    engine.onPickInstrument = (id) => {
      if (id) openProfile(id);
      else setProf(null);
    };
    engineRef.current = engine;
    setSpecText(JSON.stringify(engine.spec, null, 2));
    setReady(true);

    return () => {
      engine.dispose();
      engineRef.current = null;
      setReady(false);
    };
  }, [openProfile]);

  /* ---------------- spec edits ---------------- */

  /** Push spec changes into the scene, then re-render the chrome around it. */
  const commit = useCallback((rebuildAxis = false) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.commit(rebuildAxis);
    if (specOpenRef.current) setSpecText(JSON.stringify(engine.spec, null, 2));
    bump();
  }, []);

  const setTime = useCallback(
    (index: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.spec.time.index = index;
      commit();
      setProf((p) =>
        p ? { ...profile(p.id, index, engine.spec.field.variable), variable: p.variable } : null,
      );
    },
    [commit],
  );

  const setVariable = useCallback(
    (key: VariableKey) => {
      const engine = engineRef.current;
      if (!engine) return;
      const spec = engine.spec;
      const range = VARIABLES[key].range;
      spec.field.variable = key;
      spec.colorRange.palette = VARIABLES[key].palette;
      spec.colorRange.min = range[0];
      spec.colorRange.max = range[1];
      spec.colorRange.scale = "linear";
      // An isovalue carried over from another variable is meaningless — 20 °C
      // is not 20 PSU — so it re-centres in the new variable's range.
      const scalar = spec.layers.find((l) => l.id === "scalar");
      if (scalar?.props && scalar.props.mode === "isosurface") {
        scalar.props.isoValue = range[0] + (range[1] - range[0]) * 0.55;
      }
      commit();
      setProf((p) => (p ? { ...profile(p.id, spec.time.index, key), variable: key } : null));
    },
    [commit],
  );

  const setExaggeration = useCallback(
    (value: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.spec.view.exaggeration = value;
      // A group scale, so no geometry has to be rebuilt while the slider moves.
      engine.applyExaggeration();
      if (specOpenRef.current) setSpecText(JSON.stringify(engine.spec, null, 2));
      bump();
    },
    [],
  );

  const goPreset = useCallback((name: PresetName) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.goPreset(name);
    bump();
  }, []);

  const applySpec = useCallback(
    (text: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const result = engine.applySpec(text);
      setSpecOk(result.ok);
      setSpecMsg(result.message);
      setProf(null);
      bump();
    },
    [],
  );

  /* ---------------- playback ---------------- */

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      setTime((engine.spec.time.index + 1) % engine.spec.time.steps);
    }, 620 / playSpeed);
    return () => window.clearInterval(id);
  }, [playing, playSpeed, setTime]);

  useEffect(() => {
    specOpenRef.current = specOpen;
  }, [specOpen]);

  /* ---------------- derived ---------------- */

  const hist = useMemo(
    () => histogram(spec.field.variable, spec.time.index),
    [spec.field.variable, spec.time.index],
  );

  const bbox = spec.chunk.bbox;
  const extent = `${bbox[1]}°N–${bbox[3]}°N, ${bbox[0]}°E–${bbox[2]}°E`;
  const hoverInfo = hover ? VARIABLES[hover.variable] : null;

  return (
    <div className="chunk-view">
      <div className="chunk-view__depth" />
      <div className="chunk-view__glow" />
      <div className="chunk-view__canvas" ref={hostRef} />
      <div className="chunk-view__vignette" />
      <div className="chunk-ruler" ref={rulerRef} />

      {/* -------------------------------------------------------- breadcrumb */}
      <div className="chunk-crumb">
        <div className="chunk-crumb__body chunk-panel chunk-panel--strong">
          {onBack ? (
            <button
              type="button"
              className="chunk-crumb__back"
              onClick={onBack}
              aria-label="Back to the globe"
            >
              ←
            </button>
          ) : null}
          <div className="chunk-crumb__divider" />
          <div className="chunk-crumb__stack">
            <div className="chunk-crumb__row">
              <div className="chunk-crumb__mark">INCOIS</div>
              <div className="chunk-crumb__view">Chunk view</div>
            </div>
            <div className="chunk-crumb__path">
              <div className="chunk-crumb__parent">Globe</div>
              <div className="chunk-crumb__sep">/</div>
              <div className="chunk-crumb__extent">{extent}</div>
            </div>
          </div>
        </div>
        <div className="chunk-res chunk-panel chunk-panel--strong">
          <div className="chunk-res__pulse" />
          <div className="chunk-res__label">
            {`${GRID.nx}×${GRID.ny}×${GRID.nz}  ·  ${GRID.nt}D`}
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------- presets + map */}
      <div className="chunk-corner">
        <div className="chunk-presets chunk-panel chunk-panel--lifted" role="group" aria-label="Camera preset">
          {PRESET_LABELS.map(([id, label]) => {
            const on = spec.view.preset === id;
            return (
              <button
                key={id}
                type="button"
                className={`chunk-presets__btn${on ? " chunk-presets__btn--on" : ""}`}
                aria-pressed={on}
                onClick={() => goPreset(id)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="chunk-locator chunk-panel chunk-panel--lifted">
          {/* A wire globe with the analysis extent boxed on it — orientation,
              not a second map. Nothing is ever painted on this sphere. */}
          <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
            <circle cx="48" cy="48" r="40" fill="rgba(24,52,74,0.5)" stroke="rgba(126,166,196,0.3)" strokeWidth="0.8" />
            <ellipse cx="48" cy="48" rx="40" ry="13" fill="none" stroke="rgba(126,166,196,0.16)" strokeWidth="0.7" />
            <ellipse cx="48" cy="48" rx="36" ry="31" fill="none" stroke="rgba(126,166,196,0.11)" strokeWidth="0.7" />
            <ellipse cx="48" cy="48" rx="13" ry="40" fill="none" stroke="rgba(126,166,196,0.16)" strokeWidth="0.7" />
            <ellipse cx="48" cy="48" rx="31" ry="40" fill="none" stroke="rgba(126,166,196,0.11)" strokeWidth="0.7" />
            <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(126,166,196,0.3)" strokeWidth="0.8" />
            <rect x="54" y="40" width="12" height="12" fill="rgba(111,227,240,0.28)" stroke="#6fe3f0" strokeWidth="1.1" />
          </svg>
          <div className="chunk-locator__label">BAY OF BENGAL</div>
        </div>

        <div className="chunk-fps">{fps} FPS</div>
      </div>

      {ready ? (
        <>
          <LayerStackPanel
            spec={spec}
            expanded={expanded}
            selectedPlatform={prof?.id ?? null}
            onToggleExpand={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
            onCommit={commit}
            onExaggeration={setExaggeration}
            onOpenProfile={openProfile}
          />

          <FieldPanel spec={spec} hist={hist} onCommit={commit} onVariable={setVariable} />

          <TimeBar
            spec={spec}
            playing={playing}
            speed={playSpeed}
            specOpen={specOpen}
            onTogglePlay={() => setPlaying((p) => !p)}
            onSeek={setTime}
            onSpeed={setPlaySpeed}
            onToggleSpec={() => {
              const engine = engineRef.current;
              if (engine && !specOpen) setSpecText(JSON.stringify(engine.spec, null, 2));
              setSpecOpen((o) => !o);
            }}
          />
        </>
      ) : null}

      {hover && hoverInfo ? (
        <div className="chunk-hover" style={{ left: hover.x + "px", top: hover.y + "px" }}>
          <div className="chunk-hover__value">
            {`${hoverInfo.short} ${fmt(hover.val, hoverInfo.dec)} ${hoverInfo.unit}`}
          </div>
          <div className="chunk-hover__meta">
            {`${hover.lat.toFixed(3)}°N  ${hover.lon.toFixed(3)}°E`}
          </div>
          <div className="chunk-hover__meta">{`z  ${Math.round(hover.depth)} m`}</div>
        </div>
      ) : null}

      {specOpen ? (
        <SpecInspector
          text={specText}
          message={specMsg}
          ok={specOk}
          onEdit={setSpecText}
          onApply={() => applySpec(specText)}
          onReset={() => {
            const text = JSON.stringify(DEFAULT_SPEC, null, 2);
            setSpecText(text);
            applySpec(text);
          }}
        />
      ) : null}

      {prof ? (
        <ProfileCard profile={prof} timeIndex={spec.time.index} onClose={() => setProf(null)} />
      ) : null}

      {!ready ? (
        <div
          className={`chunk-loading${error ? " chunk-loading--error" : ""}`}
          role="status"
        >
          {error ?? `Loading chunk ${bbox[1]}N–${bbox[3]}N / ${bbox[0]}E–${bbox[2]}E`}
        </div>
      ) : null}
    </div>
  );
}
