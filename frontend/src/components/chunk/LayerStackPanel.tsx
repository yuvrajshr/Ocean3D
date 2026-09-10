/**
 * The layer stack.
 *
 * Layers are listed top-down — the reverse of the spec's draw order — so the
 * list matches what is in front of what in the viewport. Each row carries its
 * own visibility, opacity and, expanded, the controls that belong to that layer
 * type and no other. Nothing here holds state: every control writes into the
 * scene spec and commits, which is why the spec inspector always agrees with
 * the panel.
 */

import { VARIABLES, type CmapName, type VariableKey } from "../../viz/chunk/model";
import type { ChunkPlatform, ChunkSource } from "../../viz/chunk/source";
import type { CutAxis, LayerDesc, ScalarMode, SceneSpec } from "../../viz/chunk/spec";
import { fmt, gradient } from "./util";

const BATHY_PALETTES: CmapName[] = ["deep", "thermal", "haline"];

interface Props {
  spec: SceneSpec;
  /** The loaded chunk. Its grid, not a constant, bounds every control here. */
  source: ChunkSource;
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onCommit: (rebuildAxis?: boolean) => void;
  onExaggeration: (value: number) => void;
}

/** The cut the active axis exposes: which prop it writes, and in what units. */
function cutFor(axis: CutAxis, props: LayerDesc["props"], source: ChunkSource) {
  const p = props ?? {};
  const G = source.grid;
  if (axis === "lon") {
    const value = p.sliceLon ?? (G.lon0 + G.lon1) / 2;
    return {
      key: "sliceLon" as const,
      name: "Longitude",
      min: G.lon0,
      max: G.lon1,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°E",
      note: "",
    };
  }
  if (axis === "lat") {
    const value = p.sliceLat ?? (G.lat0 + G.lat1) / 2;
    return {
      key: "sliceLat" as const,
      name: "Latitude",
      min: G.lat0,
      max: G.lat1,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°N",
      note: "",
    };
  }
  // The slider is continuous but the analysis is not: it has levels, and the
  // plane drawn is the nearest one. The readout names that level rather than
  // the number under the handle, so the two can never disagree on screen.
  const value = p.sliceDepth ?? 0;
  const level = G.levels[source.levelIndex(value)] ?? value;
  return {
    key: "sliceDepth" as const,
    name: "Depth",
    min: 0,
    max: G.maxDepth,
    step: 5,
    value,
    label: Math.round(level) + " m",
    note: Math.abs(level - value) > 1 ? "nearest level" : "",
  };
}

