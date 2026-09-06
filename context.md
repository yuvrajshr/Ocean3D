# context.md — INCOIS 3D Ocean Data Visualization Platform (SIH 2026)

> This file is the persistent project context for Claude Code. Read it before starting any
> work session. Keep it updated as decisions are made — treat it as the single source of
> truth for scope, architecture, and conventions.

---

## 1. Problem Statement (source of truth)

- **SIH Problem Statement ID:** 26067
- **Organization:** Ministry of Earth Sciences (MoES)
- **Department:** Indian National Centre for Ocean Information Services (INCOIS), Ocean Valley
- **Category:** Software
- **Theme:** Disaster Management

**Title:** Develop a web-based interactive 3D visualization platform that integrates
numerical ocean model outputs and in-situ observations.

**Core problem:** INCOIS produces large volumes of 3D ocean model output (temperature,
salinity, currents, chlorophyll — in NetCDF) and in-situ observations from Argo floats,
Gliders, CTDs, and BGC sensors (ASCII/text). No existing tool lets forecasters co-visualize
model fields and instrument data, in 3D, in a browser, in one place. Current tools are
desktop-bound, 2D-only, or siloed. This slows hazard assessment, search-and-rescue,
fishery advisories, and climate monitoring.

**What we are building:** A browser-native, WebGL-based 3D ocean visualization system that:
1. Renders volumetric/depth-resolved ocean model fields (temp, salinity, currents).
2. Overlays Argo/Glider/CTD/BGC observations as geospatial markers with clickable
   depth-vs-variable profile charts.
3. Ingests NetCDF (via xarray) and delimited text formats through a modular parser layer.
4. Gives users interactive controls: variable selector, depth-slice slider, time-step
   animation, colorbar editor (palette / min-max / log-linear), layer opacity, vertical
   exaggeration.
5. Follows open standards: OGC WMS/WCS, CF Conventions for NetCDF.
6. Is deployable on INCOIS infra with no client-side plugin dependencies (pure browser).
7. Doubles as a public science-communication / outreach tool, not just an ops tool.

---

## 2. Non-goals / explicit scope boundaries (for the hackathon build)

- We are **not** building a full production ingestion pipeline for INCOIS's live systems —
  we build a working prototype against sample/representative NetCDF + Argo/Glider datasets.
- We are **not** implementing every sensor type (ADCP, HF-radar, moorings) — the architecture
  must be *extensible* to them (plugin-style parser interface), but only Argo + Glider (+
  optionally CTD/BGC if time allows) need working ingestion for the demo.
- We are **not** building user auth/multi-tenant infra unless a judge round specifically
  demands it — focus on the visualization core.
- Desktop GIS software (ArcGIS/Panoply) parity is not the bar; the bar is "co-visualization
  in one browser session that a forecaster couldn't do before."

---

## 3. High-level architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Frontend (Browser)             │
                    │  React + Three.js (or CesiumJS) + deck.gl │
                    │  - 3D globe/volume renderer               │
                    │  - Depth slice / time animation UI         │
                    │  - Colorbar + variable control panel       │
                    │  - Profile chart modal (per float/glider)  │
                    └───────────────┬─────────────────────────┘
                                    │ REST / OPeNDAP-style HTTP (JSON + binary tiles)
                    ┌───────────────▼─────────────────────────┐
                    │              Backend API                  │
                    │  FastAPI (Python)                          │
                    │  - /variables, /model-field, /profile      │
                    │  - /instruments (Argo/Glider metadata)     │
                    │  - OGC WMS/WCS-compatible endpoints        │
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │         Data Ingestion Layer                │
                    │  xarray + netCDF4 (NetCDF, CF-convention)    │
                    │  pandas (Argo/Glider ASCII/text parsers)     │
                    │  Modular "DataSource" plugin interface       │
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │           Storage / Cache                    │
                    │  Raw files: NetCDF/text on disk or object     │
                    │  store (S3-compatible / local for demo)        │
                    │  Optional: Zarr for chunked fast-read arrays   │
                    │  Optional: PostgreSQL/PostGIS for instrument   │
                    │  metadata + geospatial queries                 │
                    └───────────────────────────────────────────┘
```

---

## 4. Tech stack (recommended, with rationale)

| Layer | Choice | Why |
|---|---|---|
| 3D rendering | **Three.js** — decided 2026-08-31, CesiumJS rejected | Full control over volumetric rendering, isosurfaces, custom shaders for depth slices. The data is a regional box, so a globe-primary product would render a small patch on a mostly empty sphere. Closed; do not re-open. |
| Frontend framework | React + TypeScript | Component-driven UI for control panels; TS catches data-shape bugs when wiring NetCDF-derived arrays into WebGL buffers. |
| Charting (profile view) | Recharts or D3 | Depth-vs-variable profile charts on marker click. |
| Backend framework | FastAPI (Python) | Native async, auto OpenAPI docs, pairs naturally with xarray/netCDF4/pandas ecosystem already implied by the problem statement (PyNIO/xarray mentioned explicitly). |
| NetCDF handling | `xarray` + `netCDF4` + `cftime` | Standard scientific-Python stack for CF-convention NetCDF; xarray gives label-based slicing (depth, time, lat/lon) almost for free. |
| Instrument data parsing | `pandas` + custom parsers | Argo/Glider/CTD/BGC delimited text → normalized schema (lat, lon, depth, time, variable, value). |
| Tiling / performance | ~~Zarr / precomputed tiles~~ — **not used.** Superseded 2026-08-31: see §10 | A full 3D volume is 1.0 MB as NetCDF in ~570 ms, ~259 KB per variable as `Float32Array`. Tiling would be premature optimisation at this grid resolution. Revisit only if the grid gets finer. |
| Geospatial metadata store | PostgreSQL + PostGIS (optional, or SQLite for demo) | Query floats/gliders by bounding box, time range. |
| Standards compliance | OGC WMS/WCS endpoints, CF Conventions | Explicitly required by the problem statement for interoperability with national/international ocean data portals. |
| Deployment | Docker Compose (frontend, backend, db) | Matches "deployable on INCOIS infrastructure without client-side dependencies." |

**Decision log:** when Claude Code or the team picks between alternatives (e.g. Three.js vs
Cesium, Zarr vs raw NetCDF-on-demand), record the decision and one-line rationale in
Section 10 below so it isn't relitigated mid-hackathon.

---

## 5. UI/UX Design Direction

This product has two real audiences reading the same screen differently: an INCOIS
forecaster under time pressure during a hazard event, and a student or citizen exploring
the ocean for the first time during outreach. The design has to earn trust with the first
and wonder with the second, without becoming two different products. The organizing idea
below is built for that — grounded in the actual subject matter (a water column, real
instrument telemetry, admiralty/bathymetric chart conventions), not a generic dashboard
template.

### 5.1 Design plan (brainstorm pass)

**Color** — a literal depth gradient, not a decorative dark theme. The background itself
darkens with the same ramp used to color the 3D data, so the chrome and the science share
one visual language.

| Token | Hex | Role |
|---|---|---|
| `abyss` | `#050B12` | Base background — deep water, near-seafloor |
| `thermocline` | `#0D2436` | Panel surfaces, dividers |
| `current` | `#1C6E8C` | Primary UI accent — buttons, active states, links |
| `bioluminescence` | `#4FE8C4` | Signature accent — live data, the render itself, the one "alive" color in the system |
| `advisory` | `#E8A23D` | Hazard/alert state only (ties to the Disaster Management theme — used nowhere else) |
| `foam` | `#EAF3F1` | Primary text on dark surfaces |

Two accents, two jobs: `bioluminescence` means "this is live, this is data." `advisory`
means "pay attention, this is a hazard state." They never swap roles or appear together
decoratively.

