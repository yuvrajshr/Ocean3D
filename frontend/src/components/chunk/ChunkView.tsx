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

import { ApiError, api } from "../../api/client";
import { ChunkEngine, type HoverReadout } from "../../viz/chunk/engine";
import { ChunkStore, dailyWindow, type Bbox } from "../../viz/chunk/loader";
import { resolveRegionName } from "../../viz/chunk/oceanRegions";
import { VARIABLES, dateLabel, type VariableKey } from "../../viz/chunk/model";
import { buildProfile } from "../../viz/chunk/profile";
import type { ChunkPlatform, ChunkSource } from "../../viz/chunk/source";
import { CHUNK_FOCUS_DATE, CHUNK_WINDOW_STEPS, DEFAULT_SPEC, type PresetName } from "../../viz/chunk/spec";
import {
  applyChunkAction,
  describeChunkSpec,
  type ChunkController,
} from "../../assistant/chunkActions";
import { FieldPanel } from "./FieldPanel";
import { LayerStackPanel } from "./LayerStackPanel";
import { ProfileCard, type ProfileView } from "./ProfileCard";
import { ScalarFieldPanel } from "./ScalarFieldPanel";
import { SpecInspector } from "./SpecInspector";
import { TimeBar } from "./TimeBar";
import { fmt } from "./util";

const PRESET_LABELS: [PresetName, string][] = [
  ["corner", "Corner"],
  ["top", "Top-down"],
  ["section", "Section"],
];

const SPEC_HINT = "Edit and press Apply. Layer types resolve through the registry.";

/**
 * The window the chunk opens on: thirty daily steps centred on Cyclone Phailin.
 *
 * HYCOM is daily and runs 1994-2015, so this is inside its coverage, and it is
 * where the Argo floats the comparison needs actually are.
 */
const FOCUS_DATE = CHUNK_FOCUS_DATE;
const WINDOW_STEPS = CHUNK_WINDOW_STEPS;

interface Props {
  /** Renders the breadcrumb's back control. Omitted, the crumb is read-only. */
  onBack?: () => void;
  /** The tile to open, already snapped. Defaults to the Bay of Bengal chunk. */
  bbox?: Bbox;
  /** Set when the click's own tile had no coverage and we stepped outward. */
  movedFrom?: string | null;
  /**
   * Receives the assistant's handle on this view once the engine is ready, and
   * null on unmount. Through it the assistant reads and changes THIS view's
   * scene, by the same rules the panels use (assistant/chunkActions.ts).
   */
  onAssistantController?: (controller: ChunkController | null) => void;
  /** Open the tile containing a point: the assistant's "move north" and friends. */
  onMove?: (lat: number, lon: number) => void;
}