export function LayerStackPanel({
  spec,
  source,
  expanded,
  onToggleExpand,
  onCommit,
  onExaggeration,
}: Props) {
  const variable: VariableKey = spec.field.variable;
  const info = VARIABLES[variable];

  // Much of the Bay of Bengal floor lies below the 2000 m this chunk covers, so
  // the layer often has nothing to draw. Saying which is better than an empty
  // control that looks broken.
  // A variable with one level is not a volume, and the controls that cut
  // through one have nothing to cut. Disabled and explained rather than hidden:
  // the reader should be able to see that the mode exists and why it is not
  // available here.
  const flat = source.grid.nz <= 1;
  const flatNote = `${source.meta.label} is a surface product (${source.meta.provider}). There is no depth axis to slice, stack or contour.`;

  const relief = source.relief;
  const seabedNote = !relief
    ? "Seabed relief unavailable — the field still draws, since its own mask is what stops it."
    : (() => {
        const shallow = Math.round(-relief.maxElevation);
        const deep = Math.round(-relief.minElevation);
        if (relief.maxElevation > 0) {
          return `ETOPO1 relief. Land in this chunk reaches ${Math.round(relief.maxElevation)} m; the floor drops to ${deep} m.`;
        }
        return shallow > source.grid.maxDepth
          ? `Seabed ${shallow}–${deep} m, entirely below this chunk's ${source.grid.maxDepth} m — nothing to draw here.`
          : `ETOPO1 relief. Seabed ${shallow}–${deep} m.`;
      })();

  return (
    <div className="chunk-layers chunk-panel chunk-panel--lifted">
      <div className="chunk-panel__title">Layers</div>

      {spec.layers
        .slice()
        .reverse()
        .map((layer) => {
          const props = layer.props ?? {};
          const visible = layer.visible !== false;
          const opacity = layer.opacity ?? 1;
          const open = !!expanded[layer.id];
          const mode: ScalarMode = props.mode ?? "slices";
          const axis: CutAxis = props.activeAxis ?? "depth";
          const cut = cutFor(axis, props, source);
          const isoValue = props.isoValue ?? 20;
          const isoSpan = info.range[1] - info.range[0];

          return (
            <div className="chunk-layer" key={layer.id}>
              <div className="chunk-layer__head">
                <button
                  type="button"
                  className={`chunk-dot${visible ? " chunk-dot--on" : ""}`}
                  aria-pressed={visible}
                  aria-label={`${visible ? "Hide" : "Show"} ${layer.label ?? layer.id}`}
                  onClick={() => {
                    layer.visible = !visible;
                    onCommit();
                  }}
                />
                <button
                  type="button"
                  className={`chunk-layer__name${visible ? "" : " chunk-layer__name--off"}`}
                  aria-expanded={open}
                  onClick={() => onToggleExpand(layer.id)}
                >
                  {layer.label ?? layer.id}
                </button>
                <div className="chunk-layer__pct">{Math.round(opacity * 100)}%</div>
                <button
                  type="button"
                  className="chunk-layer__chev"
                  aria-label={`${open ? "Collapse" : "Expand"} ${layer.label ?? layer.id} settings`}
                  aria-expanded={open}
                  onClick={() => onToggleExpand(layer.id)}
                >
                  {open ? "−" : "+"}
                </button>
              </div>

              <input
                type="range"
                className="chunk-layer__opacity"
                min={0}
                max={1}
                step={0.02}
                value={opacity}
                aria-label={`${layer.label ?? layer.id} opacity`}
                onChange={(e) => {
                  layer.opacity = +e.target.value;
                  onCommit();
                }}
              />

              {open ? (
                <div className="chunk-layer__body">
                  {layer.type === "scalar-field" ? (
                    <div className="chunk-field">
                      <div className="chunk-caption">Display mode</div>
                      <div className="chunk-seg" role="group" aria-label="Display mode">
                        {(
                          [
                            ["slices", "Slices"],
                            ["volume", "Volume"],
                            ["isosurface", "Iso"],
                          ] as [ScalarMode, string][]
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            className={`chunk-seg__btn${mode === id ? " chunk-seg__btn--on" : ""}`}
                            aria-pressed={mode === id}
                            disabled={flat && id !== "slices"}
                            onClick={() => {
                              props.mode = id;
                              layer.props = props;
                              onCommit();
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {flat ? <div className="chunk-note">{flatNote}</div> : null}

                      <div className="chunk-caption">Cut plane</div>
                      <div className="chunk-seg" role="group" aria-label="Cut plane">
                        {(
                          [
                            ["depth", "Depth"],
                            ["lon", "Lon"],
                            ["lat", "Lat"],
                          ] as [CutAxis, string][]
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            className={`chunk-seg__btn${axis === id ? " chunk-seg__btn--on" : ""}`}
                            aria-pressed={axis === id}
                            disabled={flat && id !== "depth"}
                            onClick={() => {
                              props.activeAxis = id;
                              layer.props = props;
                              onCommit();
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <div className="chunk-kv">
                        <span className="chunk-kv__key">{cut.name}</span>
                        <span className="chunk-kv__value chunk-kv__value--accent">{cut.label}</span>
                      </div>
                      <input
                        type="range"
                        min={cut.min}
                        max={cut.max}
                        step={cut.step}
                        value={cut.value}
                        aria-label={`${cut.name} of the cut plane`}
                        onChange={(e) => {
                          props[cut.key] = +e.target.value;
                          layer.props = props;
                          onCommit();
                        }}
                      />

                      <button
                        type="button"
                        className="chunk-check"
                        aria-pressed={props.contextWalls !== false}
                        onClick={() => {
                          props.contextWalls = props.contextWalls === false;
                          layer.props = props;
                          onCommit();
                        }}
                      >
                        <span
                          className={`chunk-dot chunk-dot--small${
                            props.contextWalls !== false ? " chunk-dot--on" : ""
                          }`}
                        />
                        <span className="chunk-check__label">Context walls</span>
                      </button>

                      {mode === "isosurface" ? (
                        <div className="chunk-field">
                          <div className="chunk-kv">
                            <span className="chunk-kv__key">Iso value</span>
                            <span className="chunk-kv__value">
                              {fmt(isoValue, info.dec)} {info.unit}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={0.5}
                            value={((isoValue - info.range[0]) / isoSpan) * 100}
                            aria-label="Iso value"
                            onChange={(e) => {
                              props.isoValue = info.range[0] + (+e.target.value / 100) * isoSpan;
                              layer.props = props;
                              onCommit();
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {layer.type === "currents" ? (
                    <div className="chunk-field">
                      {source.hasVector ? (
                        <div className="chunk-note">
                          {`Each trace is ${props.trail ?? 10} h of drift at the cut depth, ` +
                            "replayed at six ocean-hours a second."}
                        </div>
                      ) : (
                        <div className="chunk-note">
                          No current direction for this chunk — the upstream serves speed
                          here, and a magnitude cannot be advected.
                        </div>
                      )}
                      <div className="chunk-kv">
                        <span className="chunk-kv__key">Particles</span>
                        <span className="chunk-kv__value">{props.count ?? 900}</span>
                      </div>
                      <input
                        type="range"
                        min={150}
                        max={2400}
                        step={50}
                        value={props.count ?? 900}
                        aria-label="Particle count"
                        onChange={(e) => {
                          props.count = +e.target.value;
                          layer.props = props;
                          onCommit();
                        }}
                      />
                      <div className="chunk-kv">
                        <span className="chunk-kv__key">Advection speed</span>
                        <span className="chunk-kv__value">{(props.speed ?? 1).toFixed(1)}×</span>
                      </div>
                      <input
                        type="range"
                        min={0.2}
                        max={3}
                        step={0.1}
                        value={props.speed ?? 1}
                        aria-label="Advection speed"
                        onChange={(e) => {
                          props.speed = +e.target.value;
                          layer.props = props;
                          onCommit();
                        }}
                      />
                      <div className="chunk-kv">
                        <span className="chunk-kv__key">Trail length</span>
                        <span className="chunk-kv__value">{props.trail ?? 10}</span>
                      </div>
                      <input
                        type="range"
                        min={3}
                        max={24}
                        step={1}
                        value={props.trail ?? 10}
                        aria-label="Trail length"
                        onChange={(e) => {
                          props.trail = +e.target.value;
                          layer.props = props;
                          onCommit();
                        }}
                      />
                      <div className="chunk-note">
                        Seeded at the active slice depth and advected by the horizontal velocity
                        field.
                      </div>
                    </div>
                  ) : null}

                  {layer.type === "bathymetry" ? (
                    <div className="chunk-field" style={{ gap: 8 }}>
                      <div className="chunk-caption">Colormap</div>
                      <div className="chunk-swatches" role="group" aria-label="Bathymetry colormap">
                        {BATHY_PALETTES.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className={`chunk-swatch${
                              props.palette === name ? " chunk-swatch--on" : ""
                            }`}
                            style={{ background: gradient(name) }}
                            aria-pressed={props.palette === name}
                            aria-label={`${name} colormap`}
                            onClick={() => {
                              props.palette = name;
                              layer.props = props;
                              onCommit();
                            }}
                          />
                        ))}
                      </div>
                      <div className="chunk-note">{seabedNote}</div>
                    </div>
                  ) : null}



                  {layer.type === "sea-surface" ? (
                    <div className="chunk-note">
                      Translucent plane at z = 0 m marking the air–sea interface.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

      <div className="chunk-axis">
        <div className="chunk-heading">Depth axis</div>
        <div className="chunk-kv">
          <span className="chunk-kv__key">Vertical exaggeration</span>
          <span className="chunk-kv__value chunk-kv__value--accent">
            {spec.view.exaggeration}×
          </span>
        </div>
        <input
          type="range"
          min={10}
          max={200}
          step={1}
          value={spec.view.exaggeration}
          aria-label="Vertical exaggeration"
          onChange={(e) => onExaggeration(+e.target.value)}
        />
        <div className="chunk-seg" role="group" aria-label="Depth axis">
          {(
            [
              ["linear", "Linear"],
              ["stretched", "Stretched"],
            ] as ["linear" | "stretched", string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chunk-seg__btn${
                spec.view.depthAxis === id ? " chunk-seg__btn--on" : ""
              }`}
              aria-pressed={spec.view.depthAxis === id}
              onClick={() => {
                spec.view.depthAxis = id;
                onCommit(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="chunk-note">
          True aspect is 275:1. Stretched mode gives the upper 200 m half the vertical extent.
        </div>
      </div>
    </div>
  );
}