**Data colormaps are a separate, documented system.** The six tokens above govern *chrome*
only. Encoding a physical value needs a perceptually-uniform ramp: using
`current` → `bioluminescence` as a temperature scale would misrepresent the data (uneven
perceptual steps read as structure that isn't there) and would fail the color-vision
requirement in §5.4. Oceanography's standard is `cmocean`, so data is colored with
256-stop lookup tables sampled from it:

| Colormap | Encodes |
|---|---|
| `thermal` | Temperature |
| `haline` | Salinity |
| `delta` | Anomalies and model − observation residuals (diverging, zero-centred) |
| `speed` | Current magnitude |
| `algae` | Chlorophyll |

The two systems never mix: no token encodes a value, and no colormap color appears in the
UI chrome. `advisory` amber stays reserved for hazard state and is always paired with an
icon or label, never carrying meaning by color alone.

**Type** — one type family, three roles, no decorative second display face:
- **IBM Plex Sans** (Medium/Semibold) for headings and UI labels — a technical, humanist
  grotesk actually used in scientific and government tooling, so it reads as instrumented
  rather than styled.
- **IBM Plex Sans** (Regular) for body copy and captions.
- **IBM Plex Mono** for every literal readout — depth in meters, lat/lon, timestamps,
  variable values, platform IDs. This is the one place monospace is earned: it's real
  telemetry, not a decorative label face. Sentence case throughout; no tracked-out
  all-caps eyebrows.

**Layout** — instrument console, not card grid. The 3D water column is full-bleed and *is*
the hero — there's no headline banner above it. Controls dock to the edges as functional
instruments, each one doing double duty as both control and readout:

```
┌──────────────────────────────────────────────────────────────────┐
│ Ocean Data Visualization · INCOIS            [Ops mode ⟷ Explore] │
├───────────┬──────────────────────────────────────────┬───────────┤
│ Variable  │                                          │  degC     │
│ ○ Temp    │                                          │  30 ─┐    │
│ ● Salin.  │                                          │      │    │
│ ○ Currents│           water column render            │  15 ─┤    │
│ ○ Chl-a   │        (camera starts at surface,         │      │    │
│           │         descends on load)                 │   0 ─┘    │
│ Depth  0m │                                          │  (colorbar│
│        ═╪ │            ● ARGO_2903456                │   is a    │
│      500  │            (click → profile panel)        │   real    │
│     1000 ▼│                                          │   ruler)  │
├───────────┴──────────────────────────────────────────┴───────────┤
│ ◀  25 Aug ───────────●───────────────── 31 Aug  ▶   [ ▶ play  1×]│
└──────────────────────────────────────────────────────────────────┘
```

Left-aligned, dense where it needs to be (data panels), generous where it needs to be
(the viewport). The depth control is drawn as an actual ruler with correctly-scaled tick
marks doubling as the slider — not a generic styled `<input type="range">`. The colorbar
on the right is a real, labeled unit ruler, not a decorative gradient swatch. Nothing here
is a rounded card with a soft drop-shadow; panels meet at hairline dividers, like
instrument housings, with a single small radius (2px) reserved for interactive controls
only.

> **Superseded 2026-09-05 for the floating console.** The docked left and right rails are
> gone. The layer panel, tool dock and depth slider now float over a full-bleed viewport as
> rounded, elevated surfaces (radii 4-12 px, real drop shadows), and the timeline is a
> floating strip rather than a docked row. The paragraph above still describes the *docked*
> chrome the app no longer has; it is kept because the reasoning behind it — that an
> instrument is not a widget kit — still governs what goes *inside* those surfaces: real
> rulers, exact tick spacing, literal units, no decorative gradients. What changed is the
> container, not the contents. See 5.1.2.

**Principles**
1. **Depth is the organizing metaphor.** The same color ramp used to encode ocean depth in
   the render also darkens the surrounding chrome — the interface itself gets "deeper"
   toward the edges.
2. **Instrument, not dashboard.** Controls look like they belong on a research vessel's
   console: rulers, tick marks, real units — never a SaaS widget kit.

   **Amended 2026-09-05.** The surfaces those controls sit on are now rounded and elevated
   (see 5.1.2). The principle survives where it does the work: what is *on* the surface must
   still be an instrument. A depth slider that names real physical zones and a colorbar that
   states its true clipped range are instruments whatever their container's border-radius.
3. **One bold gesture.** On load, the camera performs a single continuous move: it begins
   on the Earth, flies to the Indian Ocean basin, and descends through the water column
   to the default depth as the model data streams in. The globe and the descent are one
   gesture, not two. This is the one orchestrated motion moment in the product, and it's
   motivated (it's literally what the tool does: locate a basin, then look down through
   it), not decoration. Everything else is instant, not animated: toggling a variable or
   opening a profile panel responds immediately. Under `prefers-reduced-motion` the whole
   gesture is skipped — the app opens already in the water column at the default depth.

   **The globe is a destination, but never the default one.** A control returns the user to
   it, and the same descent carries them back down; the app still *opens* by diving, because
   a forecaster's data is in the water column, not on the sphere. What does not change: the
   globe never rotates on its own. It turns when dragged and is otherwise still. An
   idly-spinning Earth is the generic data-viz tell `CLAUDE.md` Step 4 names, and it is the
   one part of this principle that survives the globe becoming somewhere you can go.
   **The map is the landing view** (2026-09-05). The app now opens on the 2D map
   rather than by diving. What survives the reversal, and it is most of it: the
   load-in descent is still the product's one orchestrated motion moment, it
   still plays on map→column and globe→column, `prefers-reduced-motion` still
   cuts it both ways, and the globe still never rotates on its own. What changed
   is only which view is first. The earlier reasoning — "a forecaster's data is
   in the water column, not on the sphere" — argued against a *locator* as the
   default; a plan view carrying real measured fields is not a locator.

4. **Two audiences, one system.** "Ops mode ⟷ Explore" is a single toggle, top-right, not a
   separate skin: Explore mode hides advanced controls (isosurface, colorbar editing) and
   adds one short caption per selected variable, in the same visual language.
5. **Structure carries information.** The depth ruler, the colorbar, the timeline scrubber
   are all literally true to their data — no numbered eyebrows or decorative dividers that
   don't correspond to real structure.
6. **The viewport is a place, not a diagram.** The water column sits in an actual ocean.
   A single continuous ETOPO relief surface carries the Eastern Ghats, the Indian and
   Myanmar coasts, Sri Lanka and the seafloor — one mesh, because in reality they are one
   surface. The sea extends past the analysis to a horizon, and light attenuates through it
   the way seawater really absorbs it: red first, then green, leaving blue before black.
   A data volume hanging in a void reads as a chart of the ocean; a data volume inside the
   sea reads as the ocean. This principle governs the viewport only — the surrounding
   chrome stays an instrument (Principle 2).

   **The viewport opens under the surface** (2026-09-04). The camera sits about 86 m down,
   looking slightly down onto the analysis, which fills a little over half the frame. Above
   the water the same framing is impossible: eye height is
   `target.y + distance·sin(elevation)`, so getting the box large enough to read means a
   smaller distance, and staying dry at that distance needs a *higher* angle — which shows
   the column's warm lid and hides the thermocline, the exact thing the elevation was
   lowered to avoid. Being under also earns the scene its atmosphere: light shafts and
   marine snow are gated on the camera being submerged and so had never once been visible.
   Dragging up still returns to the basin overview, so the whole-box view survives on demand.
7. **The basemap is imagery; everything drawn on it is data.** The globe is a photograph of
   the Earth — NASA Blue Marble, shaded relief and bathymetry baked in — and it is allowed
   to be beautiful because it is a *basemap*, the one thing in the product that encodes
   nothing. The only marks added to the sphere are things we actually measured: the
   analysis extent, and the floats reporting inside it. Nothing decorative is drawn on the
   Earth, and no field is ever painted onto it at global extent, because our coverage is a
   regional box and a global-looking data layer would claim otherwise. The same split that
   governs the viewport (Principle 6) governs the globe: the *place* may be photographic,
   the *data* stays measured.

   **Amended 2026-09-05.** A field *may* be drawn at global extent when it comes
   from a genuinely global upstream that is named on screen. The prohibition was
   never against global pixels; it was against claiming coverage we do not have.
   Drawing HYCOM's global temperature and labelling it "HYCOM GLBv0.08 · 0.08° ·
   daily" claims exactly what is true. The sphere rule is unchanged: the globe
   still carries no field at all.
8. **The viewport may carry instrument markings — but only ones the console already states.**
   Chrome was DOM-only until now. The water column now also carries a *lattice*: hairline
   gridlines on the analysis box's faces at exactly the depths `viz/depth.ts` hands the depth
   ruler, plus depth labels set in IBM Plex Mono. This is not decoration — a raymarched field
   has no edges, and the eye reads structure from edges, so without a reference surface the
   volume reads as haze no matter what its density is. Three limits keep it an instrument
   rather than chart trim. It draws only on the **far** faces, so it never sits between the
   reader and the data. It uses the **same tick values** as the DOM ruler, so the two agree
   literally rather than approximately. And depth markings **vanish entirely** for variables
   with no depth dimension, because writing "500 m" on a surface field asserts a measurement
   that does not exist. The type role is unchanged: a depth in metres is a literal readout,
   which §5.1 already assigns to IBM Plex Mono — the label moved medium, not role.

   **Corollary — a data mark may take a casing, and it is `foam`.** Where a measured mark
   would disappear against what is behind it, it gets a light sheath drawn one step wider and
   one step behind. The casing separates figure from ground and encodes nothing; only the core
   carries a value. It is the one place a chrome token sits *behind* a colormap value, and it
   must never tint one: casing behind, never a wash on top. **Why `foam` and not `abyss`:**
   most of a float profile's length is deep water, which sits at the cold end of every cmocean
   ramp and is therefore nearly black against nearly black water. A dark casing cannot
   separate dark from dark — tried first, and it made a correctly-coloured ribbon invisible.

9. **A plan view is a chart table, and every layer states its own resolution.**
   The 2D map runs full-bleed to all four edges and docks its instruments at the
   same three edges the column view uses, so switching views reads as one console
   rather than two apps. Four new structural devices come with it, each earning
   its place:

   **The layer stack.** Chrome may now be stacked and reordered, and a colorbar
   may live inside a layer's own housing instead of the right rail — with three
   layers there cannot be one shared colorbar.

   **Revised 2026-09-05.** A housing is a rounded, elevated card in the floating
   panel, not the flat hairline band this principle first specified. The team
   reviewed both and chose the card. What the housing must still do is unchanged
   and is the part that matters: state its dataset, grid spacing and cadence in
   mono, always visible and never in a tooltip; carry its own colorbar with the
   real range; and name the upstream that actually drew it.

   **Every layer names its dataset, grid spacing and cadence, always visible and
   always in IBM Plex Mono — never a tooltip.** This is not decoration. It is the
   mechanism that lets a global map coexist with Principle 7: a reader can always
   tell which upstream a pixel came from and how coarse it is. The same rule
   governs the provenance chip, which names the upstream actually in use rather
   than assuming INCOIS.

   **Motion may be continuous when the motion *is* the measurement.** Current
   streamlines advect through the real u/v field, so what moves on screen is what
   the water does. That is a different thing from a decorative hover-fade, and it
   is the single exception to the "motion is spent once" rule. Under
   `prefers-reduced-motion` the traces **freeze rather than vanish** — the paths
   carry direction, and only the animation is motion.

   **A pixel may show its own grid.** Sampling is nearest-neighbour, so past a
   zoom threshold the reader sees true grid cells rather than an interpolated
   smoothness the data does not have. Bilinear scaling would also interpolate
   *between* LUT entries and invent colours that are not in the cmocean ramp.

   The map's stacked canvases (basemap, data, flow) and its SVG overlay are all
   internals of `--z-viewport`. They are **not** a fourth chrome z-plane; the
   three-plane rule governs the console, not one plane's construction.

10. **Layer stack hierarchy: Uppermost active layer rules the water column.** The layers panel
    manages an ordered oceanographic stack (surface to subsurface). The 3D water column
    renders the single uppermost active (visible/eye-on) layer in the stack. Toggling an upper
    layer's eye off immediately reveals the next active layer below it. If all layers are
    hidden or deleted, the 3D volume and timeline scrubber gracefully step down to avoid
    displaying phantom data or desynchronized dates.
11. **Side-by-side right HUD architecture.** Right-hand floating tools are arranged in non-colliding
    lateral coordinate lanes: `ToolDock` at `right: 16px` (Points inspector & 3D projection
    toggle), `DepthSlider` at `right: 84px` (vertical water column ruler), and floating flyout
    drawers (e.g. Points profiling list) offset at `right: calc(100% + 78px)` (~150px from edge).
    Instruments never overlap, collide, or obscure each other.
12. **Vertical depth discretization matches physical sampling.** The vertical depth slider is
    an instrument reflecting the true 24-level vertical grid of the INCOIS ERDDAP analysis
    (0.5 m surface down to 2000 m floor). Real-time hover callouts display oceanographic
    physical zones (Mixed Layer, Thermocline Core, D26 Isotherm, Argo Parking Depth) so depth
    selection is grounded in ocean physics.
13. **An assistant may state a measurement only if it fetched one, and the interface
    proves which.** The ocean assistant (2026-09-06) is the first thing in the product
    that can produce a sentence rather than a rendering, which makes it the first thing
    that can be confidently wrong. Three rules keep it inside the system:

    **Provenance is rendered from tool calls, not from prose.** The citation line under
    an answer is built from the reads that actually executed, so an answer that fetched
    nothing has nothing to cite and is marked *"General knowledge — not from your data"*
    in `advisory` amber, paired with words rather than carrying meaning by colour. The
    model is asked to obey the rule in its prompt; the interface does not depend on it
    having obeyed.

    **A readout stays a readout.** Dataset, date, depth and units in the citation line
    are IBM Plex Mono, the same role §5.1 gives every literal value elsewhere. The
    medium changed, not the rule.

    **It may act, and it may always be undone.** The assistant changes the workspace
    without asking first, because a reader who says "add chlorophyll" wants chlorophyll
    added. That is only reasonable because every message that changed something carries
    a one-click undo restoring the exact prior state.

    *This principle also admits the one structural device it needs: a wide floating
    panel, 420 px, on the existing floating-console z-plane — not a fourth level.* It is
    a genuine exception to §5.1's rule that nothing competes with the viewport, taken
    knowingly: analysis prose with citations cannot be read in a tool-dock drawer. It
    closes when dismissed, and the viewport is never obscured while it is shut.

**Cinematic effects are anchored, and never touch the data.** The viewport is allowed to be
beautiful, but every effect in it corresponds to a real phenomenon: crepuscular light shafts
refracted through the surface; caustics on the seafloor *only in shallow water, faded out by
about 200 m*, because that is where sunlight actually reaches; marine snow drifting downward
and denser near the surface; and bloom on `bioluminescence`, which is the one colour in the
system that means "live data" and which literally glows in the sea.

Two hard limits keep this honest. **Bloom and tone-mapping are confined to a separate render
layer** carrying only the markers and the surface glint, so no post-processing can shift a
cmocean value and make a reader misjudge a temperature. And **where the analysis ends, the
volume fades into the surrounding water but keeps a hairline frame and a stated extent**, so
"which part of this is measured, and which part is rendered water?" always has an answer a
judge can get in one glance.

Sky and water colours are all explicit multiples of the six tokens, so the palette rule stays
visible in the source rather than being asserted here. As of 2026-09-04: horizon
`current × 0.42`, mid-sky `thermocline × 0.80`, zenith `abyss`, near-surface water
`current × 0.62`, deep water `thermocline × 0.28`. They live in one factory
(`skyUniforms()` in `viz/ocean.ts`) because the sky and the sea surface are separate materials
that both call `skyColour()` — a value added to only one uploads as zero and that material
renders black. This principle adds no new colour to the system.


### 5.1.2 The floating console (adopted 2026-09-05)

The side-panel branch replaced the docked rails with a floating console, and the team
reviewed it and chose it over the flat treatment 5.1 originally specified. Recorded here so
the docs and the code do not drift, which `CLAUDE.md` names as a hard rule.

**What the app actually looks like now.** A full-bleed viewport with three floating
surfaces over it — the layer panel (top left), the tool dock and depth slider (right) — and
a floating timeline strip along the bottom. Nothing is docked; the map, globe and water
column all get the whole frame.

**Shape and elevation.** Radii 4 px (controls and chips), 6-8 px (inner blocks), 12 px
(panel shells), and full pills for badges. Two shadow families: neutral elevation
(`0 20px 25px -5px rgba(0,0,0,0.5)`) to lift a surface off the viewport, and a cyan glow
(`0 0 10px rgba(6,182,212,0.4)`) to mark an active control. `--radius-control: 2px` in
`tokens.css` now governs the 3D viewport's own chrome only.

**Colour — and this is an unresolved split, stated rather than hidden.** The floating
console is drawn from a slate-and-cyan palette (`#22d3ee` accent; `#020617`, `#1e293b`,
`#334155`, `#64748b`, `#94a3b8`, `#cbd5e1`, `#e2e8f0` greys), not from the six named tokens.
Two of them map closely onto the existing system — `#22d3ee` plays the part
`bioluminescence` plays, `#020617` the part `abyss` plays — but the rest are new, and
`tokens.css` does not define them. **So the product currently has two chrome palettes: the
six tokens in the 3D viewport, slate+cyan in the floating console.** That is a real
inconsistency and it is the open design question, listed in section 11.

**What did NOT change, and must not.** Data is still coloured only by cmocean; no chrome
colour ever encodes a value and no colormap colour appears in chrome. Readouts are still IBM
Plex Mono. A layer housing still states its dataset, resolution, cadence and the upstream
that drew it. Percentile clipping is still declared. The rounding is a container decision; it
buys no licence over how a measurement is drawn or described.

### 5.2 Self-critique against generic defaults

Checked against common AI-generated tells before locking this in:
- Not a warm-cream-and-terracotta or near-black-with-single-neon-accent palette picked by
  default — the near-black base and two accents here are each tied to something real
  (depth, bioluminescence, hazard-advisory convention) and used for exactly one job each.
- ~~No rounded SaaS card grid, no matching soft shadow under every panel~~ — **no longer
  true as of 2026-09-05, and left visible rather than deleted.** The floating console is
  rounded and elevated (5.1.2). What the original point was defending still holds: the
  surfaces are not a *grid* of identical cards, the shadow is not applied uniformly to
  everything, and there are no gradient washes as decoration. Elevation marks what floats
  over the viewport; it is not applied to docked chrome, because there is none left.
- No tracked-out ALL-CAPS eyebrows, no "WORD — fragment" labels, no middle-dot metadata
  strings, no arrow (→) appended to buttons.
- Numbered markers are intentionally *not* used anywhere in the UI, since nothing in this
  interface is a sequence except the timeline, which already has its own real scrubber.
- Motion is spent once (the load-in descent) rather than scattered across hover/reveal
  states on every element.

### 5.3 Voice and microcopy

- Sentence case everywhere, active voice, buttons say exactly what happens: "Show
  temperature," "Play timeline," not "Enable Layer" or "Submit."
- Loading states name what's actually loading: "Loading 25 Aug model run…" not "Loading…".
- Empty states are an invitation, not an apology: a region with no instrument data reads
  "No Argo or Glider data in this window — try widening the date range," not "No data
  found."
- Errors state what happened and what to do, without apologizing: "Model field
  unavailable for this depth — showing nearest available level (50m)."

### 5.4 Accessibility and quality floor (non-negotiable, not a stretch goal)

- Full keyboard operability for all controls (variable selector, depth ruler, timeline,
  play/pause), with a visible focus ring in `bioluminescence` on the dark background.
- Respect `prefers-reduced-motion` — skip the load-in descent and jump straight to the
  default view.
- Colorbar palettes must remain distinguishable for common color-vision deficiencies
  (avoid red-green as the sole encoding for hazard vs. normal; pair color with the
  `advisory` amber and an icon/label, never color alone).
- Responsive down to a single-column layout on mobile/tablet for the Explore/outreach
  audience — Ops mode's denser controls can assume a larger screen.

### 5.5 Standing external references — design and data

Two outside sources are standing references for this project. Consult them whenever a
visual question or a data gap comes up — a new field to draw, a colour ramp to justify, a
variable INCOIS doesn't publish, a unit we're unsure of. Neither is a template to copy.

**Copernicus Marine Service — <https://data.marine.copernicus.eu/>**

The EU's operational oceanography service, and the closest existing thing to what this
platform does. Use it for:

- **Data.** Global and regional ocean physics and biogeochemistry — temperature, salinity,
  currents, sea level, chlorophyll — as analyses, forecasts and reanalyses, plus in-situ
  observation collections. This is our real second upstream when INCOIS's ERDDAP lacks a
  variable, a period, or a region we need.
- **Conventions.** How a national/international ocean service names variables, states
  units, documents depth levels, and describes product uncertainty. Free calibration for
  our own metadata and microcopy — especially useful against the open unit questions in
  §11.
- **Access (verified against the docs, 2026-09-01).** A free Copernicus Marine account is
  required. Data comes through the `copernicusmarine` toolbox — one Python library exposing
  both a CLI and a Python API (`describe`, `subset`, `get`, `login`) — which subsets to
  ARCO Zarr or NetCDF with no volume or bandwidth quota, or pulls original-format
  NetCDF/GeoTIFF via direct Marine Data Store connections. The current toolbox docs describe
  **no OPeNDAP endpoint**; don't design around one without confirming it still exists.
  Anything we ingest goes behind the FastAPI backend through the `DataSource` interface
  (§12), exactly like INCOIS ERDDAP and NOAA ETOPO — never called from the browser.
- **Attribution is a licence condition, not a courtesy.** Using data from
  `marine.copernicus.eu` means agreeing to the Copernicus Marine Licence (§2.4 of it). This
  app would be an "added product / derivative work", so it must display *"Generated using
  E.U. Copernicus Marine Service Information"* plus the DOI of every product used (each
  product page carries its DOI). Redistributing a dataset as-is additionally requires
  *"Source: European Union, Copernicus Marine Service Information or Data (year), ©Mercator
  Ocean."* Budget the UI space for this **before** ingesting anything, not after.

