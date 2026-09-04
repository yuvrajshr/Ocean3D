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
| 3D rendering | **Three.js** (primary) | Full control over volumetric rendering, isosurfaces, custom shaders for depth slices. CesiumJS is a fallback/alternative if geospatial globe context (vs. regional ocean box) becomes a priority — don't build both, pick one early. |
| Frontend framework | React + TypeScript | Component-driven UI for control panels; TS catches data-shape bugs when wiring NetCDF-derived arrays into WebGL buffers. |
| Charting (profile view) | Recharts or D3 | Depth-vs-variable profile charts on marker click. |
| Backend framework | FastAPI (Python) | Native async, auto OpenAPI docs, pairs naturally with xarray/netCDF4/pandas ecosystem already implied by the problem statement (PyNIO/xarray mentioned explicitly). |
| NetCDF handling | `xarray` + `netCDF4` + `cftime` | Standard scientific-Python stack for CF-convention NetCDF; xarray gives label-based slicing (depth, time, lat/lon) almost for free. |
| Instrument data parsing | `pandas` + custom parsers | Argo/Glider/CTD/BGC delimited text → normalized schema (lat, lon, depth, time, variable, value). |
| Tiling / performance | Pre-chunk large NetCDF into **Zarr** or precomputed PNG/data tiles per depth-slice/time-step | Avoids sending full 3D arrays to the browser on every request; critical for interactivity. |
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

**Principles**
1. **Depth is the organizing metaphor.** The same color ramp used to encode ocean depth in
   the render also darkens the surrounding chrome — the interface itself gets "deeper"
   toward the edges.
2. **Instrument, not dashboard.** Controls look like they belong on a research vessel's
   console: rulers, tick marks, real units — never a SaaS widget kit.
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
7. **The basemap is imagery; everything drawn on it is data.** The globe is a photograph of
   the Earth — NASA Blue Marble, shaded relief and bathymetry baked in — and it is allowed
   to be beautiful because it is a *basemap*, the one thing in the product that encodes
   nothing. The only marks added to the sphere are things we actually measured: the
   analysis extent, and the floats reporting inside it. Nothing decorative is drawn on the
   Earth, and no field is ever painted onto it at global extent, because our coverage is a
   regional box and a global-looking data layer would claim otherwise. The same split that
   governs the viewport (Principle 6) governs the globe: the *place* may be photographic,
   the *data* stays measured.
8. **Layer stack hierarchy: Uppermost active layer rules the water column.** The layers panel
   manages an ordered oceanographic stack (surface to subsurface). The 3D water column
   renders the single uppermost active (visible/eye-on) layer in the stack. Toggling an upper
   layer's eye off immediately reveals the next active layer below it. If all layers are
   hidden or deleted, the 3D volume and timeline scrubber gracefully step down to avoid
   displaying phantom data or desynchronized dates.
9. **Side-by-side right HUD architecture.** Right-hand floating tools are arranged in non-colliding
   lateral coordinate lanes: `ToolDock` at `right: 16px` (Points inspector & 3D projection
   toggle), `DepthSlider` at `right: 84px` (vertical water column ruler), and floating flyout
   drawers (e.g. Points profiling list) offset at `right: calc(100% + 78px)` (~150px from edge).
   Instruments never overlap, collide, or obscure each other.
10. **Vertical depth discretization matches physical sampling.** The vertical depth slider is
    an instrument reflecting the true 24-level vertical grid of the INCOIS ERDDAP analysis
    (0.5 m surface down to 2000 m floor). Real-time hover callouts display oceanographic
    physical zones (Mixed Layer, Thermocline Core, D26 Isotherm, Argo Parking Depth) so depth
    selection is grounded in ocean physics.

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

Sky and water colours are derived from the six existing tokens (`thermocline` at the horizon
to `abyss` at the zenith, `current` for sub-surface scatter) — this principle adds no new
colour to the system.

### 5.2 Self-critique against generic defaults

Checked against common AI-generated tells before locking this in:
- Not a warm-cream-and-terracotta or near-black-with-single-neon-accent palette picked by
  default — the near-black base and two accents here are each tied to something real
  (depth, bioluminescence, hazard-advisory convention) and used for exactly one job each.
