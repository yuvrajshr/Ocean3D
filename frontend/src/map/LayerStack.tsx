/**
 * The layer stack.
 *
 * Both reference tools (Copernicus MyOcean Pro, NASA Worldview) draw these as
 * rounded cards with drop shadows. That is exactly the SaaS-card kit CLAUDE.md
 * Step 4 warns against, so here a layer is a *housing*: a flat band, full width
 * of the rail, separated by hairlines, square-cornered, no shadow. The only
 * radius inside it is on the controls, per `--radius-control`.
 *
 * Each housing always states its dataset, grid spacing and cadence in mono, and
 * never in a tooltip. That is not decoration — it is the mechanism that keeps a
 * global map honest (context.md §5.1 Principle 7): the reader can always tell
 * what they are looking at and how coarse it is.
 */

import { useMemo } from "react";

import type { MapLayerInfo, MapSliceMeta } from "../api/client";
import { toCssGradient } from "../viz/colormaps";
import { datasetOf, MAX_LAYERS, type MapLayer, type MapState, resolveLayerTime } from "./state";

/** A compact horizontal colorbar, for inside a housing.
 *
 *  `components/Colorbar.tsx` cannot be reused: it is a vertical instrument built
 *  for the 104px right rail (`grid-template-rows: auto 1fr auto`), and
 *  `toCssGradient` emits `to top`. Different orientation, different component;
 *  the 3D views keep theirs untouched. */
function LayerColorbar({
  layer,
  meta,
}: {
  layer: MapLayer;
  meta: MapSliceMeta | undefined;
}) {
  const gradient = useMemo(
    () => toCssGradient(layer.colormap).replace("to top", "to right"),
    [layer.colormap],
  );
  const range = layer.range ?? meta?.value_range ?? null;

  return (
    <div className="layer-bar">
      <div className="layer-bar__ramp" style={{ background: gradient }} aria-hidden="true" />
      <div className="layer-bar__scale readout">
        {range ? (
          <>
            <span>{formatValue(range[0])}</span>
            <span>{formatValue((range[0] + range[1]) / 2)}</span>
            <span>
              {formatValue(range[1])} {meta?.units ?? ""}
            </span>
          </>
        ) : (
          <span className="layer-bar__pending">Loading scale…</span>
        )}
      </div>
      {meta?.clipped ? (
        <p className="layer-bar__note">
          Scale 2–98%. True range {formatValue(meta.full_range[0])} to{" "}
          {formatValue(meta.full_range[1])}.
        </p>
      ) : null}
      {meta?.units_declared_by_us ? <p className="layer-bar__note">Units inferred.</p> : null}
    </div>
  );
}

