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

import {
  GRID,
  VARIABLES,
  instruments,
  type CmapName,
  type VariableKey,
} from "../../viz/chunk/model";
import type { CutAxis, LayerDesc, ScalarMode, SceneSpec } from "../../viz/chunk/spec";
import { fmt, gradient } from "./util";

const BATHY_PALETTES: CmapName[] = ["deep", "thermal", "haline"];

interface Props {
  spec: SceneSpec;
  expanded: Record<string, boolean>;
  selectedPlatform: string | null;
  onToggleExpand: (id: string) => void;
  onCommit: (rebuildAxis?: boolean) => void;
  onExaggeration: (value: number) => void;
  onOpenProfile: (id: string) => void;
}

/** The cut the active axis exposes: which prop it writes, and in what units. */
function cutFor(axis: CutAxis, props: LayerDesc["props"]) {
  const p = props ?? {};
  if (axis === "lon") {
    const value = p.sliceLon ?? 87.35;
    return {
      key: "sliceLon" as const,
      name: "Longitude",
      min: 85,
      max: 90,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°E",
    };
  }
  if (axis === "lat") {
    const value = p.sliceLat ?? 12.65;
    return {
      key: "sliceLat" as const,
      name: "Latitude",
      min: 10,
      max: 15,
      step: 0.05,
      value,
      label: value.toFixed(2) + "°N",
    };
  }
  const value = p.sliceDepth ?? 0;
  return {
    key: "sliceDepth" as const,
    name: "Depth",
    min: 0,
    max: GRID.maxDepth,
    step: 5,
    value,
    label: Math.round(value) + " m",
  };
}

export function LayerStackPanel({
  spec,
  expanded,
  selectedPlatform,
  onToggleExpand,
  onCommit,
  onExaggeration,
  onOpenProfile,
}: Props) {
  const variable: VariableKey = spec.field.variable;
  const info = VARIABLES[variable];
  const platforms = instruments();

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
          const cut = cutFor(axis, props);
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
                      <div className="chunk-note">
                        Shelf break on the western edge; seamount at 88.7°E.
                      </div>
                    </div>
                  ) : null}

                  {layer.type === "instruments" ? (
                    <div className="chunk-platforms">
                      <div className="chunk-caption">Platforms</div>
                      {platforms.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`chunk-platform${
                            selectedPlatform === p.id ? " chunk-platform--on" : ""
                          }`}
                          onClick={() => onOpenProfile(p.id)}
                        >
                          <span
                            className="chunk-platform__dot"
                            style={{ background: p.type === "argo" ? "#6fe3f0" : "#f2b45c" }}
                          />
                          <span className="chunk-platform__id">{p.id}</span>
                          <span className="chunk-platform__kind">
                            {p.type === "argo" ? "Argo" : "Glider"}
                          </span>
                        </button>
                      ))}
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