*What not to take from it:* its interface is a conventional data-catalogue portal — faceted
list, 2D map, side panel. Our brief is the opposite: one 3D water column with instrument
console chrome (§5.1). Borrow its rigour, not its layout.

**NASA Scientific Visualization Studio — <https://svs.gsfc.nasa.gov/>**

The reference standard for making a scientific field legible and beautiful at once, which
is exactly the tension §5.1 and Principle 6 manage. Use it for:

- **Visual language.** How SVS colours a field over a basin or globe, how it labels and
  annotates without shouting, how it renders currents and flow, how a date/depth readout
  sits on frame.
- **Camera and motion.** The load-in descent (Principle 3) and the cinematic register
  chosen in §10 are SVS's idiom — a single motivated move that explains something, not a
  spinning globe or an idle orbit.
- **Licence (verified against svs.gsfc.nasa.gov/help, 2026-09-01).** SVS content is public
  domain unless otherwise noted — free to download, use and redistribute for any purpose.
  NASA's media guidelines *ask* that NASA be credited as the source; that's a request, not a
  licence condition, and we credit anyway. Two real caveats: some visualizations carry
  **licensed music that is not public domain** (the visuals stay public domain, the audio
  doesn't), and individual pages can mark their own exceptions — check the page.
  That we don't ship SVS renders as project assets is a **design decision**, not a legal
  limit: a borrowed film frame shows their data, not ours. §10's Blue Marble basemap sits on
  the right side of exactly that line — public-domain NASA imagery, credited, from Visible
  Earth rather than an SVS film.

*What not to take from it:* SVS makes films for a passive viewer. This is an interactive
instrument a forecaster drives, so a shot that reads beautifully as a 20-second render can
be wrong as a persistent UI state. Take the visual grammar; keep our interactivity and our
instrument chrome.

Anything actually adopted from either source — a colour treatment, a labelling convention,
a new upstream variable — gets a one-line entry in §10, same as any other decision.

---

## 6. Data model

### 6.1 Ocean model field (gridded, from NetCDF)
Dimensions typically: `time`, `depth`, `lat`, `lon`. Variables: `temperature`, `salinity`,
`u`/`v` (current vectors), `chlorophyll`.

Normalized internal representation the backend serves to the frontend:
```json
{
  "variable": "temperature",
  "time": "2026-08-30T00:00:00Z",
  "depth_levels": [0, 10, 25, 50, 100, ...],
  "grid": { "lat": [...], "lon": [...] },
  "data_url": "/tiles/temperature/2026-08-30/depth_0.bin",
  "units": "degC",
  "value_range": [min, max]
}
```

### 6.2 In-situ observation (Argo / Glider / CTD / BGC)
Normalized point-profile schema:
```json
{
  "platform_id": "ARGO_2903456",
  "platform_type": "argo_float",
  "lat": 12.34,
  "lon": 78.9,
  "time": "2026-08-29T18:00:00Z",
  "profile": [
    { "depth": 0, "temperature": 29.1, "salinity": 34.2, "chlorophyll": 0.4 },
    { "depth": 10, "temperature": 28.9, "salinity": 34.3, "chlorophyll": 0.3 }
  ]
}
```

All ingestion parsers (NetCDF model output, Argo, Glider, CTD, BGC) must normalize into
one of these two shapes so the frontend never needs format-specific logic — this is what
makes the "add a new sensor with minimal code change" requirement achievable.

---

## 7. API surface (draft — refine as backend is built)

| Endpoint | Purpose |
|---|---|
| `GET /variables` | List available model variables + metadata (units, valid range). |
| `GET /model-field?variable=&time=&depth=` | Fetch a depth-slice/time-step of gridded data (tile or array). |
| `GET /model-field/isosurface?variable=&value=&time=` | Isosurface extraction request (may be precomputed). |
| `GET /instruments?bbox=&time_start=&time_end=&type=` | List Argo/Glider/CTD/BGC platforms in a region/time window. |
| `GET /instruments/{platform_id}/profile` | Full depth-vs-variable profile for one platform. |
| `GET /wms` / `GET /wcs` | OGC-compliant endpoints for external interoperability. |
| `GET /colorbars` | Available palettes + default min/max per variable. |

---

## 8. Repo structure (as built)

Superseded the original "suggested" tree on 2026-09-01 — this is what actually exists.
Ingestion is organised by *upstream*, not by sensor type, because one ERDDAP reader serves
several sensors and the extensibility claim is carried by the `DataSource` interface.

```
Ocean3D/
├── context.md              ← this file: canon for scope, design, decisions
├── CLAUDE.md               ← frontend working rules
├── CONTRIBUTING.md         ← branch/PR workflow, collision map, pre-PR checks
├── next_session.md         ← status report and the list of traps (§6 = hard-won lessons)
├── .gitattributes          ← line-ending normalisation, binary marks
├── screenshot.mjs          ← full verification pass
├── shot.mjs                ← fast single frame (--skip / --globe / --globe-mode)
├── frontend/
│   ├── public/             (NASA Blue Marble basemaps ×2, INCOIS seal, favicon)
│   ├── scripts/
│   │   └── fetch-textures.mjs   (downloads + resamples the basemaps to 4096×2048)
│   └── src/
│       ├── App.tsx         (all app state: variable, depth, time, mode, view)
│       ├── api/client.ts   (typed API client)
│       ├── components/     (DepthRuler, Colorbar, Timeline, VariablePanel,
│       │                    FloatList, ProfilePanel)
│       ├── styles/         (tokens.css = §5.1 made literal; app.css)
│       └── viz/
│           ├── geo.ts      ← THE shared coordinate frame. Read before touching the 3D.
│           ├── depth.ts    (depth axis, power 0.65 — shared by ruler, volume, charts)
│           ├── scene.ts    (composition, camera, entry gesture, view switching, picking)
│           ├── volume.ts   (raymarched 3D texture of the analysis)
│           ├── terrain.ts  (ETOPO relief mesh, photic-zone fade)
│           ├── ocean.ts    (sky, sea surface, marine snow, light shafts, skyUniforms)
│           ├── globe.ts    (Blue Marble basemap, analysis outline, float markers)
│           ├── water.ts    (shared water-optics GLSL; SCATTER_COLOR)
│           ├── lattice.ts  ← RENDER_ORDER for the WHOLE column. Read before adding
│           │                 anything to the 3D. Also: box gridlines + depth labels.
│           ├── effects.ts  (layer-selective bloom)
│           └── colormaps.ts (cmocean lookup tables)
├── backend/
│   ├── snapshot_fixtures.py     (regenerates the committed fixtures in data/)
│   └── app/
│       ├── main.py, config.py   (config.py holds the PHAILIN scenario + basemap month)
│       ├── erddap_client.py     ← the ONLY place that talks upstream (TLS + URL encoding)
│       ├── cache.py             (disk cache: fresh → network → stale, with provenance)
│       ├── ingestion/
│       │   ├── base.py          ← the DataSource protocol. The PS's extensibility claim.
│       │   ├── erddap_grid.py   (INCOIS griddap → xarray → volumes/surfaces)
│       │   ├── erddap_argo.py   (INCOIS tabledap → pandas; QC filter; decibar → metres)
│       │   └── etopo_terrain.py (NOAA CoastWatch — a second, different upstream)
│       ├── models/schemas.py    (Pydantic, matching §6)
│       └── routers/             (catalog, field, instruments + /compare, terrain)
├── data/
│   ├── sample_netcdf/           (committed fixtures, ~3 MB, regenerable)
│   └── sample_instruments/
└── brand_assets/                (INCOIS seal, MoES marks)
```

**Not built, and named as roadmap in the pitch:** OGC WMS/WCS endpoints, isosurface
extraction, Docker Compose packaging, current *direction* (only speed is drawn). There is
no `tiling/` directory and there should not be — see §10.

---

## 9. Glossary (fill in as the team confirms; problem statement referenced two tables —
Acronyms and Dataset Links — that weren't included in the source doc, so these are
placeholders to complete before the pitch)

