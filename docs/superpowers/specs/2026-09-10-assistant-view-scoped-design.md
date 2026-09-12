# Ocean assistant: view-scoped, correct, fast — design

*2026-09-10 · branch `assistant/view-scoped` · approved in chat section by section*

## Problem

Three reported failures, each traced to a root cause and reproduced live:

1. **"SST at 15°N 88°E" answered "HYCOM is unreachable".** `reads._dataset_for`
   takes the first `MAP_DATASETS` match, ignoring `preference`, so temperature
   resolves to HYCOM while the map draws Copernicus (and chlorophyll to VIIRS NRT,
   a rolling 2025–26 window, never INCOIS). It then queried HYCOM (1994–2015) for
   the map clock, 2026-06-23. APDRC answered HTTP 500, and `erddap_client.fetch`
   reports every HTTP error as "did not answer … not cached". The same query for
   2013-10-12 succeeds in 2.8 s.
2. **Depth was silently wrong.** The assistant is told `depth_m` from the hidden
   water column's `depthIndex` (default: last level, 2000 m); its `set_depth`
   changes that column, never `mapActiveLayer.depthIndex`.
3. **The chunk view is unreachable by the assistant.** Every action writes console
   state the chunk view conceals; reads use the map's source and clock, not the
   chunk's HYCOM tile and date; the open panel (420×844 at top-left) covers the
   chunk's layer panel and back control; the examples are map-only.
4. **It is slow.** Measured: `gemini-3.5-flash` 8–13 s per round, two rounds
   minimum — 21.5 s for "add the salinity layer", 86 s for the SST question
   (including a 26 s rate-limit wait). Even a 429 takes 6–8 s to come back. The
   first question after each restart also pays a Google Search billing 429.

## Decisions (made in chat)

- **Scope:** changes go to the view on screen. The assistant may switch views when
  explicitly asked; anything after the switch in the same request applies to the
  new view. One shared conversation.
- **Model:** `gemini-3.5-flash-lite`, `thinking_level: minimal` (measured 1.86 s
  per round, correct tool call). On 429/timeout: next model immediately
  (`gemini-3.1-flash-lite`, then `gemini-3.5-flash`), never a blind sleep.
- **Precision:** a point value is always the source's **native cell** — it must
  match the pin readout. No sampling of the strided on-screen slice.

## Architecture

### 1. Per-view tool registry (server-authoritative)

