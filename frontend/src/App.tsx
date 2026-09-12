import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  api,
  ApiError,
  type Comparison,
  type FieldMeta,
  type InstrumentList,
  type PlatformSummary,
  type Scenario,
  type MapPointBlock,
  type MapSliceMeta,
  type SourceStatus,
  type VariableInfo,
} from "./api/client";
import { ProfilePanel } from "./components/ProfilePanel";
import { Timeline } from "./components/Timeline";
import { VariablePanel } from "./components/VariablePanel";
import { PointsDrawer, type PointAnnotation } from "./components/PointsDrawer";
import { DepthRuler, DEFAULT_DEPTH_LEVELS } from "./components/DepthRuler";
import { CommandPill } from "./components/CommandPill";
import { snapTile, type Bbox } from "./viz/chunk/loader";
import { ViewControls } from "./components/ViewControls";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { AssistantDock } from "./assistant/AssistantDock";
import { BuildStatus } from "./build/BuildStatus";
import { useAssistantBridge } from "./assistant/useAssistantBridge";
import { MapView } from "./map/MapView";
import { ChunkView } from "./components/chunk/ChunkView";
import { PointReadout } from "./map/PointReadout";
import { MapTimeline } from "./map/MapTimeline";
import {
  activeLayer,
  createInitialMapState,
  datasetOf,
  mapReducer,
} from "./map/state";
import { MAX_DEPTH } from "./viz/depth";
import { BASEMAPS } from "./viz/globe";
import type { ColormapName } from "./viz/colormaps";
import {
  isWebGL2Available,
  OceanScene,
  type MarkerDatum,
  type SceneView,
} from "./viz/scene";


/**
 * Map and chunk have their own canvases and don't use viz/scene.ts, so they're
 * added here rather than to SceneView.
 */
type AppView = SceneView | "map" | "chunk";