| Acronym | Meaning |
|---|---|
| INCOIS | Indian National Centre for Ocean Information Services |
| MoES | Ministry of Earth Sciences |
| EEZ | Exclusive Economic Zone |
| Argo | Global array of profiling floats measuring ocean temp/salinity |
| CTD | Conductivity, Temperature, Depth (sensor) |
| BGC | Bio-Geo-Chemical (sensor/float variant) |
| ADCP | Acoustic Doppler Current Profiler |
| OGC WMS/WCS | Open Geospatial Consortium Web Map/Coverage Service |
| CF Conventions | Climate and Forecast metadata conventions for NetCDF |
| OPeNDAP | Open-source Project for a Network Data Access Protocol |

**TODO (team):** paste the actual Acronyms table and Dataset Links table from the official
PS PDF here — the source document referenced them but the text extraction didn't carry them.

---

## 10. Decision log

*(Claude Code: append here whenever a non-trivial architectural choice is made, one line
each — component, decision, one-line reason, date.)*

- _2026-08-31 — Data source — Use INCOIS's own public ERDDAP (`erddap.incois.gov.in`) as the
  live upstream rather than synthesizing test data. Verified live: 17 datasets, CF-1.6,
  `institution = INCOIS`. Answers §11 Q1._
- _2026-08-31 — Backend is mandatory — ERDDAP returns no `Access-Control-Allow-Origin`, so the
  browser cannot call it directly. FastAPI is required infrastructure, not just architecture.
  It also isolates the incomplete TLS chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`)._
- _2026-08-31 — No Zarr, no tiling — one full 3D volume (24 × 60 × 90, TEMP+SAL) is 1.0 MB as
  NetCDF in 569 ms, ~259 KB per variable as `Float32Array`. Precomputed tiling would be
  premature optimization. Answers §11 Q4 and Q5. Revisit only if grid resolution changes._
- _2026-08-31 — Three.js over CesiumJS — the data is a regional 1° box (30.5–119.5°E,
  29.5°S–29.5°N), so a globe-primary product would render a small patch on a mostly empty
  sphere. Custom Three.js scene gives the water-column language §5.1 calls for. Closes §11 Q2._
- _2026-08-31 — Globe entry admitted, scoped — team chose a hybrid globe → dive entry. Absorbed
  into §5.1 Principle 3 as ONE continuous gesture so it does not become the generic spinning
  globe `CLAUDE.md` Step 4 warns against._
- _2026-08-31 — Data colormaps (cmocean) added to §5.1 — the six brand tokens cannot encode
  physical values without misrepresenting them and failing §5.4's color-vision requirement.
  Chrome and data are now two documented, non-overlapping color systems._
- _2026-08-31 — Demo scenario: Cyclone Phailin, Oct 2013 — the only window where the 3D grid,
  in-situ floats, AND the hazard fields (D26/HTCNT, which stop 2019-03-30) all overlap.
  INCOIS/IMD's landmark forecast; fits the Disaster Management theme directly._
- _2026-08-31 — Argo QC filtering is a correctness requirement, not polish — float `2900757`
  looked like a −4.03 °C cold wake but is unusable: 2 rows/cycle, all at 0 db, `TEMP_QC=4`,
  salinity 0.014 PSU. Use `2901335` (≈155 good levels/cycle, −2.6 °C in 24 h, recovers by
  Oct 20) and `2901327` (subsurface: 100 m, 23.72 → 20.27 °C). Reject `QC ∉ {1,2}` at ingestion._
- _2026-08-31 — Pressure vs depth — grid `ZAX` is metres, Argo `PRES` is decibar (~1.02 db/m).
  Convert in exactly one place at ingestion, or the model-vs-observation comparison silently
  misaligns. Uses the UNESCO/Fofonoff-Millard formula, which is latitude-dependent._
- _2026-09-01 — No Tailwind — plain CSS against `tokens.css` custom properties instead. The
  instrument-console language (hairline dividers, real rulers, exact tick spacing) is not what
  a utility framework is good at, and dropping it removes both a config surface and the
  gravitational pull toward the generic SaaS look `CLAUDE.md` Step 4 warns about._
- _2026-09-01 — Square-root depth axis — nearly all structure (mixed layer, thermocline, cold
  wake) sits in the top 200 m of a 2000 m column, which a linear axis squeezes into 10% of the
  height. Defined once in `viz/depth.ts` and shared by the 3D column, the depth ruler and the
  profile chart, so all three agree on where a depth sits. Ticks always carry true metres._
- _2026-09-01 — Land is derived from the analysis's own no-data mask, not a coastline asset.
  It cannot drift from the data, needs no external file, and its blockiness is a true statement
  about the 1° grid. Note it shows *no data*, so mid-ocean analysis gaps also appear._
- _2026-09-01 — The globe is a graticule, not a textured Earth. A blue marble is the generic
  tell `CLAUDE.md` Step 4 names, and a photographic sphere would imply global coverage we do
  not have._
- _2026-09-01 — Percentile (2–98%) colour clipping — geostrophic currents diverge as 1/f toward
  the equator and chlorophyll is strongly right-skewed, so raw min/max lets one outlier flatten
  the colorbar (chlorophyll: 0.12–9.27 raw vs 0.28–1.29 clipped). True range is still reported
  and the colorbar says when clipping applied._
- _2026-09-01 — A keyboard-reachable float list, not just 3D markers. A marker in a WebGL scene
  cannot be tabbed to, so the same selection is offered as a real list. It is also faster for a
  forecaster who already knows the platform they want._
- _2026-09-01 — ERDDAP queries must be percent-encoded. Its syntax uses RFC 3986 reserved
  characters (`[`/`]` for griddap, `<`/`>`/`"` for tabledap) and Tomcat rejects them raw with a
  bare HTTP 400. Verified: every raw request failed, every encoded one succeeded._
