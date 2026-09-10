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

import type { CmapName } from "../../viz/chunk/model";
import type { ChunkPlatform, ChunkSource } from "../../viz/chunk/source";
import type { SceneSpec } from "../../viz/chunk/spec";
import { gradient } from "./util";

const BATHY_PALETTES: CmapName[] = ["deep", "thermal", "haline"];

interface Props {
  spec: SceneSpec;
  /** The loaded chunk. Its grid, not a constant, bounds every control here. */
  source: ChunkSource;
  platforms: ChunkPlatform[];
  expanded: Record<string, boolean>;
  /** Whether the whole section is open. Closed by default — see ChunkView. */
  open: boolean;
  selectedPlatform: string | null;
  onToggleOpen: () => void;
  onToggleExpand: (id: string) => void;
  onCommit: (rebuildAxis?: boolean) => void;
  onExaggeration: (value: number) => void;
  onOpenProfile: (id: string) => void;
}

export function LayerStackPanel({
  spec,
  source,
  platforms,
  expanded,
  open,
  selectedPlatform,
  onToggleOpen,
  onToggleExpand,
  onCommit,
  onExaggeration,
  onOpenProfile,
}: Props) {
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
      <button
        type="button"
        className="chunk-panel__title chunk-panel__title--toggle"
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <span>Layers</span>
        <span className="chunk-layer__chev" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? (
        <>
          {spec.layers
            .filter((layer) => layer.type !== "scalar-field")
            .slice()
            .reverse()
            .map((layer) => {
          const props = layer.props ?? {};
          const visible = layer.visible !== false;
          const opacity = layer.opacity ?? 1;
          const open = !!expanded[layer.id];

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

                  {layer.type === "instruments" ? (
                    <div className="chunk-platforms">
                      <div className="chunk-caption">Platforms</div>
                      {platforms.length === 0 ? (
                        <div className="chunk-note">
                          No Argo or glider data in this chunk and window — try a
                          neighbouring chunk, or widen the dates.
                        </div>
                      ) : null}
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
                            style={{
                              // Matches the 3D track colours in
                              // viz/chunk/registry.ts. Both are measured
                              // platforms, so neither takes the model's amber.
                              background:
                                p.type === "argo_float"
                                  ? "var(--cv-accent)"
                                  : "var(--current)",
                            }}
                          />
                          <span className="chunk-platform__id">{p.id}</span>
                          <span className="chunk-platform__kind">
                            {`${p.fixes.length} cast${p.fixes.length === 1 ? "" : "s"}`}
                          </span>
                        </button>
                      ))}
                      <div className="chunk-note">
                        The track joins real surfacings, roughly ten days apart. What a
                        float does between them is not measured, so it is not drawn.
                      </div>
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
        </>
      ) : null}
    </div>
  );
}