/** Floats within half a model step of the current run count as reporting with it. */
const MARKER_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const PLAY_INTERVAL_MS = 1100;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const assistantLayerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OceanScene | null>(null);

  const [webglReady] = useState(isWebGL2Available);
  // The app opens on the map.
  const [view, setView] = useState<AppView>("map");
  const [entryDone, setEntryDone] = useState(true);

  const [map, dispatchMap] = useReducer(mapReducer, undefined, createInitialMapState);
  const [mapMetas, setMapMetas] = useState<Record<string, MapSliceMeta>>({});
  const [mapLoading, setMapLoading] = useState<Record<string, boolean>>({});
  const [columnExtent, setColumnExtent] =
    useState<{ latRange: [number, number]; lonRange: [number, number] } | null>(null);
  /** Tile shown in the chunk view, plus a note if it isn't the one that was clicked. */
  const [chunk, setChunk] = useState<{ bbox: Bbox; movedFrom: string | null }>({
    bbox: snapTile(87.5, 12.5),
    movedFrom: null,
  });
  const openChunkRef = useRef<(lat: number, lon: number) => void>(() => undefined);
  const [point, setPoint] = useState<MapPointBlock | null>(null);
  const [pointLoading, setPointLoading] = useState(false);
  const [pointError, setPointError] = useState<string | null>(null);
  const [sectionLoaded, setSectionLoaded] = useState(false);
  const [isPointsOpen, setIsPointsOpen] = useState(false);

  /** Copy of the side panel's layer stack, so the map can draw it. */
  const [layerStack, setLayerStack] = useState<{
    keys: string[];
    visibility: Record<string, boolean>;
    opacity: Record<string, number>;
  }>({ keys: [], visibility: {}, opacity: {} });

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
  const [depthIndex, setDepthIndex] = useState<number>(DEFAULT_DEPTH_LEVELS.length - 1);
  const [bootError, setBootError] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // A stack pushed by the assistant. VariablePanel keeps its own copy of the stack
  // and only reports it up, so changing layerStack alone does nothing on screen.
  // The panel has to be given the new stack; the nonce marks it as a new instruction.
  const [assistantStack, setAssistantStack] = useState<{
    keys: string[];
    visibility: Record<string, boolean>;
    opacity: Record<string, number>;
    nonce: number;
  } | null>(null);

  const handleDepthIndexChange = useCallback((index: number) => {
    setDepthIndex(index);
    const targetDepth = DEFAULT_DEPTH_LEVELS[index]?.depthMeters ?? MAX_DEPTH;
    const nextWindow: [number, number] = [0, targetDepth];
    setDepthWindow(nextWindow);
    sceneRef.current?.setDepthWindow(0, targetDepth);
  }, []);

  /**
   * Switch view. Going back to the column replays the entry animation, so
   * entryDone is reset and "Skip intro" shows again.
   */
  const handleView = useCallback((next: AppView) => {
    setView(next);
    // Map and chunk have their own canvases; the 3D scene isn't involved.
    if (next === "map" || next === "chunk") return;
    if (next === "globe") {
      sceneRef.current?.enterGlobe();
    } else {
      setEntryDone(false);
      // enterColumn() returns early if the scene is already on "column", and the scene
      // stays on "column" while the map is shown (it doesn't know about the map). So
      // use startEntry(), which is the same animation without that check.
      const scene = sceneRef.current;
      if (scene?.currentView === "globe") scene.enterColumn();
      else scene?.startEntry();
    }
  }, []);

  // The chunk view has its own WebGL canvas on top, so pause this scene meanwhile.
  useEffect(() => {
    sceneRef.current?.setPaused(view === "chunk");
  }, [view]);

  // --- assistant ---
  // The assistant changes app state through useAssistantBridge (created below).
  // The layer stack is handled here because App owns it: set the mirror and pass
  // the stack to the panel via externalStack (with a new nonce). Doing only one of
  // the two looks like the assistant reporting a change that never happened.
  const pushLayerStack = useCallback(
    (stack: { keys: string[]; visibility: Record<string, boolean>; opacity: Record<string, number> }) => {
      setLayerStack(stack);
      setAssistantStack((prev) => ({ ...stack, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [],
  );

  const activeVariable = variables.find((v) => v.key === variableKey);
  const currentTime = scenario?.timesteps[timeIndex];

  // --- scene setup ---

  useEffect(() => {
    if (!webglReady || !canvasRef.current) return;
    const scene = new OceanScene(canvasRef.current);
    sceneRef.current = scene;

    scene.onHover = setHovered;
    scene.onEntryComplete = () => setEntryDone(true);
    // The scene can change view itself (clicking the region on the globe).
    scene.onViewChange = setView;
    // A globe click opens the chunk under it. Via a ref since the scene is built once.
    scene.onGlobePick = (lat, lon) => openChunkRef.current(lat, lon);

    // Exposed so the screenshot tests can read the frame rate.
    (window as unknown as { __oceanScene?: OceanScene }).__oceanScene = scene;

    const observer = new ResizeObserver(() => scene.resize());
    if (canvasRef.current.parentElement) observer.observe(canvasRef.current.parentElement);

    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [webglReady]);

  // --- catalog load ---

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

        // If the terrain fails, the analysis still renders.
        try {
          const relief = await api.terrainMeta(undefined, controller.signal);
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
          }
        } catch {
          /* no terrain, the water column still works */
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

  // --- field load ---

  useEffect(() => {
    if (!activeVariable) {
      sceneRef.current?.clearVolume();
      setFieldMeta(null);
      setFieldLoading(false);
      return;
    }
    if (!scenario || !currentTime) return;
    const controller = new AbortController();

    (async () => {
      setFieldLoading(true);
      setFieldError(null);
      try {
        // Use the box dragged on the map if there is one, otherwise the scenario box.
        const box = columnExtent ?? {
          latRange: scenario.lat_range,
          lonRange: scenario.lon_range,
        };
        const bounds = {
          lat_min: box.latRange[0], lat_max: box.latRange[1],
          lon_min: box.lonRange[0], lon_max: box.lonRange[1],
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
          // Variable key, so the lattice can hide depth labels for surface variables.
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
    // depthWindow is applied separately; don't refetch on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, currentTime, variableKey, activeVariable, columnExtent]);

  // --- instrument load ---

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
        /* markers are optional; the column works without them */
      }
    })();
    return () => controller.abort();
  }, [scenario]);

  const featuredIds = useMemo(
    () => new Set(scenario?.featured_platforms ?? []),
    [scenario],
  );

  /** Floats reporting with the selected model run. */
  const visiblePlatforms = useMemo<PlatformSummary[]>(() => {
    if (!instruments || !currentTime) return [];
    const centre = new Date(currentTime).getTime();
    const seen = new Set<string>();
    const out: PlatformSummary[] = [];
    for (const p of instruments.platforms) {
      if (Math.abs(new Date(p.time).getTime() - centre) > MARKER_WINDOW_MS) continue;
      // One entry per float per run, otherwise a high-cadence float like 2901335 would
      // stack a dozen dots in one spot.
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

  const toolPoints = useMemo<PointAnnotation[]>(() => {
    return visiblePlatforms.map((p) => ({
      id: p.platform_id,
      lat: p.lat,
      lon: p.lon,
      variableCode: "DEPTH",
      value: Math.round(p.max_depth ?? 0),
      units: "m",
      maxDepth: p.max_depth ?? 0,
      platform: p,
    }));
  }, [visiblePlatforms]);

  const handleOpenGraphForPoint = useCallback((pt: PointAnnotation) => {
    if (pt.platform) {
      setSelected(pt.platform);
      sceneRef.current?.setSelected(pt.platform.platform_id);
    }
  }, []);

  /**
   * Open the chunk for a point. Used by both globe clicks and map box drags so the
   * same place always opens the same tile. The chunk view itself finds the nearest
   * tile with data.
   */
  const openChunkAt = useCallback(
    (lat: number, lon: number) => {
      const bbox = snapTile(lon, lat);
      setChunk((prev) =>
        prev.bbox[0] === bbox[0] && prev.bbox[1] === bbox[1]
          ? prev
          : { bbox, movedFrom: null },
      );
      handleView("chunk");
    },
    [handleView],
  );

  useEffect(() => {
    openChunkRef.current = openChunkAt;
  }, [openChunkAt]);

  const openChunkFromMap = useCallback(
    (extent: { latRange: [number, number]; lonRange: [number, number] }) => {
      setColumnExtent(extent);
      openChunkAt(
        (extent.latRange[0] + extent.latRange[1]) / 2,
        (extent.lonRange[0] + extent.lonRange[1]) / 2,
      );
    },
    [openChunkAt],
  );

  useEffect(() => {
    sceneRef.current?.setMarkers(visibleMarkers);
    sceneRef.current?.setSelected(selected?.platform_id ?? null);
  }, [visibleMarkers, selected]);

  // Marker selection lives here so React owns the panel state.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.onSelect = (marker) => {
      if (!marker || !instruments) return;
      const platform = instruments.platforms.find((p) => p.platform_id === marker.platformId);
      setSelected(platform ?? null);
    };
  }, [instruments]);

  // --- comparison ---

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

  // --- map data ---

  useEffect(() => {
    const controller = new AbortController();
    api
      .mapCatalogue(controller.signal)
      .then((datasets) => dispatchMap({ type: "catalogue/loaded", datasets }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        dispatchMap({
          type: "catalogue/failed",
          message:
            error instanceof ApiError ? error.message : "Could not reach the layer catalogue.",
        });
      });
    return () => controller.abort();
  }, []);

  // The map follows the side panel's stack. Each view picks its own best source
  // for a variable.
  useEffect(() => {
    dispatchMap({ type: "layers/sync", stack: layerStack });
  }, [layerStack, map.catalogue.length]);

  const mapDatasetKey = map.layers.map((l) => l.datasetId).join("|");
  useEffect(() => {
    const controller = new AbortController();
    for (const layer of map.layers) {
      if (map.axes[layer.datasetId]) continue;
      api
        .mapTimes(layer.datasetId, controller.signal)
        .then((axis) => dispatchMap({ type: "axis/loaded", dataset: layer.datasetId, axis }))
        .catch(() => {
          /* the layer still draws, only its tick row is missing */
        });
    }
    return () => controller.abort();
  }, [mapDatasetKey]);

  const mapActiveLayer = activeLayer(map);
  const mapActiveInfo = mapActiveLayer ? datasetOf(map, mapActiveLayer) : undefined;

  useEffect(() => {
    setSectionLoaded(false);
    if (!map.pin || !mapActiveInfo || !map.time) {
      setPoint(null);
      return;
    }
    const controller = new AbortController();
    setPointLoading(true);
    setPointError(null);
    const half = Math.round(mapActiveInfo.cadence_days * 15);
    const at = Date.parse(map.time);
    const clamp = (ms: number) =>
      new Date(
        Math.max(
          Date.parse(`${mapActiveInfo.time_start}T00:00:00Z`),
          Math.min(Date.parse(`${mapActiveInfo.time_end}T00:00:00Z`), ms),
        ),
      )
        .toISOString()
        .slice(0, 10);
    api
      .mapPoint(
        {
          dataset: mapActiveInfo.id,
          lat: map.pin.lat,
          lon: map.pin.lon,
          time_start: clamp(at - half * 86400000),
          time_end: clamp(at + half * 86400000),
        },
        controller.signal,
      )
      .then((block) => {
        setPoint(block);
        setSectionLoaded(block.depths.length > 1);
        setPointLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPointLoading(false);
        setPointError(error instanceof ApiError ? error.message : "Could not read this point.");
      });
    return () => controller.abort();
  }, [map.pin, mapActiveInfo?.id, map.time]);

  useEffect(() => {
    if (!map.playing || view !== "map") return;
    const id = window.setInterval(() => dispatchMap({ type: "time/step", steps: 1 }), 900);
    return () => window.clearInterval(id);
  }, [map.playing, view]);

  /** Index into the point block closest to the map's time, for the chart cursors. */
  const pointTimeIndex = useMemo(() => {
    if (!point || !map.time) return 0;
    const at = Date.parse(map.time);
    let best = 0;
    let gap = Infinity;
    point.times.forEach((t, i) => {
      const d = Math.abs(Date.parse(t) - at);
      if (d < gap) {
        gap = d;
        best = i;
      }
    });
    return best;
  }, [point, map.time]);

  // --- timeline ---

  useEffect(() => {
    if (!playing || !scenario || scenario.timesteps.length < 2) return;
    const id = window.setInterval(() => {
      setTimeIndex((i) => (i + 1) % scenario.timesteps.length);
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, scenario]);

  const handleVolumeOpacityChange = useCallback((opacity: number) => {
    const scene = sceneRef.current;
    if (scene && (scene as any).volumeMesh) {
      const mat = (scene as any).volumeMesh.material;
      if (mat?.uniforms?.uDensity) {
        mat.uniforms.uDensity.value = 2.6 * opacity;
      }
    }
  }, []);

  const handleVolumeVisibilityChange = useCallback((visible: boolean) => {
    const scene = sceneRef.current;
    if (scene && (scene as any).volumeMesh) {
      (scene as any).volumeMesh.visible = visible;
    }
  }, []);

  const closePanel = useCallback(() => {
    // Closing the panel shouldn't touch the camera.
    setSelected(null);
    sceneRef.current?.setSelected(null);
  }, []);

  /** The active map layer's depth levels, or null for surface fields (removes the ruler). */
  const mapDepthLevels = useMemo(() => {
    if (!mapActiveInfo || mapActiveInfo.depth_levels.length === 0) return null;
    return mapActiveInfo.depth_levels.map((d) => ({
      depthMeters: d,
      label: d >= 100 ? d.toFixed(0) : d >= 10 ? d.toFixed(1) : d.toFixed(2),
      zone: "",
    }));
  }, [mapActiveInfo]);

  /**
   * The map slice wrapped as a FieldMeta so the shared layer card can read it.
   * Only the fields the card uses are real.
   */
  const shimOf = (meta: MapSliceMeta | undefined) => {
    if (!meta) return undefined;
    return {
      variable: meta.dataset,
      label: meta.label,
      time: meta.time,
      depth_levels: [],
      grid: { lat: [], lon: [] },
      data_url: meta.data_url,
      units: meta.units,
      units_declared_by_us: meta.units_declared_by_us,
      value_range: meta.value_range,
      full_range: meta.full_range,
      clipped: meta.clipped,
      colormap: meta.colormap,
      kind: "surface",
      shape: meta.shape,
      source: meta.source,
    } as unknown as FieldMeta;
  };

  const mapFieldShim = useMemo(
    () => shimOf(mapActiveLayer ? mapMetas[mapActiveLayer.id] : undefined) ?? null,
    [mapActiveLayer, mapMetas],
  );

  /** Source label per variable, so each card credits the right server. */
  const mapSourceByKey = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const layer of map.layers) {
      const info = datasetOf(map, layer);
      if (info) out[info.variable_key] = `${info.provider} · ${info.cadence}`;
    }
    return out;
  }, [map]);

  /** One shim per layer, keyed by variable, so each card shows its own range. */
  const mapFieldByKey = useMemo(() => {
    const out: Record<string, FieldMeta | undefined> = {};
    for (const layer of map.layers) {
      const info = datasetOf(map, layer);
      if (info) out[info.variable_key] = shimOf(mapMetas[layer.id]);
    }
    return out;
  }, [map, mapMetas]);

  // --- render ---

  // On the map the source is whatever the active layer uses (often not INCOIS).
  const mapSource: SourceStatus | null = mapActiveLayer
    ? mapMetas[mapActiveLayer.id]?.source ?? null
    : null;
  const source: SourceStatus | null =
    view === "map" ? mapSource : fieldMeta?.source ?? instruments?.source ?? null;
  /** Name what's loading ("Loading Temperature...") instead of a bare spinner. */
  const mapLoadingLabel = useMemo(() => {
    if (view !== "map") return null;
    const pending = map.layers.filter((l) => mapLoading[l.id]);
    if (pending.length === 0) return null;
    const first = datasetOf(map, pending[0]!);
    return pending.length === 1 && first
      ? `Loading ${first.label.toLowerCase()}…`
      : `Loading ${pending.length} layers…`;
  }, [view, map, mapLoading]);

  const upstreamName =
    view === "map" ? mapActiveInfo?.provider ?? "global upstream" : "INCOIS ERDDAP";
  const provenanceLabel = !source
    ? "Connecting…"
    : source.provenance === "live"
      ? `Live · ${upstreamName}`
      : `Cached ${new Date(source.fetched_at).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", timeZone: "UTC",
      })} · ${upstreamName}`;

  const isLayerActiveInColumn = Boolean(
    variableKey &&
    (layerStack.keys.length === 0 ||
      (layerStack.keys.includes(variableKey) && layerStack.visibility[variableKey] !== false)),
  );

  const columnActiveColormap = useMemo<ColormapName>(() => {
    const v = variables.find((item) => item.key === variableKey);
    return (v?.colormap as ColormapName) || (fieldMeta?.colormap as ColormapName) || "thermal";
  }, [variables, variableKey, fieldMeta]);

  // The assistant layer is fixed to the window so it stays visible in the chunk
  // view. In map and globe views it should line up with the viewport, so we
  // measure the viewport's box (the command bar and timeline heights vary).
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const layer = assistantLayerRef.current;
    if (!viewport || !layer) return;
    const sync = () => {
      const box = viewport.getBoundingClientRect();
      layer.style.setProperty("--viewport-top", `${Math.round(box.top)}px`);
      layer.style.setProperty("--viewport-bottom", `${Math.round(window.innerHeight - box.bottom)}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
    // Re-measure on view switches too, in case a row changed height.
  }, [view]);

  const handleZoomIn = useCallback(() => {
    if (view === "map") {
      dispatchMap({ type: "viewport/zoom", factor: 1.3 });
    } else {
      sceneRef.current?.zoomIn();
    }
  }, [view]);

  const handleZoomOut = useCallback(() => {
    if (view === "map") {
      dispatchMap({ type: "viewport/zoom", factor: 1 / 1.3 });
    } else {
      sceneRef.current?.zoomOut();
    }
  }, [view]);

  const handleResetView = useCallback(() => {
    if (view === "map") {
      dispatchMap({ type: "viewport/reset" });
    } else if (view === "globe") {
      sceneRef.current?.resetGlobeCamera();
    } else {
      sceneRef.current?.resetColumnCamera();
    }
  }, [view]);

  // Sends each assistant action to the view it was validated for.
  const assistant = useAssistantBridge({
    view,
    handleView,
    map,
    dispatchMap,
    mapSize: () => {
      const box = viewportRef.current?.getBoundingClientRect();
      return { width: box?.width || window.innerWidth, height: box?.height || window.innerHeight };
    },
    layerStack,
    pushLayerStack,
    scenario,
    timeIndex,
    setTimeIndex,
    selected,
    setSelected,
    reportingFloats: visiblePlatforms,
    instruments,
    chunkBbox: chunk.bbox,
    openChunkAt,
  });

  return (
    <div className={`console${view === "chunk" ? " console--concealed" : ""}`}>
      <CommandPill
        scenario={scenario}
        source={source}
        mapLoadingLabel={mapLoadingLabel || (view === "column" && fieldLoading ? "Loading field…" : null)}
        provenanceLabel={provenanceLabel}
        view={view}
        onViewChange={handleView}
        entryDone={entryDone}
        pointsCount={toolPoints.length}
        isPointsOpen={isPointsOpen}
        onTogglePoints={() => {
          setIsPointsOpen((prev) => {
            const next = !prev;
            if (next) setAssistantOpen(false);
            return next;
          });
        }}
        hasLayers={view === "map" ? map.layers.length > 0 : false}
      />

      <div
        className={`console__main${view === "globe" ? " console__main--globe" : ""}`}
      >
        <div className="viewport" ref={viewportRef}>
          {/* Layer panel: drives the 3D field and the map's stack. Hidden on the globe. */}
          {view === "column" || view === "map" ? (
            <VariablePanel
              variables={variables}
              selected={variableKey}
              onSelect={setVariableKey}
              currentTime={view === "map" ? map.time : currentTime}
              fieldMeta={view === "map" ? mapFieldShim : fieldMeta}
              fieldMetaByKey={view === "map" ? mapFieldByKey : undefined}
              sourceLabelByKey={view === "map" ? mapSourceByKey : undefined}
              sourceLabel={
                view === "map"
                  ? mapActiveInfo
                    ? `${mapActiveInfo.provider} · ${mapActiveInfo.cadence}`
                    : undefined
                  : undefined
              }
              externalStack={assistantStack}
              onStackChange={setLayerStack}
              onOpacityChange={handleVolumeOpacityChange}
              onVisibilityChange={handleVolumeVisibilityChange}
            />
          ) : null}
          {webglReady ? (
            <>
              <canvas
                ref={canvasRef}
                className={`viewport__canvas${view === "map" ? " viewport__canvas--idle" : ""}`}
              />
              {view === "map" ? (
                <MapView
                  state={map}
                  dispatch={dispatchMap}
                  onMetas={setMapMetas}
                  onLoading={setMapLoading}
                  onOpenColumn={openChunkFromMap}
                />
              ) : null}
              {/* These describe the water column, so hide them on the map (it has its own HUD). */}
              <div className={`viewport__overlay${view === "map" ? " viewport__overlay--hidden" : ""}`}>
                {fieldError ? (
                  <div className="viewport__status viewport__status--error">
                    {fieldError}
                  </div>
                ) : null}

                {view === "globe" ? (
                  <p className="viewport__credit">
                    Basemap: NASA Blue Marble, {scenario?.basemap === "december" ? "December" : "October"} 2004.
                    Imagery only — no measurement is drawn on the sphere except the floats
                    reporting inside the analysis extent.
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

          {view === "map" && map.pin ? (
            <PointReadout
              block={point}
              loading={pointLoading}
              error={pointError}
              depthIndex={mapActiveLayer?.depthIndex ?? 0}
              timeIndex={pointTimeIndex}
              onClose={() => dispatchMap({ type: "pin/set", point: null })}
              onLoadSection={() => undefined}
              sectionLoaded={sectionLoaded}
              sectionLoading={false}
            />
          ) : null}

          {selected ? (
            <ProfilePanel
              platform={selected}
              comparison={comparison}
              loading={compareLoading}
              error={compareError}
              onClose={closePanel}
              shifted={isPointsOpen}
            />
          ) : null}

          {view === "map" && mapDepthLevels ? (
            <DepthRuler
              currentDepthIndex={mapActiveLayer?.depthIndex ?? 0}
              onDepthChange={(index) =>
                mapActiveLayer &&
                dispatchMap({
                  type: "layer/patch",
                  id: mapActiveLayer.id,
                  patch: { depthIndex: index },
                })
              }
              levels={mapDepthLevels}
            />
          ) : null}

          {view === "column" ? (
            <DepthRuler
              currentDepthIndex={depthIndex}
              onDepthChange={handleDepthIndexChange}
              window={depthWindow}
              cursorDepth={selected?.max_depth ?? null}
              colormap={isLayerActiveInColumn ? columnActiveColormap : null}
              hasActiveLayer={isLayerActiveInColumn}
            />
          ) : null}

          <PointsDrawer
            isOpen={isPointsOpen}
            onClose={() => setIsPointsOpen(false)}
            points={toolPoints}
            selectedPointId={selected?.platform_id}
            onOpenGraphForPoint={handleOpenGraphForPoint}
          />

          {view === "globe" ? (
            <ViewControls
              view={view}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onReset={handleResetView}
            />
          ) : null}
        </div>
      </div>

      {view === "map" ? (
        <MapTimeline
          state={map}
          onSeek={(time) => dispatchMap({ type: "time/set", time })}
          onStep={(steps) => dispatchMap({ type: "time/step", steps })}
          onTogglePlay={() => dispatchMap({ type: "time/play", playing: !map.playing })}
        />
      ) : view === "column" && activeVariable ? (
        <Timeline
          timesteps={scenario?.timesteps ?? []}
          index={timeIndex}
          playing={playing}
          disabled={!scenario}
          onSeek={setTimeIndex}
          onTogglePlay={() => setPlaying((p) => !p)}
        />
      ) : null}

      {/* The chunk view is full screen and covers the console. */}
      {/* Outside the console so it's still visible in the chunk view (which hides the console). */}
      <div
        ref={assistantLayerRef}
        className={`assistant-layer${view === "chunk" ? " assistant-layer--chunk" : ""}`}
      >
        {/* Also outside the viewport so the build warning shows in every view. */}
        <BuildStatus />

        <AssistantDock
          open={assistantOpen}
          onToggle={() => {
            setAssistantOpen((open) => {
              const next = !open;
              if (next) setIsPointsOpen(false);
              return next;
            });
          }}
        />

        <AssistantPanel
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onActions={assistant.applyActions}
          onUndo={assistant.undo}
          getState={assistant.getState}
          view={view === "globe" || view === "chunk" ? view : "map"}
          scope={assistant.scope}
        />
      </div>

      {view === "chunk" ? (
        <div className="chunk-overlay">
          <ChunkView
            onBack={() => handleView("globe")}
            bbox={chunk.bbox}
            movedFrom={chunk.movedFrom}
            onAssistantController={assistant.registerChunk}
            onMove={openChunkAt}
          />
        </div>
      ) : null}
    </div>
  );
}