- _2026-09-01 — Volume geometry is a UNIT cube scaled to the field aspect. The raymarch shader
  intersects against [-0.5, 0.5] in object space, so a pre-sized `BoxGeometry` leaves it marching
  only the central unit cube and silently clipping most of the field away._
- _2026-09-01 — The viewport became a place (§5.1, Principle 6). The first build rendered the
  analysis as a lit box in a black void, which read as a chart of the ocean rather than the
  ocean. Added sky, sea surface, ETOPO relief and depth-dependent light absorption._
- _2026-09-01 — ETOPO from NOAA CoastWatch ERDDAP as the terrain source — 1 arc-minute global
  relief, `altitude` in metres (-10898..8271). A Bay of Bengal context box (0-25°N, 75-100°E)
  at stride 4 is 376×376 ≈ 550 KB and spans -5486 m to +3008 m, so one fetch gives both the
  seafloor and the land. Implemented against the same `DataSource` interface as INCOIS, which
  makes the problem statement's extensibility claim demonstrable rather than asserted._
- _2026-09-01 — Team chose the cinematic register over the restrained one, and fixed maximum
  quality over auto-degrading quality tiers. Recorded because it is a deliberate override of
  `CLAUDE.md` Step 4's restraint guidance: the resolution is that the **ocean** is cinematic
  while the **data** stays scientifically rendered, enforced by keeping bloom on its own render
  layer. Performance risk on integrated graphics is accepted knowingly; no quality switch._
- _2026-09-01 — Camera default is an elevated 3/4 view above the waterline, not the split-
  waterline shot. A forecaster needs to see the whole basin and every float at once; the
  dramatic half-above-half-below framing loses that overview. Elevation was later lowered to
  ~16° so the thermocline is seen side-on; from above, a water column shows only its warm lid._
- _2026-09-01 — **The data column and the seafloor cannot share one vertical axis.** This cost
  four rebuilds and is the single most important thing to know before touching viz/geo.ts.
  The analysis needs heavy exaggeration to read as a water column; the seafloor needs almost
  none to read as a basin. On one shared axis the continental slope — 2 km of drop over 60 km
  — renders as a sheer wall, and it sits at 0–700 m, inside the band you can actually see, so
  fading the abyss below it does not help. Smoothing did not help. Clamping the depth made it
  worse: a flat floor with a hard rim, which is itself a wall. What worked: the analysis keeps
  a power-curve axis at ~425×, the seafloor gets its own *linear* axis about a quarter as
  steep, and the seafloor dissolves out below ~250 m because that is where light stops. The
  cost, stated in the UI, is that seafloor height is indicative; nothing reads a depth off it._
- _2026-09-01 — Depth axis exponent moved from 0.5 (square root) to 0.65. Square root has
  infinite slope at zero, which made the coastline itself a vertical cliff once the seafloor
  shared the axis. 0.65 keeps most of the surface emphasis and is well-behaved at zero._
- _2026-09-01 — No tone mapping on the renderer. ACES filmic looked better on the water but
  remaps every colour in the frame, the data volume included, which would shift a reader's
  sense of a temperature away from what the colorbar states._
- _2026-09-01 — Deep water renders by fading INTO the water colour, not to black. Absorption
  alone turns distant seafloor black, and black is not invisible: against lit water it reads
  as a silhouette, which is how the exaggerated slope kept reappearing after it was "hidden"._
- _2026-09-01 — The globe got real geography (`viz/globe.ts`). It was a featureless dark disc:
  its graticule sat at exactly the sphere's radius and lost the depth test, and there was
  nothing else on it. Now: Natural Earth 110m coastlines (64 KB, bundled in `public/` rather
  than fetched from a CDN, since the deployment target cannot depend on outside hosts), filled
  continents via an equirectangular land mask drawn to a canvas at runtime, a day/night
  terminator, and an atmosphere rim. Still not a textured blue marble — that remains the
  generic tell `CLAUDE.md` Step 4 names, and imagery would imply global data coverage._
- _2026-09-01 — Globe rotation now accounts for camera azimuth. The old formula ignored it, so
  the entry flew toward the Atlantic while claiming to dive into the Bay of Bengal._
- _2026-09-01 — The entry gesture advances per frame, not per wall-clock millisecond, capped so
  it always spans at least ~45 frames. On slow hardware the whole gesture used to elapse in
  two or three rendered frames — the product's one orchestrated moment, invisible exactly on
  the machines least able to spare it. It now takes longer in real time when the machine is
  slow, and stays skippable._
- _2026-09-01 — Two standing external references adopted (§5.5): Copernicus Marine Service
  (`data.marine.copernicus.eu`) for supplementary ocean data and service-grade metadata/unit
  conventions, and NASA's Scientific Visualization Studio (`svs.gsfc.nasa.gov`) for
  scientific-visualization visual language and camera grammar. Both are references to
  consult, not systems to clone — Copernicus's catalogue-portal layout and SVS's
  passive-film framing are each wrong for an interactive instrument._
- _2026-09-01 — **REVERSES "the globe is a graticule, not a textured Earth."** The team
  supplied four NASA SVS "Perpetual Ocean" frames and asked for the globe replicated as
  closely as possible. The old entry's reasoning still stands on its own terms — a
  photographic sphere does imply worldwide coverage we lack — so the risk is paid down
  rather than dismissed: §5.1 Principle 7 now forbids painting any field onto the sphere at
  global extent, the analysis extent and the floats are the only marks on it, and the
  globe-mode status line states the basemap is a static 2004 image. The graticule and the
  coastline lines are deleted rather than layered under the texture._
- _2026-09-01 — **REVERSES "the globe is never a destination, and no control returns the
  user to it"** (§5.1 Principle 3). A Globe/Column toggle now returns to it, and clicking
  the analysis outline dives back down. What survives the reversal: the app still opens by
  diving, so the globe is never the default view, and the globe never rotates on its own —
  §5.5 names "a spinning globe or an idle orbit" as precisely the wrong idiom._
- _2026-09-01 — Basemap is NASA Blue Marble Next Generation w/ Topography and Bathymetry,
  resampled to 4096×2048, bundled in `frontend/public/` (~1.6 MB per month). "topo.bathy" matters: NASA
  bakes shaded relief into the pixels, which is where the reference frames' visible
  mid-ocean ridges and Greenland ice dome come from — so no separate normal or elevation
  map is needed. **This does not contradict §5.5's "we don't ship their imagery."** That
  line governs the Scientific Visualization Studio (`svs.gsfc.nasa.gov`), whose renders and
  films we study but do not redistribute. BMNG is NASA Earth Observatory / Visible Earth
  (`eoimages.gsfc.nasa.gov`) — a public-domain basemap, credited in the UI. Both months
  (Oct + Dec 2004) ship so a scenario picks its own season; Phailin uses October._
- _2026-09-01 — `coastlines-110m.json` deleted (65 KB), along with the runtime land-mask
  canvas and the graticule. Once the sphere carries real imagery all three are redundant —
  the texture already draws coastlines, better. Recorded because the previous session added
  them deliberately; they were the right answer for an untextured globe, not a mistake._
- _2026-09-01 — **Globe textures must be power-of-two.** NASA publishes BMNG at 5400×2700,
  which is NPOT. With mipmaps enabled that texture broke mip generation badly enough to
  corrupt the GL context: three unrelated materials (Points, LineBasic, Shader) all failed
  `VALIDATE_STATUS` and the canvas rendered nothing — a blank viewport whose console error
  named a `LineBasicMaterial`, pointing nowhere near the actual cause. Reproducible under
  the harness's SwiftShader; untested on real GPUs, which may well tolerate it. Disabling
  mipmaps also clears it but is the wrong fix — ~900 px of globe against 5400 px of texture
  is 6:1 minification, which without mipmaps aliases badly on real hardware. Resampled to
  4096×2048 instead, which is still ~2× more resolution than the globe can resolve. **If a
  texture is ever swapped in here, keep it power-of-two.**_
- _2026-09-01 — The basemap gets a gamma shadow-lift (≈1.5) in the globe shader. BMNG's
  deep ocean sits at 3–12% luminance and read as a black hole with a coastline around it;
  the reference frames show a mid-blue sea with the ridges legible across it. A flat
  multiplier would have blown out Antarctica long before the ocean moved. **This does not
  contradict the no-tone-mapping decision above** — that one forbids a renderer-wide curve
  because it would also remap the data volume. This is confined to one shader, on a basemap
  that by Principle 7 encodes nothing._
- _2026-09-04 — The chunk view gets a lattice and the observation enters the 3D (§5.1
  Principle 8). The column read as blank, and the cause was structural, not a tuning problem:
  `uDensity` is stuck between a slab (too high) and a haze (too low) because a uniform fog has
  no edges, and by design no lighting may touch the data. The fix is to give the eye reference
  surfaces it can read structure against — far-face gridlines at the ruler's own tick values —
  rather than to keep tuning density. Rejected from the reference mock that prompted this: its
  rainbow colormap (cmocean stays, per §5.1) and its box-in-a-void framing, which is this
  project's own recorded "before" state._