Each turn declares `COMMON ∪ VIEW_TOOLS[state.view]`, and validation is per view.
An action for another view is refused with a reason ("that is a chunk-view
control"). Every validated action carries `"view"` so the client can route it.

| Scope | Actions | Reads |
|---|---|---|
| Common | `set_view`, `open_chunk` (named region, or lat/lon only when the reader gave them) | `query_point`, `list_floats`, `compare_float` |
| Map | `set_layers`, `set_time` (≥1 visible layer covers it), `set_depth` (nearest real level of the active layer; refused for a surface layer), `zoom_to_region`, `set_pin`, `set_area` | — |
| Globe | `set_time` (nearest scenario step, inside the scenario window), `select_float` (opens the INCOIS comparison panel), `clear_selection` | — |
| Chunk | `show_variable`, `set_time` (inside the 30-day window), `set_display` (slices/volume/isosurface; surface-only variables allow slices only), `set_cut` (axis + value in m/°), `set_iso_value`, `set_exaggeration` (10–200×), `set_camera` (corner/top/section), `set_layer` (visible/opacity for scalar, currents, bathymetry), `set_colour_scale` (min/max, auto, linear/log), `move_chunk` (N/S/E/W) | `describe_chunk` |

**View switch mid-turn.** After a round in which `set_view` / `open_chunk`
succeeded, the loop sets `state.view` to the new view; the next round declares
that view's tools and renders its state. This is how "open the chunk over the Bay
of Bengal and show salinity" works in one message.

### 2. Screen state: every view, every turn

The client sends all three blocks every turn; the prompt renders only the current
view's, and the loop can switch to another without a round trip.

```
{ view, map:   { layers[{key,visible,opacity,time_start,time_end}], time,
                 active: {key, depth_m, depth_levels[] | null}, pin },
        globe: { time, window[start,end], selected, floats[] },
        chunk: { mounted, bbox, variable, time, window[start,end], mode, cut{axis,value},
                 iso_value, exaggeration, camera, layers{id:{visible,opacity}},
                 colour{min,max,scale} } }
```

When the chunk is not mounted, the block describes the chunk as it would open
(App's bbox + the view's defaults), so a mid-turn switch is validated truthfully.

### 3. Client routing, the chunk bridge, and undo

- `applyAssistantActions` (moved out of `App.tsx` into `assistant/useAssistantBridge.ts`)
  routes by `action.view`: map → map reducer / layer stack (depth via
  `layer/patch`); globe → `setTimeIndex` / `setSelected`; chunk → a controller.
- `ChunkView` registers `{ getState, apply, snapshot, restore }` on a ref prop once
  its engine is ready. Chunk actions that arrive before that (right after
  `open_chunk`) queue and drain on registration.
- The chunk's `apply` is a pure spec transform (`assistant/chunkActions.ts`)
  followed by the same `commit` / `setVariable` / `setTime` / `goPreset` /
  `applyExaggeration` paths the panels already use.
- **Undo** snapshots `{ view, map:{stack,time,active depth,pin}, globe:{timeIndex,
  selected}, chunk:{bbox, spec} }` before applying; one click restores all of it.
  A chunk restore queues if the chunk must remount.

### 4. Upstream change folded in (2026-09-10, after this spec was approved)

Parthvats13 removed the chunk's sea-surface and instrument-traces layers on
`origin/main` (6718bc1, 38db870), then restored the instrument traces with a
reworked panel (77f5583, merged 2026-09-12). The chunk carries scalar, currents,
bathymetry and instrument traces; the assistant's chunk tools match, including
`open_float`. Model-vs-observation against INCOIS stays reachable everywhere
through `compare_float`.

## Speed

1. Model chain and cooldowns as decided; one shared `genai.Client`; per-request
   timeout (20 s) → next model. Sleep only if every model is cooling and the
   soonest is ≤ 15 s, with the status line saying so.
2. **Commands finish in one round.** If every call in round 1 is a successful
   action and none switched view, the confirmation is composed from the validated
   actions (`describe_actions`, §5.3 voice) and round 2 is skipped.
3. **Reads in a round run in parallel**, each with a 10 s budget. Past it, the
   model is told the value is still loading and the fetch completes in the
   background into the assistant cache, so asking again is instant.
4. **Search probe off the critical path:** requests go without `google_search`
   until a background probe (started by `/assistant/status`) settles it.
5. **History** capped at the last 12 messages.
6. Smaller prompts: only the current view's tools are declared.

## Data correctness

1. **One resolver.** `map_dataset_for(variable, date=None)` in `config.py` returns
   the most-preferred dataset whose `time_range` covers the date;
   `coverage_for(variable)` lists `(provider, start, end)` for refusals.
   `reads._dataset_for` is deleted. Chunk reads use `CHUNK_DATASETS` — the view's
   own table.
2. **Coverage before any request.** Out of coverage → a refusal naming what does
   cover it. The HYCOM-2026 request can no longer reach APDRC.
3. **Defaults come from the view**: date = that view's clock; depth = map active
   layer's level, chunk surface unless asked; `list_floats` defaults to the view's
   window and box.
4. **Native single-level reads.**
   - Chunk: sample the loaded chunk volume (`routers/chunk._volume`, disk-cached,
     HYCOM native 0.08°) — milliseconds. `describe_chunk` returns per-level
     mean/min/max and the depth of the strongest mean vertical gradient.
   - Map/globe ERDDAP: one level at one point (`[(depth)]`), not all 40 levels.
   - Copernicus: a process-wide ARCO handle (`copernicusmarine.open_dataset`,
     `arco-time-series`), opened in a background thread at startup — spiked at
     ~8 s open, then 4–6 s per point vs ~11 s per `subset`. Results disk-cached.
   - `currents` returns speed = hypot(u, v) and direction, not `u` alone.
5. **Honest errors.** `erddap_client.UpstreamRefused(UpstreamUnavailable)` carries
   the HTTP status; map and chunk `_guard` messages say "refused this request
   (HTTP 500)" vs "unreachable". Existing `except UpstreamUnavailable` still catches it.

## Interface

- Chunk view: the panel sits right of the layer rail (`left` = rail edge + 12 px),
  bottom-anchored above the time bar, height capped; no chunk control is covered.
  Map/globe placement unchanged.
- Header gains a scope readout in IBM Plex Mono (`Chunk view · 10–15°N, 85–90°E`,
  `Map · 12 Oct 2013`, `Globe · 12 Oct 2013`).
- Examples per view. Status lines name the source being read.
- No new colour, radius, shadow or type role.

## Testing

- **Backend (pytest), test-first:** resolver (Copernicus for 2026-06-23, HYCOM for
  2013 without Copernicus, INCOIS chlorophyll for 2013 — fails on today's code);
  coverage refusal; `UpstreamRefused` on HTTP 500; per-view validation (chunk
  action refused on the map; chunk time outside window; map depth → nearest real
  level; surface layer refuses depth); loop with a fake Gemini client (command =
  one request; view switch re-declares; 429 → next model, no sleep; slow read →
  "still loading").
- **Frontend (vitest):** chunk action transforms, snapshot/restore, routing,
  the pre-mount queue.
- **End to end (throwaway Puppeteer):** one command and one question per view with
  the visible change asserted and the turn timed; Map → Globe → Chunk → Map with
  zero console errors; `elementFromPoint` proves the panel covers no chunk control.
- Latencies reported as measured, not as targets.

## Out of scope

Token streaming of the prose; conversation history UI; the water column (still
unreachable, `next_session.md` §0 item 2); Google Search billing.

## Docs in the same change

`context.md` §10 entries (appended at the end), §5.1 Principle 13 amendment ("it
acts on the view you are looking at"); `next_session.md` §1c; `.env.example`.