- No rounded SaaS card grid, no matching soft shadow under every panel, no gradient-wash
  decoration — panels are flat, hairline-divided instrument housings.
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

## 8. Suggested repo structure

```
ocean-viz/
├── context.md                  ← this file
├── frontend/
│   ├── src/
│   │   ├── components/         (ControlPanel, ProfileChart, ColorbarEditor, DepthSlider)
│   │   ├── viz/                (Three.js scene, volumetric renderer, marker layer)
│   │   ├── styles/
│   │   │   └── tokens.css      (Section 5 color/type tokens — abyss, current, etc.)
│   │   ├── api/                (typed API client)
│   │   └── App.tsx
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py             (FastAPI app)
│   │   ├── routers/            (variables, model_field, instruments, wms_wcs)
│   │   ├── ingestion/
│   │   │   ├── base.py         (DataSource plugin interface)
│   │   │   ├── netcdf_source.py
│   │   │   ├── argo_source.py
│   │   │   ├── glider_source.py
│   │   │   └── ctd_bgc_source.py
│   │   ├── models/             (Pydantic schemas matching Section 6)
│   │   └── tiling/             (precompute depth/time tiles from NetCDF)
│   └── requirements.txt
├── data/
│   ├── sample_netcdf/
│   └── sample_instruments/
├── docker-compose.yml
└── docs/
    └── acronyms.md
```

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
- _2026-09-04 — **Interactive Layer Stack Hierarchy & Uppermost Active Layer Rendering (§5.1, Principle 8).**
  The layers panel was modernized into an extensible ocean GIS manager supporting multi-layer stacks.
  Decision: The 3D water column physically renders the single uppermost layer whose visibility (eye toggle)
  is active. Toggling an upper layer's eye off automatically reveals the next active layer underneath.
  If all active layers are toggled off or deleted, the volume is cleared and the timeline scrubber hides,
  preventing visual desynchronization and phantom datasets._
- _2026-09-04 — **Data Catalogue Modal Streamlining.**
  The catalogue modal was restructured around two primary operational categories: Physical Ocean Variables
  (Temperature, Salinity, Currents) and Hazard / Cyclone tracks (Cyclone Phailin). Extraneous filters
  (time ranges, personal bookmarks) were removed to keep the interface focused. Added 1-click "Add to map"
  which prepends the layer to the top of the stack and automatically dismisses the modal._
- _2026-09-04 — **ToolDock & Development Testing Badges.**
  A floating right-hand dock was introduced for GIS analytical tools. Points inspector stays active and
  functional, connecting directly to real in-situ Argo float profiles with 1-click graph overlays.
  Representational tools (`lines`, `areas`, `import`, `settings`) were equipped with professional amber
  `<FlaskConical /> Under Testing` badges and 2s auto-close timeouts, and then cleanly commented out in
  the primary dock bar to keep the UI focused on functional features._
- _2026-09-05 — **Side-by-Side Right HUD Architecture & Non-Conflicting Layout (§5.1, Principle 9).**
  The right-hand interface was unified into lateral non-conflicting zones: `ToolDock` at `right: 16px`
  (48px width), `DepthSlider` at `right: 84px` (48px width), and floating flyout drawers (e.g. Points
  profiling drawer) offset at `right: calc(100% + 78px)` (~150px from edge). This guarantees that
  the Points drawer, DepthSlider, and ToolDock remain mutually visible with zero overlap or layout jumping._
- _2026-09-05 — **Vertical Depth Slider with 24-Level Physical Discretization (§5.1, Principle 10).**
  The depth ruler was redesigned as an upright glassmorphic pill slider at `right: 84px` with a vertical
  `D E P T H` header, smooth gradient fill, and interactive left-anchored tooltip. The track is calibrated
  directly to INCOIS ERDDAP's 24 physical vertical levels (0.5 m to 2000 m), displaying real oceanographic
  zone callouts (Mixed Layer, Thermocline Core, D26 Isotherm, Argo Parking Depth) and dynamically windowing
  the Three.js raymarched volume via `scene.setDepthWindow(0, targetDepth)`._

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
- Prefer precomputed tiles/Zarr chunks over sending raw NetCDF slices to the browser.