- _2026-09-04 — Depth markings are suppressed for surface variables. Four of seven variables
  are `kind="surface"` (chlorophyll, D26, heat content, MLD), so `shape[0] == 1` and one value
  is smeared down the whole 2000 m box. Harmless while nothing marked depth; the moment a
  label says "500 m" it asserts a measurement that does not exist. Correctness, not polish._
- _2026-09-04 — The float ribbon is drawn with a raw GLSL3 material, not `Line2`. Three's
  `LineMaterial` fragment shader ends with `<tonemapping_fragment>` and `<colorspace_fragment>`;
  `toneMapped = false` neutralises the first and nothing neutralises the second. It is identity
  only because the composer's targets happen to be Linear-sRGB today — change that and the
  ribbon shifts colour while the volume does not, silently disagreeing with the colorbar. Same
  reasoning as the no-tone-mapping decision above, arriving through an addon instead of a
  renderer setting._
- _2026-09-04 — Three bugs fixed while building the above, all pre-existing. (a) `clearVolume`
  disposed geometry and material but not the `Data3DTexture` or LUT held in uniforms —
  `ShaderMaterial.dispose()` does not reach them — so every timeline step leaked ~0.7 MB.
  (b) `setField` discarded `buildVolumeTexture`'s `encodedRange`, which for diverging maps is
  re-centred on zero and is therefore NOT `meta.value_range`; anything colouring against the
  latter disagrees with the volume. (c) `dispose()`'s blind traverse would have disposed Three's
  module-shared Sprite geometry once sprites existed._
- _2026-09-04 — **The volume gets a transfer function; opacity stops being constant.** This is
  the actual reason the column read as blank, and the lattice above did not fix it. Every
  sample in the box carried the same opacity: colour varied with the value, opacity did not,
  which is the definition of a homogeneous fog — it cannot show structure at any density,
  because nothing in it is more present than anything else. `uDensity` was therefore stuck on
  a bad axis, higher being an opaque slab and lower being haze, with no setting in between
  that had form. Opacity is now driven by local gradient magnitude, so a thermocline, a front
  or the edge of a cold wake reads as form while still water recedes to `uStructureFloor`.
  **Colour is untouched** — this stays inside the one channel this renderer was always
  permitted to modulate, so the colorbar remains exactly true._
- _2026-09-04 — Gradient is computed on the CPU at upload and packed into the texture's G
  channel, not sampled in the shader. In-shader central differences would have cost six extra
  3D-texture fetches on every one of 160 raymarch steps. G already carried validity, so the
  encoding keeps 0 = no data and puts valid samples in 128–255: the shader's `g < 0.5` land
  test is unchanged and land still cuts off cleanly under linear filtering, with the remaining
  seven bits carrying structure._
- _2026-09-04 — Gradient is normalised PER DEPTH LAYER, floored at 18% of the global scale.
  On one global scale the thermocline saturates and the whole deep column collapses to the
  floor — the box keeps its lid and loses its depth, which is a different lie from the fog it
  replaced. Per-layer, an eddy at 800 m is visible at all. Opacity is not a quantitative
  channel here (colour is), so rescaling it by depth states nothing false; the floor is what
  stops a genuinely uniform layer from being divided by its own noise into invented structure._
- _2026-09-04 — Those percentiles come from a 1024-bin histogram, not from sorting. Sorting
  345,600 gradients once globally and again per layer measured at **77.5 ms per field load** —
  a visible hitch every time the timeline steps. The histogram is one linear pass: **35.5 ms
  median, 19.3 ms warm.** Measured, not estimated._
- _2026-09-04 — **The atmosphere was drawing ON TOP of the data, and had been all along.**
  `ocean.ts` numbered the sea surface 6, marine snow 7 and light shafts 8; the `RENDER_ORDER`
  table added earlier the same day numbered ribbon 6, stems 7, markers 8 without reading that
  file. Both stacks are children of `worldGroup` with `depthWrite: false`, so the sea plane
  composited over every pixel of the analysis at **α ≈ 0.66**: a cmocean deep red of
  (0.40, 0.05, 0.10) reached the screen as (0.17, 0.15, 0.21). Two rounds of shader tuning went
  into a field that was being veiled a moment after it rendered, and the promise `volume.ts`
  makes in its own comments — that nothing shifts a data colour — was being broken one file
  over. Fix: every renderOrder in the column now lives in that one table, background included,
  with scenery on negative numbers. **If a renderOrder is written anywhere else, the table is
  already wrong.**_
- _2026-09-04 — The sky is a depth ramp continued through the waterline, not a bright dome.
  `skyColour` ran a bright horizon plus a haze term symmetric about `dir.y = 0`, so with the
  camera near eye level most of the frame came back at ~(0.11, 0.40, 0.50) — the brightest
  large area in the image was the background, above the data. It now darkens with depth below
  the waterline (§5.1 Principle 1 made literal) and the horizon band is narrow and one-sided.
  This is also why the light shafts looked mis-tuned at α 0.055: against the old ground they
  were a 10% perturbation, i.e. nothing. Against the new one they barely needed raising._
- _2026-09-04 — **REVERSES "Camera default is an elevated 3/4 view above the waterline."** The
  default view is now submerged, ~86 m down, with the analysis filling ~58% of frame height
  instead of 25%. The old entry's reasoning — a forecaster needs the whole basin — is paid down
  rather than dismissed: dragging up still returns to that overview, and the entry gesture now
  ends by diving *through* the surface rather than hovering above it. The `fitScale` cap came
  down 2.4 → 1.6 in the same change, because at 2.4 a narrow viewport lifts the eye back above
  the water and silently flips the whole design's regime._
- _2026-09-04 — Terrain dissolves radially in the analysis box's own half-widths (superellipse,
  p = 4). ETOPO is requested 25°×25° against an 18°×17° analysis, so it overhung the data by
  ~1.4× and ended in a hard lit rectangle that read as torn paper rather than seabed. A circle
  would clip the box's corners and a `max()` reproduces the rectangle it is hiding. Both
  branches take the fade — the land branch previously returned alpha 1.0 and kept its edge._
- _2026-09-04 — Markers are dimmed below the colormap. At full token brightness a resting
  marker renders at foam (0.918, 0.953, 0.945), level with the top of every cmocean ramp, so
  chrome outshone the data it points at. Resting states are scaled (foam ×0.62, featured
  bioluminescence ×0.78); only the selected marker is allowed to be the brightest chrome. The
  bloom composite was also unclamped `base + glow`, so a marker landed near 2.0 and clipped to
  a flat white disc — that is what made them read as lens flares._
- _2026-09-04 — **The light shafts were upside down.** `vertical = pow(1.0 - vUv.y, 2.1)`, but
  `PlaneGeometry` puts `uv.y = 1` at the TOP row and the shafts hang from the waterline — so
  the expression put zero brightness exactly where sunlight enters and full brightness at the
  deep end, contradicting the comment directly above it. This is why raising their alpha never
  helped: the lit end was buried in the dark. Now `pow(vUv.y, 1.7)`, α 0.055 → 0.20, and the
  planes billboard to the camera azimuth (as flat planes with a fixed random yaw, about a
  third of them were edge-on and invisible at any moment)._
- _2026-09-04 — **Land never went through the water.** Every other surface in `terrain.ts`
  composites through `applyWater`; the land branch returned its lit colour directly, so coast
  drew at full contrast however much sea lay between it and the eye. Above water that passed;
  from below it made the coastline read as hard cardboard slabs pasted over the scene. Land now
  fogs like everything else, at depth 0._
- _2026-09-04 — `SCATTER_COLOR` raised to (0.062, 0.24, 0.305) to match the new near-surface
  water. Fog can only hide something if it fades it into the colour it is seen AGAINST: at the
  old (0.036, 0.125, 0.176) the terrain fully fogged to roughly half the background's
  brightness and so still read as a dark silhouette. This is the same failure the §10 entry on
  "deep water fades INTO the water colour, not to black" describes — the target simply drifted
  out of step when the background changed. **If `uNearSurface` moves, this moves with it.**_
- _2026-09-04 — The underwater ramp has to complete inside the visible band. The first attempt
  ran `smoothstep(0.02, 0.34)` then `smoothstep(0.30, 0.90)` between three near-black colours;
  with a 42° fov the lower frame only spans `d ≈ 0..0.47`, so the second stop never engaged and
  the whole thing read as a flat dark void — a different failure from the flat bright void it
  replaced, but the same shape of mistake. A gradient needs luminance range, not just a ramp._

- _2026-09-05 — **A 2D map view, and its data comes from new global upstreams.** The
  references supplied (Copernicus MyOcean Pro, NASA Worldview) are global; INCOIS's own
  grid is a regional box, so a world map needed a second upstream. HYCOM GLBv0.08 via
  APDRC (`hawaii_soest_6a0a_5127_d118`) supplies it: global 0.08°, **40 depth levels to
  5000 m**, daily 1994–2015, with `water_temp`, `salinity`, `water_u`, `water_v`. One
  dataset therefore serves the coloured field, the depth slider, the profile, the
  depth-time section and the streamlines. Global chlorophyll comes from
  `noaacwNPPVIIRSSQchlaDaily` at `coastwatch.noaa.gov` (4 km, 2012→present). Both reach
  the app through the existing `griddap_url(base=...)` path already proven by ETOPO._
- _2026-09-05 — **`coastwatch.pfeg.noaa.gov` and `upwell.pfeg.noaa.gov` are dead hosts.**
  NOAA retired the PFEG ERDDAP; `/griddap/<dataset>` is refused there while
  `coastwatch.noaa.gov` and `www.ncei.noaa.gov` answer normally. `TERRAIN_BASE` pointed at
  the dead host, so terrain had been loading only from the disk cache and a fresh clone
  would have silently lost the seafloor. Repointed to NCEI's ArcGIS ImageServer
  (`ETOPO1_bedrock`), which returns real Float32 metres as a tiled GeoTIFF; decoded with
  struct + numpy rather than adding Pillow for forty lines of header. **Arbitrary boxes now
  work**, which the area→3D bridge needs and the old fixed dataset could not do._