function formatValue(v: number): string {
  const m = Math.abs(v);
  if (m >= 1000) return v.toFixed(0);
  if (m >= 10) return v.toFixed(1);
  if (m >= 0.1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Depth levels arrive at full float precision (0.49402499198913574). A ruler
 *  prints what a reader can use. */
function formatDepth(d: number): string {
  if (d >= 100) return d.toFixed(0);
  if (d >= 10) return d.toFixed(1);
  return d.toFixed(2).replace(/\.?0+$/, "");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface CardProps {
  state: MapState;
  layer: MapLayer;
  info: MapLayerInfo;
  meta: MapSliceMeta | undefined;
  loading: boolean;
  index: number;
  count: number;
  onPatch: (patch: Partial<MapLayer>) => void;
  onRemove: () => void;
  onActivate: () => void;
  onMove: (delta: number) => void;
}

function LayerCard({
  state,
  layer,
  info,
  meta,
  loading,
  index,
  count,
  onPatch,
  onRemove,
  onActivate,
  onMove,
}: CardProps) {
  const resolved = resolveLayerTime(state, layer);
  const active = state.activeLayerId === layer.id;
  const depth = info.depth_levels[layer.depthIndex];
  const spacing = Math.abs(
    (info.lon_range[1] - info.lon_range[0]) / Math.max(1, info.native_shape[1]),
  );

  // Stated, not hidden: a monthly field and a daily field stacked together are
  // not the same instant, and the reader has to be able to see that.
  const offset = resolved && Math.abs(resolved.offsetDays) > info.cadence_days / 2
    ? `${resolved.offsetDays > 0 ? "+" : "−"}${Math.abs(Math.round(resolved.offsetDays))} d`
    : null;

  return (
    <li
      className={`layer-card${active ? " layer-card--active" : ""}${
        resolved?.outOfCoverage ? " layer-card--dim" : ""
      }`}
    >
      <div className="layer-card__head">
        <button
          type="button"
          className="layer-card__eye"
          aria-pressed={layer.visible}
          aria-label={`${layer.visible ? "Hide" : "Show"} ${info.label.toLowerCase()}`}
          onClick={() => onPatch({ visible: !layer.visible })}
        >
          <span className={`layer-card__dot${layer.visible ? " layer-card__dot--on" : ""}`} />
        </button>
        <button type="button" className="layer-card__title" onClick={onActivate}>
          {info.label}
        </button>
        <div className="layer-card__order">
          <button
            type="button"
            aria-label={`Move ${info.label.toLowerCase()} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${info.label.toLowerCase()} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          className="layer-card__close"
          aria-label={`Remove ${info.label.toLowerCase()}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      {/* Always visible, always mono. This is the honesty mechanism. */}
      <p className="layer-card__source readout">
        {info.provider} · {spacing.toFixed(2)}° · {info.cadence}
        {meta && meta.stride > 1 ? ` · sampled 1:${meta.stride}` : ""}
      </p>

      <p className="layer-card__state readout">
        {resolved?.outOfCoverage ? (
          <span className="layer-card__warn">
            No coverage — {info.label.toLowerCase()} runs {info.time_start} to {info.time_end}.
          </span>
        ) : (
          <>
            {resolved ? formatDate(resolved.time) : "—"}
            {offset ? <span className="layer-card__offset">{offset}</span> : null}
            {" · "}
            {info.depth_levels.length > 0 && depth !== undefined
              ? `${formatDepth(depth)} m`
              : "surface"}
          </>
        )}
      </p>

      {loading ? (
        <p className="layer-card__state readout">Loading {info.label.toLowerCase()}…</p>
      ) : null}

      <LayerColorbar layer={layer} meta={meta} />

      {/* Copernicus's licence requires this credit and the product DOI wherever
          its data appears. It is a condition of use, not a courtesy, so it sits
          with the layer rather than in a footer someone can scroll past. */}
      {info.attribution ? (
        <p className="layer-card__credit readout">{info.attribution}</p>
      ) : null}

      <div className="layer-card__controls">
        <label className="layer-card__opacity">
          <span className="sr-only">{info.label} opacity</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(layer.opacity * 100)}
            onChange={(e) => onPatch({ opacity: Number(e.target.value) / 100 })}
          />
          <span className="readout">{Math.round(layer.opacity * 100)}%</span>
        </label>

        <button
          type="button"
          className="layer-card__toggle"
          aria-pressed={layer.log}
          onClick={() => onPatch({ log: !layer.log })}
        >
          log
        </button>

        {info.has_vectors ? (
          <button
            type="button"
            className="layer-card__toggle"
            aria-pressed={layer.streamlines}
            onClick={() => onPatch({ streamlines: !layer.streamlines })}
          >
            flow
          </button>
        ) : null}
      </div>
    </li>
  );
}

interface StackProps {
  state: MapState;
  metas: Record<string, MapSliceMeta>;
  loading: Record<string, boolean>;
  onPatch: (id: string, patch: Partial<MapLayer>) => void;
  onRemove: (id: string) => void;
  onActivate: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  onAdd: (datasetId: string) => void;
}

export function LayerStack({
  state,
  metas,
  loading,
  onPatch,
  onRemove,
  onActivate,
  onMove,
  onAdd,
}: StackProps) {
  const used = new Set(state.layers.map((l) => l.datasetId));
  const addable = state.catalogue.filter((d) => !used.has(d.id));
  const full = state.layers.length >= MAX_LAYERS;

  return (
    <div className="layer-stack">
      <div className="layer-stack__head">
        <h2 className="panel__heading">Layers</h2>
        <select
          className="layer-stack__add"
          value=""
          disabled={full || addable.length === 0}
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value);
          }}
          aria-label="Add a layer"
        >
          <option value="">{full ? `${MAX_LAYERS} maximum` : "Add layer…"}</option>
          {addable.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {state.layers.length === 0 ? (
        <p className="layer-stack__empty">
          No layers yet — add one to start drawing the ocean.
        </p>
      ) : (
        <ul className="layer-stack__list">
          {state.layers.map((layer, i) => {
            const info = datasetOf(state, layer);
            if (!info) return null;
            return (
              <LayerCard
                key={layer.id}
                state={state}
                layer={layer}
                info={info}
                meta={metas[layer.id]}
                loading={loading[layer.id] ?? false}
                index={i}
                count={state.layers.length}
                onPatch={(patch) => onPatch(layer.id, patch)}
                onRemove={() => onRemove(layer.id)}
                onActivate={() => onActivate(layer.id)}
                onMove={(delta) => onMove(layer.id, delta)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
