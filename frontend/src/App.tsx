import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  ApiError,
  type Comparison,
  type FieldMeta,
  type InstrumentList,
  type PlatformSummary,
  type Scenario,
  type SourceStatus,
  type VariableInfo,
} from "./api/client";
import { Colorbar } from "./components/Colorbar";
import { DepthRuler } from "./components/DepthRuler";
import { FloatList } from "./components/FloatList";
import { ProfilePanel } from "./components/ProfilePanel";
import { Timeline } from "./components/Timeline";
import { VariablePanel } from "./components/VariablePanel";
import { MAX_DEPTH } from "./viz/depth";
import { BASEMAPS } from "./viz/globe";
import {
  isWebGL2Available,
  OceanScene,
  type MarkerDatum,
  type SceneView,
} from "./viz/scene";

type Mode = "ops" | "explore";

/** Floats within half a model step of the current run are "concurrent" with it. */
const MARKER_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const PLAY_INTERVAL_MS = 1100;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OceanScene | null>(null);

  const [webglReady] = useState(isWebGL2Available);
  const [mode, setMode] = useState<Mode>("ops");
  const [view, setView] = useState<SceneView>("column");
  const [entryDone, setEntryDone] = useState(false);

  const [variables, setVariables] = useState<VariableInfo[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [variableKey, setVariableKey] = useState("temperature");
  const [timeIndex, setTimeIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [fieldMeta, setFieldMeta] = useState<FieldMeta | null>(null);
  const [fieldLoading, setFieldLoading] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const [instruments, setInstruments] = useState<InstrumentList | null>(null);
  const [selected, setSelected] = useState<PlatformSummary | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<MarkerDatum | null>(null);

  const [depthWindow, setDepthWindow] = useState<[number, number]>([0, MAX_DEPTH]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [exaggeration, setExaggeration] = useState(0);

  /**
   * Switch view. Returning to the column replays the descent, so `entryDone` is reset and
   * the existing "Skip intro" control comes back with it.
   */
  const handleView = useCallback((next: SceneView) => {
    setView(next);
    if (next === "globe") {
      sceneRef.current?.enterGlobe();
    } else {
      setEntryDone(false);
      sceneRef.current?.enterColumn();
    }
  }, []);

  const activeVariable = variables.find((v) => v.key === variableKey);
  const currentTime = scenario?.timesteps[timeIndex];

  // ------------------------------------------------------------ scene setup

  useEffect(() => {
    if (!webglReady || !canvasRef.current) return;
    const scene = new OceanScene(canvasRef.current);
    sceneRef.current = scene;

    scene.onHover = setHovered;
    scene.onEntryComplete = () => setEntryDone(true);
    // The scene can change view on its own — clicking the region on the globe dives in.
    scene.onViewChange = setView;

    // Exposed so the screenshot harness can read a real frame rate. CLAUDE.md
    // treats a janky 3D scene as a bug, which means it has to be measured
    // rather than eyeballed.
    (window as unknown as { __oceanScene?: OceanScene }).__oceanScene = scene;

    const observer = new ResizeObserver(() => scene.resize());
    if (canvasRef.current.parentElement) observer.observe(canvasRef.current.parentElement);

    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [webglReady]);

  // ------------------------------------------------------------- catalog load

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const [vars, scenarios] = await Promise.all([
          api.variables(controller.signal),
          api.scenarios(controller.signal),
        ]);
        setVariables(vars);
        const first = scenarios[0];
        if (!first) {
          setBootError("No scenarios are configured on the server.");
          return;
        }
        setScenario(first);
        const focusIndex = first.timesteps.findIndex((t) => t.slice(0, 10) >= first.focus_time);
        setTimeIndex(focusIndex >= 0 ? focusIndex : Math.max(0, first.timesteps.length - 1));

        sceneRef.current?.setExtent({ latRange: first.lat_range, lonRange: first.lon_range });
        sceneRef.current?.setBasemap(
          BASEMAPS[first.basemap as keyof typeof BASEMAPS] ?? BASEMAPS.october,
        );
        sceneRef.current?.startEntry();

        // The relief is context, not the subject: if it fails, the analysis
        // still renders and the app stays usable.
        try {
          const relief = await api.terrainMeta(controller.signal);
          const elevation = await api.terrainData(relief, controller.signal);
          if (!controller.signal.aborted) {
            sceneRef.current?.setTerrain({
              lat: relief.lat,
              lon: relief.lon,
              shape: relief.shape,
              elevation,
              minElevation: relief.min_elevation,
              maxElevation: relief.max_elevation,
            });
            setExaggeration(sceneRef.current?.verticalExaggeration ?? 0);
          }
        } catch {
          /* no relief; the water column stands on its own */
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setBootError(
          error instanceof ApiError
            ? error.message
            : "Could not reach the ocean-viz backend. Start it with: uvicorn app.main:app",
        );
      }
    })();
    return () => controller.abort();
  }, []);

  // --------------------------------------------------------------- field load

  useEffect(() => {
    if (!scenario || !currentTime || !activeVariable) return;
    const controller = new AbortController();

    (async () => {
      setFieldLoading(true);
      setFieldError(null);
      try {
        const bounds = {
          lat_min: scenario.lat_range[0], lat_max: scenario.lat_range[1],
          lon_min: scenario.lon_range[0], lon_max: scenario.lon_range[1],
        };
        const meta = await api.fieldMeta(
          { variable: variableKey, time: currentTime.slice(0, 10), ...bounds },
          controller.signal,
        );
        const values = await api.fieldData(meta, controller.signal);
        if (controller.signal.aborted) return;

        setFieldMeta(meta);
        sceneRef.current?.setField(
          values,
          { lat: meta.grid.lat, lon: meta.grid.lon, depths: meta.depth_levels, shape: meta.shape },
          meta.value_range,
          meta.colormap,
          variableKey,
        );
        sceneRef.current?.setDepthWindow(depthWindow[0], depthWindow[1]);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFieldMeta(null);
        setFieldError(
          error instanceof ApiError ? error.message : "Could not load this field.",
        );
      } finally {
        if (!controller.signal.aborted) setFieldLoading(false);
      }
    })();

    return () => controller.abort();
    // depthWindow is applied separately; re-fetching on every drag would be wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, currentTime, variableKey, activeVariable]);

  // ---------------------------------------------------------- instrument load

  useEffect(() => {
    if (!scenario) return;
    const controller = new AbortController();
    (async () => {
      try {
        const list = await api.instruments(
          {
            time_start: scenario.time_start, time_end: scenario.time_end,
            lat_min: scenario.lat_range[0], lat_max: scenario.lat_range[1],
            lon_min: scenario.lon_range[0], lon_max: scenario.lon_range[1],
          },
          controller.signal,
        );
        if (!controller.signal.aborted) setInstruments(list);
      } catch {
        /* markers are additive; the column still stands without them */
      }
    })();
    return () => controller.abort();
  }, [scenario]);

  const featuredIds = useMemo(
    () => new Set(scenario?.featured_platforms ?? []),
    [scenario],
  );

  /** Floats reporting alongside the selected model run. */
  const visiblePlatforms = useMemo<PlatformSummary[]>(() => {
    if (!instruments || !currentTime) return [];
    const centre = new Date(currentTime).getTime();
    const seen = new Set<string>();
    const out: PlatformSummary[] = [];
    for (const p of instruments.platforms) {
      if (Math.abs(new Date(p.time).getTime() - centre) > MARKER_WINDOW_MS) continue;
      // One entry per float per run; a high-cadence float such as 2901335
      // would otherwise stack a dozen identical dots on the same spot.
      if (seen.has(p.platform_id)) continue;
      seen.add(p.platform_id);
      out.push(p);
    }
    return out;
  }, [instruments, currentTime]);

  const visibleMarkers = useMemo<MarkerDatum[]>(
    () =>
      visiblePlatforms.map((p) => ({
        id: `${p.platform_id}-${p.cycle_number ?? 0}`,
        platformId: p.platform_id,
        lat: p.lat,
        lon: p.lon,
        maxDepth: p.max_depth ?? 0,
        featured: featuredIds.has(p.platform_id),
      })),
    [visiblePlatforms, featuredIds],
  );

  useEffect(() => {
    sceneRef.current?.setMarkers(visibleMarkers);
    sceneRef.current?.setSelected(selected?.platform_id ?? null);
  }, [visibleMarkers, selected]);

  // Marker selection is wired here rather than in the scene so React owns the
  // resulting panel state.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.onSelect = (marker) => {
      if (!marker || !instruments) return;
      const platform = instruments.platforms.find((p) => p.platform_id === marker.platformId);
      setSelected(platform ?? null);
    };
  }, [instruments]);

  // ------------------------------------------------------------- comparison

  useEffect(() => {
    if (!selected) {
      setComparison(null);
      setCompareError(null);
      return;
    }
    const controller = new AbortController();
    const variable = variableKey === "salinity" ? "salinity" : "temperature";
    (async () => {
      setCompareLoading(true);
      setCompareError(null);
      try {
        const result = await api.compare(
          { platform_id: selected.platform_id, variable },
          controller.signal,
        );
        if (!controller.signal.aborted) setComparison(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        setComparison(null);
        setCompareError(
          error instanceof ApiError ? error.message : "Could not load this profile.",
        );
      } finally {
        if (!controller.signal.aborted) setCompareLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selected, variableKey]);

  // The measured profile goes into the 3D as well as the side panel, so the
  // float can be read against the water it was measured in. The scene draws it
  // only when the measured variable matches the field on screen.
  useEffect(() => {
    sceneRef.current?.setProfile(
      comparison
        ? {
            lat: comparison.lat,
            lon: comparison.lon,
            variable: comparison.variable,
            points: comparison.observed,
          }
        : null,
    );
  }, [comparison]);

  // --------------------------------------------------------------- timeline

  useEffect(() => {
    if (!playing || !scenario || scenario.timesteps.length < 2) return;
    const id = window.setInterval(() => {
      setTimeIndex((i) => (i + 1) % scenario.timesteps.length);
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, scenario]);

  const handleDepthChange = useCallback((next: [number, number]) => {
    setDepthWindow(next);
    sceneRef.current?.setDepthWindow(next[0], next[1]);
  }, []);

  const closePanel = useCallback(() => {
    // Closing must not disturb the camera: the scene is never re-created here.
    setSelected(null);
    sceneRef.current?.setSelected(null);
  }, []);

  // ------------------------------------------------------------------ render

  const source: SourceStatus | null = fieldMeta?.source ?? instruments?.source ?? null;
  const provenanceLabel = !source
    ? "Connecting…"
    : source.provenance === "live"
      ? "Live · INCOIS ERDDAP"
      : `Cached · ${new Date(source.fetched_at).toLocaleDateString("en-GB", {
          day: "numeric", month: "short", timeZone: "UTC",
        })}`;

  return (
    <div className="console">
      <header className="console__header">
        <div className="header__mark">
          <img
            className="header__seal"
            src="/incois-logo-128.png"
            alt="Indian National Centre for Ocean Information Services"
            width={30}
            height={30}
          />
          <div className="header__titles">
            <h1 className="header__title">Ocean data visualization</h1>
            <span className="header__subtitle">
              {scenario ? `${scenario.title} · Bay of Bengal, October 2013` : "INCOIS · Ministry of Earth Sciences"}
            </span>
          </div>
        </div>

        <div className="header__spacer" />

        <div className="header__group">
          <div className="provenance">
            <span
              className={`provenance__dot${
                source?.provenance === "cached" ? " provenance__dot--cached" : ""
              }${!source ? " provenance__dot--offline" : ""}`}
              aria-hidden="true"
            />
            <span className="provenance__text readout">{provenanceLabel}</span>
          </div>

          <div className="mode-toggle" role="group" aria-label="View">
            <button
              type="button" className="mode-toggle__button"
              aria-pressed={view === "globe"} disabled={!entryDone}
              onClick={() => handleView("globe")}
            >
              Globe
            </button>
            <button
              type="button" className="mode-toggle__button"
              aria-pressed={view === "column"} disabled={!entryDone}
              onClick={() => handleView("column")}
            >
              Water column
            </button>
          </div>

          <div className="mode-toggle" role="group" aria-label="Interface mode">
            <button
              type="button" className="mode-toggle__button"
              aria-pressed={mode === "ops"} onClick={() => setMode("ops")}
            >
              Ops
            </button>
            <button
              type="button" className="mode-toggle__button"
              aria-pressed={mode === "explore"} onClick={() => setMode("explore")}
            >
              Explore
            </button>
          </div>
        </div>
      </header>

      <div
        className={`console__main${mode === "explore" ? " console__main--explore" : ""}${
          view === "globe" ? " console__main--globe" : ""
        }`}
      >
        {view === "column" ? (
        <div className="panel panel--left">
          <VariablePanel
            variables={variables}
            selected={variableKey}
            mode={mode}
            onSelect={setVariableKey}
          />
          <div className="panel__section">
            <h2 className="panel__heading">
              Floats reporting{visiblePlatforms.length > 0 ? ` (${visiblePlatforms.length})` : ""}
            </h2>
            <FloatList
              platforms={visiblePlatforms}
              featured={featuredIds}
              selectedId={selected?.platform_id ?? null}
              onSelect={(platform) => {
                setSelected(platform);
                sceneRef.current?.setSelected(platform.platform_id);
              }}
            />
          </div>

          <div className="panel__section panel__section--grow">
            <h2 className="panel__heading">Depth</h2>
            <DepthRuler
              window={depthWindow}
              cursorDepth={selected?.max_depth ?? null}
              onChange={handleDepthChange}
            />
          </div>
        </div>
        ) : null}

        <div className="viewport">
          {webglReady ? (
            <>
              <canvas ref={canvasRef} className="viewport__canvas" />
              <div className="viewport__overlay">
                <div className="viewport__status">
                  {view === "globe"
                    ? `${scenario ? "Analysis extent outlined" : "Locating the analysis"} · ${
                        visibleMarkers.length
                      } float${visibleMarkers.length === 1 ? "" : "s"} reporting`
                    : fieldLoading && currentTime
                    ? `Loading ${activeVariable?.label.toLowerCase() ?? "field"} for ${new Date(
                        currentTime,
                      ).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}…`
                    : fieldError
                      ? fieldError
                      : `${visibleMarkers.length} float${visibleMarkers.length === 1 ? "" : "s"} reporting · depth ${Math.round(
                          depthWindow[0],
                        )}–${Math.round(depthWindow[1])} m`}
                </div>

                {view === "globe" ? (
                  <span className="viewport__hint">
                    Drag to turn the Earth. Click the outlined region to dive in.
                  </span>
                ) : mode === "explore" ? (
                  <span className="viewport__hint">
                    Drag to turn the water column. Click a float to see what it measured.
                  </span>
                ) : (
                  <span className="viewport__hint">
                    {[
                      exaggeration > 0
                        ? `Depth exaggerated ${Math.round(exaggeration)}×`
                        : null,
                      instruments ? `${instruments.rejected_by_qc} levels rejected by QC` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}

                {view === "globe" ? (
                  <p className="viewport__credit">
                    Basemap: NASA Blue Marble, {scenario?.basemap === "december" ? "December" : "October"} 2004.
                    Imagery only — no measurement is drawn on the sphere except the outlined
                    extent and the floats inside it.
                  </p>
                ) : null}

                {!entryDone ? (
                  <button
                    type="button"
                    className="skip-entry"
                    onClick={() => {
                      sceneRef.current?.skipEntry();
                      setEntryDone(true);
                    }}
                  >
                    Skip intro
                  </button>
                ) : null}
              </div>

              {hovered ? (
                <div className="viewport__hover" style={{ left: "50%", top: "12%" }}>
                  {hovered.platformId} · {Math.round(hovered.maxDepth)} m
                </div>
              ) : null}

              {bootError ? (
                <div className="viewport__message">
                  <div className="viewport__message-inner">
                    <p className="viewport__message-title">The data service is not responding</p>
                    <p className="viewport__message-body">{bootError}</p>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="viewport__message">
              <div className="viewport__message-inner">
                <p className="viewport__message-title">This browser cannot draw the water column</p>
                <p className="viewport__message-body">
                  The 3D view needs WebGL2, which is not enabled here. Recent versions of
                  Chrome, Edge, Firefox and Safari support it — switching to one of those,
                  or enabling hardware acceleration, will bring the view back.
                </p>
              </div>
            </div>
          )}

          {selected ? (
            <ProfilePanel
              platform={selected}
              comparison={comparison}
              loading={compareLoading}
              error={compareError}
              onClose={closePanel}
            />
          ) : null}
        </div>

        {view === "column" ? (
        <div className="panel panel--right">
          <Colorbar
            label={activeVariable?.label ?? "Field"}
            units={activeVariable?.units ?? ""}
            unitsDeclaredByUs={activeVariable?.units_declared_by_us ?? false}
            colormap={activeVariable?.colormap ?? "thermal"}
            range={fieldMeta?.value_range ?? null}
            fullRange={fieldMeta?.full_range ?? null}
            clipped={fieldMeta?.clipped ?? false}
            loading={fieldLoading}
          />
        </div>
        ) : null}
      </div>

      <Timeline
        timesteps={scenario?.timesteps ?? []}
        index={timeIndex}
        playing={playing}
        disabled={!scenario}
        onSeek={setTimeIndex}
        onTogglePlay={() => setPlaying((p) => !p)}
      />
    </div>
  );
}