- _2026-09-05 — **The value→colour mapping is now defined once.** The diverging re-centring
  lived inline in BOTH `viz/volume.ts` and `components/Colorbar.tsx`, and the map's
  rasterizer would have been a third copy — which is how the same value ends up a different
  colour in the map and in the water column. Extracted to `encodeRange` / `normaliseValue` /
  `lutIndex` in `viz/colormaps.ts`; both existing call sites rewired, pixel-identical._
- _2026-09-05 — **The map rasterizes on the CPU, not in a shader.** §10 already records two
  incidents of a GPU path silently shifting a cmocean value away from its colorbar. Writing
  LUT bytes straight into an `ImageData` removes the whole class: no colour-space conversion,
  no premultiplied alpha, no filtering mode. It is also the only version that can be tested —
  the harness runs SwiftShader and says nothing about shading, whereas `raster.ts` is pure and
  asserted byte-for-byte. Cost is not the constraint: colouring is keyed on the data, so pan
  and zoom never re-colour anything, they blit a bitmap that already exists._
- _2026-09-05 — `imageSmoothingEnabled = false` on every map canvas. Bilinear scaling
  interpolates between LUT entries and produces RGB triples that are not in the cmocean ramp,
  and bleeds land colour across coastlines. Blocky at low zoom is the honest result: it shows
  the real grid._
- _2026-09-05 — **The map's land comes from the data's own no-data mask**, not from a
  bathymetry asset. Same reasoning as the 2026-09-01 entry for the 3D view, and at a global
  grid it is a finer coastline than a strided ETOPO file would give, for no extra request._
- _2026-09-05 — Point readouts are one request, not four. A depth × time block at a cell is a
  superset of all four panels: values are one cell, the profile a column, the series a row,
  the section the block. Measured 5–9 s cold for 40 levels × 31 days and instant once cached,
  which is worth it against a panel that shows one chart and then rearranges itself._
- _2026-09-05 — Mixed cadences are shown, not smoothed. There is exactly one clock; each layer
  resolves it to its own **nearest** step and states the offset (`−3 d`) in its housing when it
  exceeds half a cadence. The timeline draws one tick row per visible layer, so a daily field
  and a monthly field visibly differ. A layer outside its coverage greys and its fetch is
  skipped rather than silently drawing nothing._
- _2026-09-05 — The depth ruler is **removed from the DOM** for a surface field, not disabled.
  A greyed ruler still asserts that a depth exists to slice. This is the 2026-09-04
  "depth markings are suppressed for surface variables" rule made structural._
- _2026-09-05 — The provenance chip names the upstream actually in use. `"Live · INCOIS
  ERDDAP"` was hardcoded, so a HYCOM or VIIRS layer was credited to INCOIS. Provenance is the
  one thing this app must not get wrong, and a hardcoded source string cannot stay right._

- _2026-09-05 — **Copernicus Marine adopted as a third upstream, on a third protocol.**
  GLORYS12V1 (`cmems_mod_glo_phy_my_0.083deg_P1D-m`) is global 0.083°, **50 levels to 5728 m,
  daily 1993 → 2026-06**, and the analysis/forecast product reaches **ten days past today** —
  strictly better than HYCOM on resolution, depth and recency, so it is now the map's default
  layer. Two measured constraints shape the implementation: CMEMS has **no server-side
  striding** (a global slice is the full 17 MB whatever we draw) and carries **~11 s of fixed
  per-request overhead**. So the backend downsamples after the fetch and caches the
  *downsampled* array: 11.6 s cold, **0.03 s cached**. Credentials live in `backend/.env`
  (gitignored); without them the Copernicus layers simply do not appear and every other source
  still works. `copernicusmarine` is the only non-HTTP dependency in the project._
- _2026-09-05 — The Copernicus credit line and product DOI render inside the layer housing, not
  in a footer. It is a licence condition (§5.5), so it ships attached to the layer it describes
  rather than somewhere a reader can scroll past._
- _2026-09-05 — **A truncated time axis is a display sample, not the real steps.** CMEMS is
  daily over 12,227 days; the timeline receives every 7th stamp so the rail stays ~36 KB.
  `resolveLayerTime` was snapping to that sample and reporting a "−4 d" offset on a product
  that has a step for every single day. Truncated axes now resolve arithmetically instead. The
  offset chip must only ever report an offset the data actually has._

- _2026-09-05 — **The map draws coastlines and national borders.** Reference geography, not
  decoration: it is what lets a reader say "that warm tongue is off Somalia" rather than
  "somewhere". Same class of mark as the graticule the map already draws, so §5.1 Principle 7
  is not touched — that bars painting a *field* at a coverage we lack, not orientation marks.
  **Strokes only.** The filled land is still the data's own no-data mask (§10, 2026-09-01), so
  a coastline can never hide an ocean cell or invent one: the mask governs what is true, the
  lines govern what is legible. Natural Earth, public domain, bundled in `public/` by
  `scripts/fetch-geography.mjs` because the deployment target cannot call out. Two levels —
  110m (117 KB) at world zoom, 50m (1.1 MB) past 2.5x world-fit; shipping only the fine set
  would draw far more segments than the screen can resolve on every pan. No labels: names over
  the field would compete with the one thing §5.1 says nothing should._
- _2026-09-05 — The coastline is drawn with a **dark casing**, and this inverts §5.1 Principle
  8's corollary. There a dark data mark was lost against dark water, so the casing was `foam`.
  Here a light stroke is lost against the bright end of a cmocean ramp — the tropics run
  near-yellow and a 62% foam line disappears into them while reading perfectly at the poles. A
  dark sheath one step wider separates it from bright ocean; the light core separates it from
  near-black land. The casing encodes nothing and cannot tint the field: it is drawn on the
  basemap canvas, beneath the data, never over it._

- _2026-09-04 — **Interactive Layer Stack Hierarchy & Uppermost Active Layer Rendering (§5.1, Principle 12).**
- _2026-09-04 — **Data Catalogue Modal Streamlining.**
- _2026-09-04 — **ToolDock & Development Testing Badges.**
- _2026-09-05 — **Side-by-Side Right HUD Architecture & Non-Conflicting Layout (§5.1, Principle 11).**
- _2026-09-05 — **Vertical Depth Slider with 24-Level Physical Discretization (§5.1, Principle 12).**

- _2026-09-05 — **The side-panel branch merged.** Its five decisions follow, renumbered:
  both branches independently added a §5.1 Principle 8, so the layer-stack, HUD-layout and
  depth-discretization principles moved to 10, 11 and 12. Nothing was dropped from either
  side; CONTRIBUTING §13 anticipated exactly this collision._

- _2026-09-05 — **A layer is a VARIABLE, not a dataset.** Merging the side panel raised the
  question of what "Add layer" means when two views draw from different upstreams. Answer:
  the catalogue offers variables, and each view resolves one to whichever source serves it
  best — the 3D column gets INCOIS's analysis, the map gets Copernicus, VIIRS or INCOIS by
  `preference`. `MapDataset.variable_key` is what makes that resolution possible, and
  `map_dataset_for()` is the single place it happens. The alternative, listing every dataset
  separately, doubles the catalogue and lets a user add a layer one view cannot draw._
- _2026-09-05 — The layer card must describe **the source the active view is drawing**, not a
  fixed one. It hardcoded "10-Daily Analysis" and read a single `fieldMeta`, so on the map it
  credited INCOIS for a Copernicus field, showed the 3D field's date, and printed temperature's
  range under chlorophyll's units. Now `fieldMetaByKey` and `sourceLabelByKey` give every card
  its own range, date and provider. A stack drawn from three servers needs three labels._
- _2026-09-05 — The data catalogue's variable chips were `<div onClick>`: not focusable, no
  role, no pressed state. Converted to real buttons with `aria-pressed`. CLAUDE.md's quality
  floor makes keyboard operability non-negotiable, and it is also why the add-layer flow could
  not be driven by the verification harness._
- _2026-09-05 — Two factual errors fixed in the merged catalogue: it used the key `mld` where
  the backend serves `mixed_layer_depth` (so adding that layer produced a key nothing serves),
  and it described the INCOIS product as "0.083° × 50 levels, 1–20 Oct 2013". The real grid is
  1° with 24 levels running 2004 to 2026; 0.083°/50 is Copernicus's spec, which the map uses
  and the column does not._

- _2026-09-05 — **§5.1 updated to describe the shipped design, not the intended one.** The
  merged side panel is rounded, elevated and drawn from slate+cyan; §5.1 still specified flat
  square housings in six tokens. The team reviewed both and chose the panel, so canon follows
  the code — new §5.1.2 records the real radii, shadows and palette, and Principles 2 and 9
  and §5.2 are amended rather than quietly rewritten, so the reversal stays visible. What did
  not move: cmocean still owns data colour, no chrome colour encodes a value, readouts stay
  mono, and every layer still states its source and range. The rounding is a container
  decision and buys no licence over how a measurement is drawn._

