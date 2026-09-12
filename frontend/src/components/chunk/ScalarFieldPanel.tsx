/**
 * Controls for the scalar field: display mode, cut plane and isovalue. Kept
 * separate from the layer list since it's the one people use most.
 */

import { VARIABLES, type VariableKey } from "../../viz/chunk/model";
import type { ChunkSource } from "../../viz/chunk/source";
import type { CutAxis, ScalarMode, SceneSpec } from "../../viz/chunk/spec";
import { cutFor, fmt } from "./util";

interface Props {
  spec: SceneSpec;
  /** The loaded chunk; its grid sets the limits for every control here. */
  source: ChunkSource;
  expanded: boolean;
  onToggleExpand: () => void;
  onCommit: (rebuildAxis?: boolean) => void;
}

export function ScalarFieldPanel({ spec, source, expanded, onToggleExpand, onCommit }: Props) {
  const layer = spec.layers.find((l) => l.type === "scalar-field");
  if (!layer) return null;

  const variable: VariableKey = spec.field.variable;
  const info = VARIABLES[variable];

  // A single-level variable has nothing to cut through. Those modes are disabled
  // with an explanation rather than hidden.
  const flat = source.grid.nz <= 1;
  const flatNote = `${source.meta.label} is a surface product (${source.meta.provider}). There is no depth axis to slice, stack or contour.`;

  const props = layer.props ?? {};
  const visible = layer.visible !== false;
  const opacity = layer.opacity ?? 1;
  const mode: ScalarMode = props.mode ?? "slices";
  const axis: CutAxis = props.activeAxis ?? "depth";
  const cut = cutFor(axis, props, source);
  const isoValue = props.isoValue ?? 20;
  const isoSpan = info.range[1] - info.range[0];

  return (
    <div className="chunk-scalar chunk-panel chunk-panel--lifted">
      <div className="chunk-layer chunk-layer--solo">
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
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            {layer.label ?? layer.id}
          </button>
          <div className="chunk-layer__pct">{Math.round(opacity * 100)}%</div>
          <button
            type="button"
            className="chunk-layer__chev"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${layer.label ?? layer.id} settings`}
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            {expanded ? "−" : "+"}
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

        {expanded ? (
          <div className="chunk-layer__body">
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