export function ChunkView({
  onBack,
  bbox: requested,
  movedFrom = null,
  onAssistantController,
  onMove,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ChunkEngine | null>(null);
  const specOpenRef = useRef(false);
  const openProfileRef = useRef<(id: string) => void>(() => undefined);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const [, setFps] = useState(60);
  const [hover, setHover] = useState<HoverReadout | null>(null);
  const [prof, setProf] = useState<ProfileView | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ scalar: true });
  const [layersOpen, setLayersOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [specOpen, setSpecOpen] = useState(false);
  const [specText, setSpecText] = useState("");
  const [specMsg, setSpecMsg] = useState(SPEC_HINT);
  const [specOk, setSpecOk] = useState(true);

  const storeRef = useRef(new ChunkStore());
  const [source, setSource] = useState<ChunkSource | null>(null);
  const [platforms, setPlatforms] = useState<ChunkPlatform[]>([]);
  const platformsRef = useRef<ChunkPlatform[]>(platforms);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const bbox = useMemo<Bbox>(() => requested ?? [85, 10, 90, 15], [requested]);
  const times = useMemo(() => dailyWindow(FOCUS_DATE, WINDOW_STEPS), []);

  const spec = engineRef.current?.spec ?? DEFAULT_SPEC;

  /* ---------------- engine lifecycle ---------------- */

  /**
   * Fetch one float's cast and pair it with the model column beside it.
   *
   * The cast is a request, not a lookup — the platform list carries positions
   * and level counts, but the measured levels themselves only come when someone
   * asks for one float.
   */
  const openProfile = useCallback(
    (id: string) => {
      const engine = engineRef.current;
      const data = engine?.chunk;
      if (!engine || !data) return;
      const variable = engine.spec.field.variable;
      const platform = platforms.find((p) => p.id === id);
      const step = engine.spec.time.index;
      let fix = platform?.fixes[0];
      for (const f of platform?.fixes ?? []) {
        if (f.step <= step) fix = f;
      }
      void (async () => {
        try {
          const cast = await api.profile(id, {
            cycle: fix?.cycle ?? undefined,
            time_start: times[0],
            time_end: times[times.length - 1],
            lat_min: bbox[1],
            lat_max: bbox[3],
            lon_min: bbox[0],
            lon_max: bbox[2],
          });
          const built = buildProfile(data, cast, variable);
          setProf(
            built
              ? { ...built, variable }
              : {
                // Nothing to compare is a real answer, not a failure: a core
                // Argo float measures temperature and salinity and nothing else.
                unavailable: `${VARIABLES[variable].label} is not measured by ${id}. Argo core floats report temperature and salinity.`,
                id,
                variable,
              },
          );
        } catch (error) {
          setProf({
            unavailable:
              error instanceof ApiError
                ? error.message
                : `Could not load the cast for ${id}.`,
            id,
            variable,
          });
        }
      })();
    },
    [platforms, times, bbox],
  );

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
      // Called through a ref, not captured directly. `openProfile` changes
      // identity whenever the platform list does, and holding it as a dependency
      // of this effect tore the WebGL context down and rebuilt it the moment the
      // instrument fetch returned — which aborted the chunk request in flight
      // and left the view empty. The engine is created once and disposed once.
      if (id) openProfileRef.current(id);
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
  }, []);

  useEffect(() => {
    openProfileRef.current = openProfile;
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
      // The open cast is re-paired against the new variable, which may well be
      // one the instrument does not measure.
      setProf((p) => (p ? { ...p, variable: key } : null));
      if (prof) openProfile(prof.id);
    },
    [commit, prof, openProfile],
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

  /* ---------------- loading ---------------- */

  /**
   * The chunk itself: one variable at one step.
   *
   * Re-runs on every scrub, and the store answers from memory when the step was
   * already warmed. `setData` is what actually puts it on screen — until the
   * first one lands the engine draws nothing at all, rather than an empty box.
   */
  useEffect(() => {
    if (!ready) return;
    const engine = engineRef.current;
    if (!engine) return;
    const variable = spec.field.variable;
    const time = times[spec.time.index];
    if (!time) return;

    const store = storeRef.current;
    const warm = store.peek(bbox, variable, time);
    if (warm) {
      engine.setData(warm, platformsRef.current);
      setSource(warm);
      setLoading(false);
      setLoadError(null);
      store.prefetch(bbox, variable, times, spec.time.index);
      bump();
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const loaded = await store.load(bbox, variable, time);
        if (controller.signal.aborted) return;
        engine.setData(loaded, platformsRef.current);
        setSource(loaded);
        setLoadError(null);
        setLoading(false);
        store.prefetch(bbox, variable, times, spec.time.index);
        bump();
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoading(false);
        const step = dateLabel(time);
        setLoadError(
          error instanceof ApiError
            ? `${step}: ${error.message}`
            : "Could not reach the ocean-viz backend. Start it with: uvicorn app.main:app",
        );
      }
    })();
    return () => controller.abort();
    // `spec` is mutated in place by the engine, so the primitives it turns on
    // are the dependencies — the object identity never changes. `platforms` is
    // read through a ref rather than depended on: floats arriving must not
    // restart a field request that is already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bbox, times, spec.field.variable, spec.time.index]);

  /**
   * Argo platforms in this tile and window.
   *
   * One request for the whole window rather than one per step: `/api/instruments`
   * returns a row per platform *and* cycle, which is exactly the surfacing track
   * the layer draws. The measured levels behind each fix are fetched only when
   * someone opens one.
   */
  useEffect(() => {
    const first = times[0];
    const last = times[times.length - 1];
    if (!first || !last) return;
    const controller = new AbortController();
    (async () => {
      try {
        const list = await api.instruments(
          {
            time_start: first,
            time_end: last,
            lat_min: bbox[1],
            lat_max: bbox[3],
            lon_min: bbox[0],
            lon_max: bbox[2],
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const byId = new Map<string, ChunkPlatform>();
        for (const row of list.platforms) {
          const day = row.time.slice(0, 10);
          // Resolve each fix to a step once, here, where the window is known.
          let step = 0;
          let best = Infinity;
          for (let i = 0; i < times.length; i++) {
            const gap = Math.abs(Date.parse(times[i]!) - Date.parse(day));
            if (gap < best) {
              best = gap;
              step = i;
            }
          }
          const entry = byId.get(row.platform_id) ?? {
            id: row.platform_id,
            type: row.platform_type,
            fixes: [],
          };
          entry.fixes.push({
            cycle: row.cycle_number,
            time: row.time,
            step,
            lon: row.lon,
            lat: row.lat,
            maxDepth: row.max_depth,
            nLevels: row.n_levels,
            surfaceTemperature: row.surface_temperature,
          });
          byId.set(row.platform_id, entry);
        }
        for (const entry of byId.values()) {
          entry.fixes.sort((a, b) => a.time.localeCompare(b.time));
        }
        const resolved = [...byId.values()];
        platformsRef.current = resolved;
        setPlatforms(resolved);
        // Push them into the scene directly. The field is unaffected, so this
        // must not go through the load effect.
        const engine = engineRef.current;
        const data = engine?.chunk;
        if (engine && data) engine.setData(data, resolved);
      } catch {
        // Markers are additive: the chunk still stands without them, exactly as
        // the water column already treats a failed instrument fetch.
        if (!controller.signal.aborted) {
          platformsRef.current = [];
          setPlatforms([]);
        }
      }
    })();
    return () => controller.abort();
  }, [bbox, times]);

  /* ---------------- playback ---------------- */

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const variable = engine.spec.field.variable;
      const store = storeRef.current;
      // Advance onto the next step that can actually be drawn. A step still in
      // flight is worth waiting for; one the upstream cannot build is not, and
      // stalling on it would freeze playback for good.
      for (let d = 1; d <= times.length; d++) {
        const next = (engine.spec.time.index + d) % times.length;
        const time = times[next];
        if (!time) return;
        if (store.isBroken(bbox, variable, time)) continue;
        if (!store.has(bbox, variable, time)) return;
        setTime(next);
        return;
      }
    }, 620 / playSpeed);
    return () => window.clearInterval(id);
  }, [playing, playSpeed, setTime, times, bbox]);

  useEffect(() => {
    specOpenRef.current = specOpen;
  }, [specOpen]);

  /* ---------------- derived ---------------- */

  const hist = useMemo(() => source?.histogram() ?? null, [source]);

  /* ---------------- the assistant's handle ---------------- */

  // Latest values, read by the controller rather than captured: it is created
  // once per engine and called seconds after the render that made it.
  const profRef = useRef(prof);
  const histRef = useRef(hist);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    profRef.current = prof;
    histRef.current = hist;
    onMoveRef.current = onMove;
  });

  useEffect(() => {
    if (!ready || !onAssistantController) return;
    const controller: ChunkController = {
      getState: () =>
        describeChunkSpec(
          engineRef.current?.spec ?? DEFAULT_SPEC,
          times,
          bbox,
          true,
          platformsRef.current.map((p) => p.id),
          profRef.current?.id ?? null,
        ),
      apply: (action) => {
        const engine = engineRef.current;
        if (!engine) return;
        const h = histRef.current;
        const effect = applyChunkAction(engine.spec, action, {
          times,
          hist: h ? { lo: h.lo, hi: h.hi } : null,
        });
        engine.spec = effect.spec;
        if (effect.exaggeration) engine.applyExaggeration();
        if (effect.preset) engine.goPreset(effect.preset);
        commit();
        if (effect.variableChanged) {
          // Re-pair an open cast against the new field, as the panel does.
          const open = profRef.current;
          setProf((p) => (p ? { ...p, variable: effect.variableChanged! } : null));
          if (open) openProfileRef.current(open.id);
        }
        // The same path a click on a float's track takes.
        if (effect.openFloat) openProfileRef.current(effect.openFloat);
        if (effect.move) onMoveRef.current?.(effect.move.lat, effect.move.lon);
      },
      snapshot: () => ({ spec: structuredClone(engineRef.current?.spec ?? DEFAULT_SPEC) }),
      restore: ({ spec: saved }) => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.spec = structuredClone(saved);
        engine.applyExaggeration();
        engine.goPreset(engine.spec.view.preset);
        commit(true);
      },
    };
    onAssistantController(controller);
    return () => onAssistantController(null);
  }, [ready, times, bbox, onAssistantController, commit]);

  const extent = `${bbox[1]}°N–${bbox[3]}°N, ${bbox[0]}°E–${bbox[2]}°E`;
  const regionName = resolveRegionName(bbox);
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
        {ready && source && hist ? (
          <FieldPanel spec={spec} hist={hist} onCommit={commit} onVariable={setVariable} />
        ) : null}
      </div>

      {/* --------------------------------------------------- region label */}
      <div className="chunk-region">
        <div className="chunk-region__name">{regionName}</div>
        <div className="chunk-region__coords">{extent}</div>
      </div>

      {/* --------------------------------------------- scalar field + layers */}
      <div className="chunk-stack">
        {ready && source ? (
          <ScalarFieldPanel
            spec={spec}
            source={source}
            expanded={!!expanded.scalar}
            onToggleExpand={() => setExpanded((e) => ({ ...e, scalar: !e.scalar }))}
            onCommit={commit}
          />
        ) : null}

        {ready && source && hist ? (
          <LayerStackPanel
            spec={spec}
            source={source}
            platforms={platforms}
            expanded={expanded}
            open={layersOpen}
            selectedPlatform={prof?.id ?? null}
            onToggleOpen={() => setLayersOpen((o) => !o)}
            onToggleExpand={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
            onCommit={commit}
            onExaggeration={setExaggeration}
            onOpenProfile={openProfile}
          />
        ) : null}
      </div>

      {ready && source && hist ? (
        <TimeBar
          spec={spec}
          times={times}
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
      ) : null}

      {hover && hoverInfo ? (
        <div className="chunk-hover" style={{ left: hover.x + "px", top: hover.y + "px" }}>
          <div className="chunk-hover__value">
            {Number.isFinite(hover.val)
              ? `${hoverInfo.short} ${fmt(hover.val, hoverInfo.dec)} ${source?.meta.units ?? hoverInfo.unit}`
              : "no data here"}
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
        <ProfileCard
          profile={prof}
          modelTime={source?.meta.time ?? times[spec.time.index] ?? ""}
          onClose={() => setProf(null)}
        />
      ) : null}

      {movedFrom ? (
        <div className="chunk-notice" role="status">
          {movedFrom}
        </div>
      ) : null}

      {ready && source && loadError ? (
        <div className="chunk-notice chunk-notice--warn" role="status">
          {loadError}
        </div>
      ) : null}

      {!ready || (!source && loadError) || (!source && !loading) ? (
        <div
          className={`chunk-loading${error || loadError ? " chunk-loading--error" : ""}`}
          role="status"
        >
          {error ??
            loadError ??
            `Loading ${VARIABLES[spec.field.variable].label.toLowerCase()} for ` +
            `${bbox[1]}°N–${bbox[3]}°N, ${bbox[0]}°E–${bbox[2]}°E…`}
        </div>
      ) : loading ? (
        <div className="chunk-loading chunk-loading--inline" role="status">
          {`Loading ${dateLabel(times[spec.time.index] ?? "")}…`}
        </div>
      ) : null}
    </div>
  );
}