- _2026-09-06 — **An AI assistant, and the grounding rule is structural rather than
  prompted.** The assistant can answer about the water and drive the app ("add the
  chlorophyll layer and hide temperature"). The danger it introduces is specific: a
  plausible invented sea temperature inside an INCOIS-branded tool is worse than no
  assistant. So the panel builds its citation line from the tool calls that actually
  ran, never from the prose — an answer that fetched nothing has nothing to cite and is
  visibly marked as general knowledge. The prompt states the rule too, but the interface
  does not rely on the model having followed it. See §5.1 Principle 13._
- _2026-09-06 — **Gemini, and the API is not the one in anyone's memory.** `gemini-3.8-flash`
  through `google-genai` 2.22, which is `client.interactions.create(...)` returning an
  `Interaction` with `steps` and `output_text` — a `function_call` step answered by a
  `function_result` entry. This replaced the `generate_content` surface; verified against
  the installed package and the live docs, not recalled. Key in gitignored `backend/.env`,
  server-side only (§5.5). `store=False`, so no transcript persists on Google's servers —
  the defensible choice for a government deliverable. Without a key the dock button states
  the reason and everything else works, the same degradation the Copernicus layers have._
- _2026-09-06 — **The tool loop is split, because half of it cannot run on the server.**
  Read tools execute in the backend against the endpoints the UI already uses. Action
  tools mutate React state in a browser, so they are *validated* server-side against a
  state snapshot the client sends with every message, then returned for the client to
  apply. That is what lets the model be told the truth about whether an action succeeded —
  it learns "that would need more than 3 layers" rather than assuming it worked._
- _2026-09-06 — **`zoom_to_region` resolves a fixed table and nothing else.** A model
  supplying its own bounding box for a place name is the most dangerous kind of wrong
  here, because a plausible-looking box is indistinguishable from a correct one on screen._
- _2026-09-06 — **SQLite, not Supabase, for conversations and cached analyses.** Asked for
  Supabase first, then delegated the choice. §1 requires deployability on INCOIS
  infrastructure and a hosted database is an outbound dependency a government network may
  refuse; §4 already sanctions "SQLite for demo". Behind a `ConversationStore` protocol —
  the same shape as `DataSource` — so a later swap is a class, not a rewrite. The
  `analysis_cache` table is also the free-tier mitigation: a repeated question skips both
  the upstream and the model._
- _2026-09-06 — **Writing a layer from outside has TWO wrong seams, and both fail
  silently.** Found by building the assistant, and corrected once during the build.
  (a) `dispatchMap({type:"layer/add"})` is overwritten by the `layers/sync` effect, which
  derives `map.layers` from the stack. (b) `setLayerStack` alone changes nothing on screen:
  **`VariablePanel` owns the stack in its own `useState`** and only mirrors it up, so
  `App.tsx`'s `layerStack` is downstream, not the source. The working seam is to set the
  mirror AND hand the panel a stack through a new `externalStack` prop, whose nonce marks
  it a fresh instruction — a nonce rather than value equality, so undoing back to a stack
  you were already in still applies. Lifting the state out of `VariablePanel` would be the
  cleaner fix and is a much larger change to a file several people touch. Both failure
  modes look identical from outside: the assistant cheerfully reports a change that did not
  happen, which is the worst shape of bug this feature can have._
- _2026-09-06 — **Gemini's free-tier quota is per model, and the newest model is the
  exhausted one.** Measured on a real key: `gemini-3.8-flash` returned 429 (limit 20/min,
  ~55 s to reset) while `gemini-3.5-flash` answered immediately with the same request.
  Default moved to 3.5-flash; `GEMINI_MODEL` overrides it. Also measured: inlining the
  screen state and the variable catalogue into the system prompt cut a layer command from
  three rounds to two, and two is the floor for a tool loop (one call, one summary). Each
  round is one request, so on a per-minute quota that is the difference between working and
  not. A 429 is surfaced as "the free Gemini quota is used up for the moment" with the
  retry delay Gemini itself names, and nothing else in the app is affected._

- _2026-09-06 — **The assistant answers beyond the ocean, and Google Search grounding is
  wired but unusable on a free key.** It first refused "what is a barrel of oil worth"
  with "I can only assist with oceanographic data" — untrue and the worst answer it can
  give. Two causes: the prompt scoped it, and a current price is genuinely not in any
  model's weights, so widening the prompt alone would have produced a stale figure stated
  as current. Both fixed: the prompt now allows general knowledge, and `google_search` is
  in the tool list with web sources rendering as clickable citations, marked `kind="web"`
  and styled apart from measured ones — a page Google returned is not the ocean analysis.
  **Measured: grounding is billed separately and is NOT in the free tier.** Every request
  carrying the tool returns 429 "check your plan and billing details" while the identical
  request without it succeeds, so adding it unconditionally would have broken every
  question including ocean ones. The client strips search and retries on a quota error,
  remembers the result for the process, and `GEMINI_SEARCH=off` skips the probe. Enable
  billing and live answers begin with no code change; until then it says "I cannot check
  a live value from here" and dates what it does remember._

---

## 11. Open questions for the team

- ~~Do we have access to real INCOIS sample NetCDF files?~~ **Answered 2026-08-31.** Yes —
  INCOIS's public ERDDAP serves real CF-1.6 NetCDF. No synthesis needed. See §10.
- ~~Three.js vs CesiumJS~~ **Answered 2026-08-31.** Three.js. The data is a regional box; a
  globe-primary product would render a small patch on an empty sphere. See §10.
- ~~Target demo dataset size — Zarr/tiling now or later?~~ **Answered 2026-08-31.** 1.0 MB per
  full 3D volume. Neither, for this grid. See §10.
- ~~Does the load-in descent work performance-wise?~~ **Answered 2026-08-31.** Yes — at
  129,600 points the volume is trivial for WebGL2. See §10.
- **Still open:** how much "isosurface extraction" is a working demo vs. a roadmap item?
  Currently scoped as a Phase 5 stretch goal, described in the pitch as roadmap.
- **Still open (team):** paste the official Acronyms and Dataset Links tables from the PS PDF
  into §9 — the source text extraction dropped them. Needed before the pitch, not the build.
- **New, still open:** the value-added hazard fields (D26, HTCNT, GEO_U/V) stop at
  2019-03-30, while the 3D grid runs to Jul 2026. If a "recent data" mode is added later,
  those layers must degrade with a stated reason rather than silently vanish.
- **New, still open (design, and the biggest one):** **the product now has two chrome
  palettes.** The 3D viewport uses the six named tokens; the floating console uses slate+cyan
  (`#22d3ee` and seven greys) that `tokens.css` does not define. Two of them duplicate roles
  the tokens already fill — `#22d3ee` does what `bioluminescence` does, `#020617` what `abyss`
  does. Either the six tokens absorb the console (restyle the panels to the tokens) or the
  console's palette is adopted into `tokens.css` and the viewport follows it. Leaving both is
  the one option that is actively wrong, because a reader cannot learn what a colour means
  when the same role has two values. See §5.1.2.
- **New, still open (assistant, one-line decision):** **enable billing on the Google Cloud
  project, or accept that the assistant cannot look anything up.** Google Search grounding
  is implemented and inert on a free key (§10, 2026-09-06). With billing it answers live
  questions with real cited sources; without it, it honestly declines and dates what it
  remembers. Nothing else changes either way. Free-tier generation is **20 requests per
  minute per model**, and one answer costs two, so roughly ten questions a minute — fine
  for a demo, tight if judges pass a laptop around.
- **New, still open (assistant, unverified):** two paths have never been run end to end
  because the per-minute quota ran out during testing: a **general-knowledge question**
  ("who was Alan Turing"), and the **ocean measurement path since search grounding was
  added**. The oil-price question did exercise the strip-and-retry fallback successfully,
  so the mechanism works; what is unconfirmed is that the ocean path still cites correctly
  through it. Run both first thing next session — they are two questions and one minute.
- **New, still open:** **nothing has been judged on a real GPU.** Every visual decision so
  far — water fog constants, the globe's shadow lift, the terminator softness — was tuned
  against a SwiftShader software renderer at 1-4 fps. The team chose fixed maximum quality
  with no fallback, so if it is slow on the demo machine the offer of a manual
  High/Reduced toggle still stands. This is the single most important unknown before the
  pitch.
- **New, still open (one-line change):** which Blue Marble month the demo ships. Phailin
  currently uses **October** 2004, which is seasonally honest for an October 2013 scenario.
  The team's own reference frames are the **December** texture — heavier Arctic and
  Scandinavian snow. Both are committed; `basemap` in `backend/app/config.py` selects.
- **New, still open (ask INCOIS):** `incois_valueadded_products_datasets` publishes **no
  units** for any of its variables. D26 (35–107), MLD (17–79) and HTCNT (3–251) are
  unambiguous from their physical ranges — metres, metres and kJ/cm². **Current speed is
  not.** `sqrt(GEO_U² + GEO_V²)` spans 1.77–508: as cm/s that is 5 m/s, impossible for
  geostrophic flow; as mm/s it is ~0.5 m/s, entirely plausible for the Bay of Bengal. The
  UI currently labels it cm/s and marks it "units inferred", but this must be confirmed
  with INCOIS before the pitch. (Note also that geostrophy diverges as 1/f toward the
  equator, so the low-latitude edge of the box carries genuine artifacts — this is why
  colour scales are percentile-clipped.)

---

## 12. Working agreement for Claude Code sessions

- Always check Section 10 (Decision log) before re-deciding something already settled.
- New ingestion sources (ADCP, moorings, HF-radar, ML products) must implement the
  `DataSource` interface in `backend/app/ingestion/base.py` — don't special-case them
  elsewhere.
- Normalize all data to the two schemas in Section 6 before it reaches the frontend.
- Follow the design tokens and principles in Section 5 for any new UI — don't introduce a
  new color, radius, or shadow style without adding it there first.
- When a visual question or a data gap comes up, consult the two standing references in
  Section 5.5 before improvising — Copernicus Marine (<https://data.marine.copernicus.eu/>)
  for data and unit/metadata conventions, NASA SVS (<https://svs.gsfc.nasa.gov/>) for
  scientific-visualization visual language. Record anything adopted in Section 10.
- Keep frontend format-agnostic: it should never need to know if a point came from an
  Argo float or a Glider — only `platform_type` for icon/label purposes.
- **Do not add Zarr or a tiling layer.** An earlier draft of this file recommended it; §10
  superseded that on 2026-08-31 after measuring. Serve binary `Float32Array` volumes
  directly. Revisit only if the grid resolution changes.
- Read `next_session.md` §6 before touching `frontend/src/viz/`. Those ten items are bugs
  that already shipped once and looked plausible while doing so.
- Commits carry the human author's name only — no AI co-author trailers. Team instruction,
  and it overrides any default attribution guidance.

---

## 13. Repository and collaboration

**<https://github.com/yuvrajshr/Ocean3D>** — private. Default branch `main`.

Several people work on this in parallel. `CONTRIBUTING.md` is the operational guide; this
section is only the part that belongs in canon.

- **Never commit directly to `main`.** Branch, PR, one review. Branch names are
  `area/short-description`.
- **Rebase daily** (`git pull --rebase origin main`). This is the highest-leverage habit
  in the repo. It does not prevent conflicts — it makes each one surface at the single
  commit that caused it, in your own branch, instead of all at once at PR time.
- **Never rebase a branch someone else has pulled.** Rebase rewrites commits with new
  hashes; their copy still points at the old ones. Rebase feature branches, never `main`.
- **One person in `frontend/src/viz/scene.ts` at a time.** At ~920 lines it is the
  composition hub, and nearly every 3D change lands in it. It is the reliable way to create
  a painful merge. `app.css`, `App.tsx`, this file's §10, and the two lockfiles are the
  other collision points.
- **Appending to §10:** add your entry at the *end* of the list and do not reflow the
  entries around it. Two branches both appending produces a small conflict whose resolution
  is obvious (keep both). Reflowing a neighbour makes it large and genuinely ambiguous.
  There is deliberately no `merge=union` driver on this file — the reasoning is in
  `.gitattributes`.
- **Commits carry the human author's name only.** No AI co-author trailers, no "Generated
  with…" in PR descriptions.
- Before opening a PR, run the full suite in `next_session.md` §7: backend tests, typecheck,
  build, and a screenshot pass with zero console errors.
