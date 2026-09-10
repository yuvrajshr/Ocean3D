# Project Bible — INCOIS 3D Ocean Data Visualization Platform

**Smart India Hackathon 2026 · Problem Statement 26067**
**Ministry of Earth Sciences (MoES) · Indian National Centre for Ocean Information Services (INCOIS), Ocean Valley, Hyderabad**
**Category: Software · Theme: Disaster Management**

> **What this document is.** The single reference for building the submission deck, the report,
> and the demo script. Everything here is drawn from the working repository, not from
> aspiration — where something is planned rather than built, it says so in the same sentence.
>
> **Status of the numbers in this file.** Test counts, line counts and suite results were run
> and verified on **2026-09-09**, not quoted from older docs. Where a claim has *not* been
> verified (real-GPU performance, current-speed units), it is flagged explicitly in
> §14 and §16.
>
> **Source documents this consolidates:** `context.md` (canon: scope, data model, design system,
> ~75-entry decision log), `next_session.md` (status and the trap list), `CLAUDE.md` (frontend
> working rules), `CONTRIBUTING.md` (team workflow), `README.md` (run instructions).

---

## Table of contents

1. [The 60-second version](#1-the-60-second-version)
2. [The problem](#2-the-problem)
3. [What we built — product tour](#3-what-we-built--product-tour)
4. [The signature feature](#4-the-signature-feature--modelvsobservation-comparison)
5. [The demo narrative — Cyclone Phailin](#5-the-demo-narrative--cyclone-phailin-october-2013)
6. [Data — every upstream, verified live](#6-data--every-upstream-verified-live)
7. [Architecture](#7-architecture)
8. [Tech stack, with rationale](#8-tech-stack-with-rationale)
9. [Backend, module by module](#9-backend-module-by-module)
10. [Frontend, module by module](#10-frontend-module-by-module)
11. [The ocean assistant](#11-the-ocean-assistant-ai)
12. [The design system](#12-the-design-system)
13. [Scientific correctness — the things that make it trustworthy](#13-scientific-correctness--the-things-that-make-it-trustworthy)
14. [Engineering rigour and verification](#14-engineering-rigour-and-verification)
15. [Problem-statement compliance matrix](#15-problem-statement-compliance-matrix)
16. [What is *not* built — the honest roadmap](#16-what-is-not-built--the-honest-roadmap)
17. [Impact and benefits](#17-impact-and-benefits)
18. [Feasibility, viability and risk](#18-feasibility-viability-and-risk)
19. [Deployment](#19-deployment)
20. [Project statistics](#20-project-statistics)
21. [Team and working method](#21-team-and-working-method)
22. [Deck outline — slide by slide](#22-deck-outline--slide-by-slide)
23. [Demo script](#23-demo-script-8-minutes)
24. [Judge Q&A preparation](#24-judge-qa-preparation)
25. [Pre-pitch checklist](#25-pre-pitch-checklist)
26. [Glossary](#26-glossary)
27. [References](#27-references)

---

## 1. The 60-second version

INCOIS produces depth-resolved 3D ocean model output (temperature, salinity, currents,
chlorophyll) as NetCDF, and receives in-situ observations from Argo floats, gliders, CTDs and
BGC sensors as delimited text. **No existing tool lets a forecaster look at both, in 3D, in a
browser, at the same time.** Desktop GIS tools are 2D, or single-format, or need installation
and training.

We built one. It is a browser-native WebGL2 application that renders the INCOIS gridded
analysis as a **raymarched 3D water column** — 24 depth levels from 5 m to 2000 m — with the
real Argo floats that reported in the same window drawn into the same scene at their true
positions and profiling depths. Clicking a float opens its measured cast, the model's
prediction at the same place and time, and **the difference between them on its own scale**.

It runs on INCOIS's own public ERDDAP server. **No data is synthesized.** Five independent
upstream organisations feed it through one pluggable `DataSource` interface, on three
different protocols, which is what makes the problem statement's "extensible to new sensors"
requirement demonstrable rather than asserted.

It also carries a **grounded AI assistant** that answers questions about the water from real
fetched data and drives the interface in plain language — with a citation line built from the
tool calls that actually executed, so an answer that fetched nothing is visibly marked as
unsourced.

**Verified on 2026-09-09:** 52/52 backend tests pass against live data in 38 s; 31/31 frontend
tests pass; TypeScript typecheck clean. ~24,900 lines of code.

---

## 2. The problem

### 2.1 The official problem statement

| Field | Value |
|---|---|
| **PS ID** | 26067 |
| **Organisation** | Ministry of Earth Sciences (MoES) |
| **Department** | Indian National Centre for Ocean Information Services (INCOIS), Ocean Valley |
| **Category** | Software |
| **Theme** | Disaster Management |
| **Title** | Develop a web-based interactive 3D visualization platform that integrates numerical ocean model outputs and in-situ observations. |

### 2.2 The problem in the field

INCOIS runs operational ocean models and simultaneously ingests observations from a global
instrument array. These two streams answer different halves of the same question:

- **The model** gives you *everywhere* — a full 3D field over the basin, continuous in space,
  available for any depth and any timestep. But it is a prediction. At 1° resolution it
  smooths physical structure that genuinely exists.
- **The observations** give you *the truth at a point* — an Argo float's cast is a real
  measurement of real water. But there are only a few dozen of them in a basin, and each one
  is a single vertical line.

**A forecaster needs both at once.** Deciding whether a cyclone will intensify means knowing
the depth of the 26 °C isotherm across the whole track *and* trusting that number, which means
checking it against whatever instrument was actually in the water.

### 2.3 Why current tools fail

| Barrier | Consequence |
|---|---|
| **Desktop-bound** (ArcGIS, Panoply, Ferret, ODV) | Needs installation, licences and training. A district officer during a cyclone watch cannot use them. |
| **2D-only** | Depth is the axis that matters in oceanography, and it is the one flattened away. A depth slice is not a water column. |
| **Format-siloed** | NetCDF tooling does not read Argo ASCII; Argo tooling does not read gridded NetCDF. Comparison means exporting from one and importing into another. |
| **No co-visualization** | Nothing puts a model field and an instrument reading on the *same* depth axis in the *same* frame. |
| **Analyst-only** | Nothing in this class doubles as an outreach tool. INCOIS's public mandate goes unserved by its own analysis stack. |

**The cost of that friction:** slower hazard assessment during cyclone watches, slower
search-and-rescue drift estimation, slower fishery advisories, and a model-validation loop that
runs offline in scripts instead of live on a screen.

### 2.4 Scope boundaries we set deliberately

Stated up front so the deliverable is judged against what it claims:

- Not a production ingestion pipeline for INCOIS's internal live systems — a working prototype
  against real public INCOIS data.
- Not every sensor type. Argo works end to end; ADCP, HF-radar and moorings are *architecturally*
  supported through the `DataSource` interface but not implemented.
- No auth or multi-tenancy — the visualization core is the deliverable.
- Not desktop-GIS parity. The bar is "co-visualization in one browser session that a forecaster
  could not do before."

---

## 3. What we built — product tour

The application is **one console with three views of the same clock, the same layer stack and
the same data**. Switching views never changes what is selected, only how it is drawn.

### 3.1 View 1 — The 2D map (the landing view)

A full-bleed global equirectangular ocean map, modelled on the interaction pattern of
Copernicus MyOcean Pro and NASA Worldview.

- **Up to three stacked layers**, each with independent visibility, opacity, log/linear scale
  and its own inline colorbar with its real value range.
- **Every layer states its own provenance in the housing** — dataset, grid spacing, cadence,
  and the upstream that actually drew it — always visible, never in a tooltip. A HYCOM layer
  is never credited to INCOIS.
- **Animated current streamlines** that advect through the real u/v field. What moves on screen
  is what the water does. Under `prefers-reduced-motion` they *freeze* rather than vanish,
  because the paths themselves carry direction.
- **A point tool** — drop a pin, get four readouts from **one** request: the value at that cell,
  the full depth profile, the time series, and the depth–time section.
- **An area tool** — drag a box and the 3D water column rebuilds around it.
- **A free timeline** over the union of all layer coverage, with **one tick row per layer**, so
  a daily product and a 10-daily product visibly differ instead of being silently smoothed
  together.
- **Reference geography** — Natural Earth coastlines and national borders, bundled locally
  (110m at world zoom, 50m past 2.5× world-fit). Strokes only: the filled land is always the
  data's own no-data mask, so a coastline can never hide an ocean cell or invent one.
- **Nearest-neighbour sampling** with `imageSmoothingEnabled = false`. Past a zoom threshold you
  see true grid cells. Blocky is the honest result; bilinear scaling would interpolate *between*
  colormap entries and invent colours that are not in the ramp.

### 3.2 View 2 — The 3D water column (the hero)

A raymarched volume of the INCOIS gridded analysis sitting in an actual ocean, not a void.

- **Raymarched 3D texture** — 24 depth levels, 5–2000 m, ~160 steps per ray.
- **A gradient-driven transfer function.** Opacity is driven by local gradient magnitude, so a
  thermocline, a front or the edge of a cold wake reads as *form* while still water recedes.
  Colour is untouched by this — the colorbar stays exactly true.
- **Argo float markers** at true lat/lon, each with a stem showing how deep it actually profiled,
  and a colour-coded ribbon carrying its measured values.
- **A continuous ETOPO relief surface** — the Eastern Ghats, the Indian and Myanmar coasts,
  Sri Lanka and the Bay of Bengal seafloor as one mesh, because in reality they are one surface.
- **Real water optics.** Light attenuates the way seawater actually absorbs it: red first, then
  green, leaving blue before black. Caustics only in shallow water, faded out by ~200 m, because
  that is where sunlight actually reaches. Marine snow drifting downward, denser near the surface.
  Crepuscular light shafts from the surface.
- **A depth lattice** — hairline gridlines on the *far* faces of the analysis box at exactly the
  depths the DOM depth ruler uses, with labels in IBM Plex Mono. Never between the reader and
  the data, and it **vanishes entirely** for variables with no depth dimension, because writing
  "500 m" on a surface field asserts a measurement that does not exist.
- **A depth ruler** calibrated to the real 24-level vertical grid, with hover callouts naming
  the physical zone (Mixed Layer, Thermocline Core, D26 Isotherm, Argo Parking Depth).
- **The camera opens submerged**, ~86 m down, looking slightly down onto the analysis so the
  thermocline is seen side-on. Dragging up returns to the whole-basin overview.

### 3.3 View 3 — The globe

- **NASA Blue Marble Next Generation** with topography and bathymetry baked into the pixels,
  resampled to 4096×2048, bundled locally.
- The **only** marks on the sphere are things we actually measured: the analysis extent outline,
  and the floats reporting inside it. **No field is ever painted on the globe at global extent** —
  our 3D coverage is a regional box, and a global-looking data layer would claim otherwise.
- **The globe never rotates on its own.** In globe mode the *camera* orbits and the Earth stays
  put — which also keeps the day/night terminator anchored to real geography.
- Clicking inside the analysis extent dives back down through the water column.

### 3.4 Cross-cutting

- **The load-in descent** — the product's single orchestrated motion moment. Entering the water
  column from the map or the globe plays one continuous camera move down through the surface to
  the default depth as the data streams in. Motivated, not decorative: it is literally what the
  tool does. Everything else responds instantly. `prefers-reduced-motion` cuts it in both
  directions.
- **The provenance chip** in the header always says whether you are seeing `Live · <upstream>`
  or `Cached · <date>`, naming the upstream actually in use.
- **The ocean assistant** — §11.
- **WebGL2 feature detection** on load, with a plain-language fallback message rather than a
  blank canvas.

---

## 4. The signature feature — model-vs-observation comparison

**This is the point of the project.** Everything else is the apparatus that makes it possible.

Click any Argo float marker (or select it from the keyboard-reachable float list) and the
profile panel opens with three things on one shared depth axis:

1. **The float's measured cast** — real water, real instrument, QC-filtered.
2. **The INCOIS analysis** interpolated to the same place and the same time.
3. **The residual** (model − observation) on its own scale, so a small but structurally
   important disagreement is not squashed by the range of the absolute values.

Served by `GET /api/compare`, implemented in `backend/app/routers/instruments.py`.

### Why it matters, concretely

For float **`2901327`** during Cyclone Phailin, the comparison reports a mean residual of
**−0.10 °C** across the profile — which on its own would read as "the model is fine."

At **76 m** the residual is **−1.21 °C**.

The 1° analysis smoothed out a thermocline the float actually measured. That single number is
the argument for the whole platform: *the average hides it, the depth axis reveals it, and no
2D tool would have shown you either.* It is a live, visual model-validation loop, and it points
directly at where the model needs work.

---

## 5. The demo narrative — Cyclone Phailin, October 2013

**Why this scenario, and not a recent one:** it is the *only* window where all three data
families overlap. The 3D grid runs 2004 → Jul 2026, the Argo floats 2002 → Apr 2025, but the
**value-added hazard fields (D26, heat content, MLD, geostrophic currents) stop on
2019-03-30**. Phailin sits inside all three.

It is also the right story. Phailin made landfall near Gopalpur, Odisha on 12 October 2013.
INCOIS and IMD's forecast prompted **the evacuation of over a million people** — one of the most
successful cyclone evacuations in Indian history, and a landmark for the exact organisation
whose problem statement this is.

**Scenario box:** 5–23°N, 78–95°E, 1–25 October 2013. Defined as `PHAILIN` in
`backend/app/config.py`.

### The featured floats

| Float | What it shows |
|---|---|
| **`2901335`** | Near-hourly profiling at ~15.9°N, 88.8°E — directly under the storm track. SST falls **28.96 °C (10 Oct) → 26.38 °C (11 Oct)**: a **−2.6 °C cold wake**, recovering to 29.14 °C by 20 Oct. |
| **`2901327`** | Corroborates it in the subsurface: 100 m cooled **23.72 → 20.27 °C**. This is the float that produces the −1.21 °C residual at 76 m. |

### ⚠️ The trap in the narrative — float `2900757`

It looks like a **−4.03 °C** cold wake. It is more dramatic than either real float and it is
**completely unusable**: 2 rows per cycle, every level at 0 dbar, every `TEMP_QC = 4`, salinity
0.014 PSU. It is a broken instrument, not an ocean signal.

**Do not put it in the pitch.** The regression test
`tests/test_ingestion.py::test_bad_qc_float_is_rejected_entirely` fails if it ever produces a
profile again.

This is not a footnote — **it is one of the strongest slides in the deck.** It is the concrete
proof that the platform's quality control is a correctness requirement rather than a checkbox,
and that a prettier number was rejected because it was wrong.

---

## 6. Data — every upstream, verified live

**Nothing is synthesized.** Every dataset below was verified against the live server —
dimensions read from the server's own `/info/` endpoint, payload sizes and latency measured by
actually fetching them.

### 6.1 INCOIS — the primary upstream

`https://erddap.incois.gov.in/erddap`

| Dataset | Shape / coverage | Used for |
|---|---|---|
| `incois_argo_10d_VAM` | time(813) × ZAX(24: 5–2000 m) × lat(60) × lon(90); TEMP, SAL, TERR, SERR; CF-1.6; 2004 → Jul 2026 | **The 3D volume** |
| `Indian_ARGO_Floats` | tabledap; PRES/TEMP/PSAL + `_ADJUSTED` + QC flags; 2002 → Apr 2025 | **In-situ profiles** |
| `incois_valueadded_products_datasets` | GEO_U, GEO_V, MLD, ILD, D26, D20, HTCNT, DYN_HT; 1°; 10-daily; **2004 → Mar 2019 only** | **Currents + cyclone hazard fields** |
| `incois_oceansat2_datasets` | CHL mg/m³; 2011 → 2020 | **Chlorophyll** (cloud-gapped) |

**The pivotal discovery of the project:** INCOIS runs a public, standards-compliant ERDDAP
server. The demo runs on the problem-statement organisation's own data. That resolved four of
the five original open questions in one afternoon and removed any need to synthesize test data.

### 6.2 The other four upstreams

| Upstream | Product | Coverage | Protocol | Why |
|---|---|---|---|---|
| **NOAA NCEI** | `ETOPO1_bedrock` | 1 arc-min global relief, metres | **ArcGIS ImageServer → tiled Float32 GeoTIFF** | Seafloor + land as one continuous surface |
| **APDRC, Univ. of Hawaii** | HYCOM GLBv0.08 (`hawaii_soest_6a0a_5127_d118`) | Global 0.08°, **40 levels to 5000 m**, daily 1994–2015 | ERDDAP griddap | Global map fallback: field, depth slider, profile, section and streamlines from one dataset |
| **NOAA CoastWatch** | `noaacwNPPVIIRSSQchlaDaily` | Global 4 km chlorophyll, 2012 → present | ERDDAP griddap | Global chlorophyll |
| **Copernicus Marine (Mercator Ocean)** | GLORYS12V1 `cmems_mod_glo_phy_my_0.083deg_P1D-m` + analysis/forecast `cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m` | Global **0.083°, 50 levels to 5728 m**, daily 1993 → 2026-06; forecast reaches **10 days past today** | **`copernicusmarine` toolbox → ARCO Zarr** | The map's default layer — better than HYCOM on resolution, depth and recency |

**Five organisations. Three protocols. One interface.** ERDDAP griddap/tabledap, an ArcGIS
ImageServer returning binary GeoTIFF, and the Copernicus Marine Zarr toolbox all implement the
same `DataSource` protocol in `backend/app/ingestion/base.py`. **This is the evidence for the
extensibility requirement** — it is demonstrated by a heterogeneous fleet of real upstreams, not
asserted by a diagram.

### 6.3 The basemap is deliberately *not* in that table

NASA Blue Marble Next Generation (`frontend/public/*.jpg`, ~3.2 MB across two months) is a
**basemap asset**, not a data source: a static 2004 photograph that encodes nothing, credited in
the UI, and the globe-mode caption states so to the reader. Everything in the tables above is
measurement; the sphere is scenery.

### 6.4 Resilience — the demo never depends on venue wifi

Every upstream response is cached to disk with its provenance. The cache resolves
**fresh → network → stale**: if INCOIS is unreachable, the last good response is served and the
header switches from `Live · INCOIS ERDDAP` to `Cached · <date>`. The user is always told which.

Committed fixtures (~3 MB) live in `data/`, regenerable with `backend/snapshot_fixtures.py`.

**Measured performance:** a full 3D volume for one timestep is **1.0 MB as NetCDF in ~570 ms**,
~259 KB per variable as `Float32Array`. Copernicus is **11.6 s cold, 0.03 s cached** — CMEMS
carries ~11 s of fixed per-request overhead and has no server-side striding, so the backend
downsamples after fetching and caches the *downsampled* array.

### 6.5 Licence obligations, honoured in the UI

Using Copernicus Marine data is conditional on displaying **"Generated using E.U. Copernicus
Marine Service Information"** plus each product's DOI. We render that credit line **inside the
layer housing**, attached to the layer it describes, not in a footer a reader can scroll past.
It ships with the data or the data does not ship.

---

## 7. Architecture

### 7.1 System diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          BROWSER  (no plugins, WebGL2)                      │
│                                                                             │
│   React 19 + TypeScript                                                     │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│   │  2D Map      │  │  3D Water    │  │  Globe       │  │  Assistant    │  │
│   │  (Canvas 2D, │  │  Column      │  │  (Three.js)  │  │  panel        │  │
│   │   CPU raster)│  │  (Three.js   │  │              │  │  (SSE stream) │  │
│   │              │  │   raymarch)  │  │              │  │               │  │
│   └──────────────┘  └──────────────┘  └──────────────┘  └───────────────┘  │
│          └────────────────┴─────────┬────────┴──────────────────┘           │
│                     one clock · one layer stack · one selection             │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │  REST — JSON metadata
                                     │       + raw Float32Array binary volumes
                                     │       + SSE for the assistant
┌────────────────────────────────────▼───────────────────────────────────────┐
│                      BACKEND — FastAPI (Python 3.14)                        │
│                                                                             │
│  routers/   catalog · field · instruments (+/compare) · terrain · map ·     │
│             assistant                          → 20 endpoints, OpenAPI docs │
│  ──────────────────────────────────────────────────────────────────────────│
│  assistant/ gemini_client · tools · reads · prompt · store (SQLite)         │
│  ──────────────────────────────────────────────────────────────────────────│
│  models/schemas.py — Pydantic. THE normalization boundary.                  │
│             Everything upstream becomes one of two shapes here.             │
│  ──────────────────────────────────────────────────────────────────────────│
│  ingestion/ base.py  ← the DataSource protocol (the extensibility claim)    │
│             erddap_grid · erddap_argo · erddap_map · etopo_terrain · cmems  │
│  ──────────────────────────────────────────────────────────────────────────│
│  erddap_client.py — the ONLY place that talks upstream                      │
│                     (TLS workaround + RFC 3986 percent-encoding)            │
│  cache.py         — disk cache: fresh → network → stale, with provenance    │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │
      ┌───────────┬──────────────┬───┴─────────┬────────────────┐
      ▼           ▼              ▼             ▼                ▼
  INCOIS      NOAA NCEI      APDRC        NOAA CoastWatch   Copernicus
  ERDDAP      ArcGIS         ERDDAP       ERDDAP            Marine
  (4 sets)    (ETOPO1)       (HYCOM)      (VIIRS chl)       (GLORYS + fcst)
   griddap/    GeoTIFF        griddap      griddap           Zarr toolbox
   tabledap
```

### 7.2 Why the backend is mandatory, not architectural decoration

Two hard reasons, both measured:

1. **ERDDAP returns no `Access-Control-Allow-Origin` header.** The browser physically cannot
   call it. This is not a design preference — without FastAPI nothing renders.
2. **INCOIS's TLS chain is served without its intermediate certificate**
   (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Browsers usually recover via AIA fetching; `httpx` does
   not. That workaround is isolated to exactly one file, `erddap_client.py`.

The backend also holds the Copernicus and Gemini credentials **server-side only** — neither ever
reaches the browser.

### 7.3 The normalization boundary — the extensibility claim, made real

Every upstream, whatever its format or protocol, is normalized into **one of two shapes** before
it reaches a router. The frontend therefore never learns what format a point came from.

**Gridded field:**
```json
{
  "variable": "temperature",
  "time": "2013-10-10T00:00:00Z",
  "depth_levels": [5, 10, 20, ...],
  "grid": { "lat": [...], "lon": [...] },
  "units": "°C",
  "value_range": [min, max]
}
```

**Point profile (Argo / Glider / CTD / BGC):**
```json
{
  "platform_id": "2901335",
  "platform_type": "argo_float",
  "lat": 15.9, "lon": 88.8,
  "time": "2013-10-11T06:00:00Z",
  "profile": [
    { "depth": 0,  "temperature": 26.38, "salinity": 33.1 },
    { "depth": 10, "temperature": 26.31, "salinity": 33.2 }
  ]
}
```

**Adding ADCP, HF-radar, moorings or an ML product means implementing `DataSource` and
registering it — and touching nothing else in the application.** The two `Protocol` classes are
`GriddedSource` (`available_times`, `fetch_volume`) and `InSituSource` (`list_platforms`,
`fetch_profile`). ETOPO and Copernicus already prove the pattern: they are a completely
different organisation on a completely different protocol, and they cost a file each.

### 7.4 Transport decision — binary, not JSON

Volumes are served as **raw little-endian `Float32Array`** with metadata in a separate JSON call,
not as JSON numbers. A 24 × 60 × 90 volume is ~259 KB binary; the same array as JSON text would
be several megabytes and would need parsing before it could reach a WebGL buffer.

**Explicitly rejected: Zarr and a precomputed tiling layer.** Measured before deciding — one
full 3D volume is 1.0 MB in 569 ms. Tiling at this grid resolution would be premature
optimisation, an entire subsystem to maintain, and a source of cache-invalidation bugs. Revisit
only if the grid gets finer.

---

## 8. Tech stack, with rationale

Every choice below is recorded in the decision log with a one-line reason and a date. None was
picked by default.

### Frontend

| Layer | Choice | Why this one |
|---|---|---|
| Framework | **React 19.2 + TypeScript 7.0** | Real application state (variable, depth, timestamp, layer stack, view, selection). TS catches data-shape bugs when wiring NetCDF-derived arrays into WebGL buffers — a wrong axis order is a silently plausible ocean, not a crash. |
| Build | **Vite 8.2** | Fast HMR, native ESM, proxies `/api` to :8000 so dev and production both use same-origin paths. |
| 3D | **Three.js 0.185** | *Not* CesiumJS. The 3D data is a regional 1° box (30.5–119.5°E, 29.5°S–29.5°N); a globe-primary product would render a small patch on a mostly empty sphere. Three.js gives full control over the raymarch shader, the transfer function and the custom water optics. **Decision closed 2026-08-31.** |
| 2D map | **Canvas 2D, CPU rasterization** | Deliberately *not* a shader. Writing LUT bytes straight into `ImageData` eliminates a whole class of bug — no colour-space conversion, no premultiplied alpha, no filtering mode can shift a value away from its colorbar. It is also the only version that can be unit-tested byte-for-byte. Cost is not a constraint: colouring is keyed on the data, so pan and zoom blit a bitmap that already exists. |
| Styling | **Plain CSS against custom properties. No Tailwind.** | Decided 2026-09-01. The instrument-console language — hairline dividers, real rulers, exact tick spacing — is not what a utility framework is good at, and dropping it removed both a config surface and the gravitational pull toward a generic SaaS look. |
| Type | **IBM Plex Sans + IBM Plex Mono** (bundled via `@fontsource`) | A technical humanist grotesk actually used in scientific and government tooling. Mono is reserved for literal readouts — depths, coordinates, timestamps, values, platform IDs. |
| Icons | **lucide-react** | |
| Tests | **Vitest** | 31 tests over projection, rasterization, colour encoding and assistant action handling. |

### Backend

| Layer | Choice | Why this one |
|---|---|---|
| Framework | **FastAPI** | Native async, automatic OpenAPI docs at `/docs`, and it lives in the same ecosystem as xarray/netCDF4/pandas — which the problem statement itself implies. |
| NetCDF | **xarray + netCDF4 + numpy** | The standard scientific-Python stack for CF-convention NetCDF. xarray gives label-based slicing on depth/time/lat/lon almost for free. |
| Tabular | **pandas** | Argo/Glider/CTD/BGC delimited text → the normalized point-profile schema. |
| Copernicus | **`copernicusmarine` ≥ 2.4** | The only non-HTTP dependency in the project. Optional at runtime — without credentials the Copernicus layers simply do not appear and everything else still works. |
| AI | **`google-genai` ≥ 2.22, Gemini** | Optional at runtime, exactly like Copernicus. |
| Persistence | **SQLite, behind a `ConversationStore` protocol** | *Not* a hosted database. The PS requires deployability on INCOIS infrastructure, and a hosted DB is an outbound dependency a government network may refuse. Behind a protocol shaped like `DataSource`, so a later swap is a class, not a rewrite. |
| Tests | **pytest** | 52 tests, run against the **live** server and its cache. |

### Tooling

| Tool | Purpose |
|---|---|
| `dev.mjs` | One command from the repo root starts both processes, prefixed output, and **takes both down if either dies** — a half-running stack renders a blank page that reads as a 3D bug, which is the most expensive false trail this repo has recorded. |
| `screenshot.mjs` / `shot.mjs` / `shot-map.mjs` | Puppeteer verification harness — see §14. |
| `scripts/fetch-textures.mjs` | Downloads and resamples the Blue Marble basemaps to power-of-two 4096×2048. |
| `scripts/fetch-geography.mjs` | Bundles Natural Earth coastlines locally, because the deployment target cannot depend on outside hosts. |

**Environment as provisioned:** Python 3.14.0 (numpy 2.5.2, pandas 3.0.5, xarray 2026.7.0,
netCDF4 1.7.4, fastapi 0.141.1, pytest 9.1.1); Node 24.11.0 (React 19.2.8, three 0.185.1,
Vite 8.2.2, TypeScript 7.0.2, Puppeteer 25.9).

---

## 9. Backend, module by module

**Design intent: the backend is a translator, not a platform.** It crosses the CORS/TLS
boundary, normalizes every source into two schemas, and caches. It holds no business logic that
belongs in the client.

```
backend/app/
├── main.py                  FastAPI app; mounts six routers under /api
├── config.py         (633)  Every dataset fact, read off the live server. Scenarios. Credentials.
├── erddap_client.py  (122)  ← THE ONLY place that talks upstream. TLS + percent-encoding.
├── cache.py           (66)  Disk cache: fresh → network → stale, provenance recorded
├── scaling.py         (51)  Percentile clipping + stride derivation
├── snapshot_fixtures.py     Regenerates the committed fixtures in data/
│
├── ingestion/
│   ├── base.py        (84)  ← The DataSource protocol. The PS's extensibility claim.
│   ├── erddap_grid.py(213)  INCOIS griddap → xarray → volumes/surfaces; fetch_vector_magnitude
│   ├── erddap_argo.py(218)  tabledap → pandas; QC filter; decibar → metres (UNESCO)
│   ├── erddap_map.py (299)  Global griddap sources (HYCOM, VIIRS) for the 2D map
│   ├── etopo_terrain.py(163) NOAA NCEI ArcGIS → tiled Float32 GeoTIFF, decoded with struct+numpy
│   └── cmems.py      (320)  Copernicus Marine toolbox → downsample → cache
│
├── models/schemas.py (154)  Pydantic. The normalization boundary (context.md §6).
│
├── routers/
│   ├── catalog.py     (97)  /variables · /scenarios · /health (with a real upstream probe)
│   ├── field.py      (141)  /field/meta · /field/data (binary volumes)
│   ├── instruments.py(185)  /instruments · /{id}/profile · /compare  ← the signature endpoint
│   ├── terrain.py     (65)  /terrain/meta · /terrain/data
│   ├── map.py        (413)  /map/catalogue · /times · /slice/meta · /slice/data
│   │                        · /vector/data · /point
│   └── assistant.py  (210)  SSE: status → answer → done
│
└── assistant/               see §11
    ├── gemini_client.py(362)  ← the only place that talks to Gemini
    ├── tools.py      (368)  Declarations + server-side action validation
    ├── reads.py      (186)  Read tools, each returning provenance
    ├── prompt.py     (149)  System prompt; screen state + catalogue inlined
    └── store.py      (251)  SQLite behind a protocol
```

### The complete API surface — 20 endpoints

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/variables` | Available variables with units, kind, colormap, valid range |
| GET | `/api/scenarios` | Preset scenarios (currently Phailin) |
| GET | `/api/health` | Liveness **plus a real upstream probe**, so the UI can show true provenance |
| GET | `/api/field/meta` | Field metadata: depth levels, grid, units, value range, source status |
| GET | `/api/field/data` | **Raw little-endian Float32 volume**, C-order (depth, lat, lon) |
| GET | `/api/instruments` | Platforms in a bbox + time window, with QC rejection count |
| GET | `/api/instruments/{platform_id}/profile` | One platform's full depth profile |
| GET | `/api/compare` | **The signature endpoint** — float cast vs. model, plus residual |
| GET | `/api/terrain/meta` | ETOPO grid descriptor |
| GET | `/api/terrain/data` | Raw Float32 elevation in metres |
| GET | `/api/map/catalogue` | Map layers with provider, resolution, cadence, attribution, DOI |
| GET | `/api/map/times` | A layer's real time axis (truncated to a display sample when huge) |
| GET | `/api/map/slice/meta` | Slice metadata: bounds, stride used, clipped range |
| GET | `/api/map/slice/data` | Raw Float32 2D slice |
| GET | `/api/map/vector/data` | u/v components for streamlines |
| GET | `/api/map/point` | **One request → four readouts**: value, profile, series, depth-time section |
| GET | `/api/assistant/status` | Whether the assistant can run at all, and why not if it cannot |
| GET | `/api/assistant/conversations` | Conversation list |
| GET | `/api/assistant/conversations/{id}` | One conversation's messages |
| POST | `/api/assistant/message` | **SSE stream**: status → answer → done |

Interactive OpenAPI documentation is generated automatically at `http://127.0.0.1:8000/docs`.

---

## 10. Frontend, module by module

```
frontend/src/
├── App.tsx           (1008)  ALL application state: view, layer stack, clock, depth,
│                             selection, comparison, assistant. 30+ state hooks.
├── api/client.ts      (414)  Typed API client — 20 interfaces mirroring the Pydantic schemas
│
├── viz/                      ── the 3D water column ──
│   ├── geo.ts         (159)  ← THE shared coordinate frame. Read before touching the 3D.
│   ├── depth.ts       (121)  The depth axis (power 0.65) — shared by ruler, volume AND charts
│   ├── scene.ts      (1464)  Composition, camera, entry gesture, view switching, picking
│   ├── volume.ts      (503)  Raymarched 3D texture + gradient transfer function
│   ├── globe.ts       (668)  Blue Marble basemap, analysis outline, float markers
│   ├── terrain.ts     (259)  ETOPO relief mesh, photic-zone fade, superellipse dissolve
│   ├── ocean.ts       (434)  Sky, sea surface, marine snow, light shafts, skyUniforms()
│   ├── lattice.ts     (392)  ← RENDER_ORDER for the WHOLE column. Plus gridlines + labels.
│   ├── water.ts       (123)  Shared water-optics GLSL; SCATTER_COLOR
│   ├── effects.ts     (139)  Layer-selective bloom
│   └── colormaps.ts   (135)  cmocean LUTs + encodeRange / normaliseValue / lutIndex
│
├── map/                      ── the 2D map ──
│   ├── MapView.tsx    (641)  Stacked canvases: basemap, data, flow + SVG overlay
│   ├── state.ts       (392)  Map reducer
│   ├── projection.ts  (194)  Equirectangular transform (lonToX / latToY / MapTransform)
│   ├── raster.ts      (186)  CPU rasterizer — pure, asserted byte-for-byte
│   ├── streamlines.ts (154)  Particle advection through the real u/v field
│   ├── geography.ts   (172)  Natural Earth coastlines + borders, with antimeridian tear
│   ├── LayerStack.tsx (330)  Per-layer housing: provenance, colorbar, opacity, log scale
│   ├── MapTimeline.tsx(209)  One tick row per layer
│   ├── MapDepthRuler.tsx(114) Discrete-stop depth ruler
│   ├── PointReadout.tsx(305) Four readouts from one request
│   └── map.test.ts    (308)  ← includes the ctx.canvas guard test (see §13.7)
│
├── components/               ── shared console chrome ──
│   ├── VariablePanel.tsx(1092) The layer stack manager (owns the stack in its own state)
│   ├── DataCatalogueModal.tsx(513) Variable catalogue, 1-click add-to-map
│   ├── Timeline.tsx   (481)  Scrubber, play/pause, cadence
│   ├── DepthRuler.tsx (303)  24-level ruler with oceanographic zone callouts
│   ├── ProfilePanel.tsx(296) ← the model-vs-observation comparison chart
│   ├── CommandPill.tsx(179)  Top bar: view switch, points, provenance chip
│   ├── PointsDrawer.tsx(163) Float point inspection list
│   ├── Colorbar.tsx   (115)  A real labelled unit ruler
│   └── FloatList.tsx   (56)  Keyboard-reachable float selection
│
├── assistant/
│   ├── AssistantPanel.tsx(247) 420px floating panel with the citation line
│   ├── useAssistant.ts(180)  SSE consumption
│   ├── actions.ts     (113)  Applies validated actions to React state, with undo
│   └── AssistantDock.tsx(40) Slim right-edge entry point
│
└── styles/
    ├── tokens.css     (281)  ← the design system, downstream of context.md §5.1
    ├── app.css       (1335)  Console layout
    └── layers-panel · data-catalogue-modal · tool-dock · timeline
        · depth-ruler · command-pill · assistant  (6 component stylesheets)
```

### Three architectural notes worth a slide

1. **`viz/depth.ts` defines the depth axis once, at power 0.65, and the 3D column, the DOM depth
   ruler and the profile chart all import it.** Nearly all ocean structure — mixed layer,
   thermocline, cold wake — sits in the top 200 m of a 2000 m column, which a linear axis
   squeezes into 10% of the height. A shared non-linear axis means all three surfaces agree on
   where a depth *is*, literally rather than approximately. (Exponent 0.65, not 0.5: square root
   has infinite slope at zero, which turned the coastline itself into a vertical cliff.)

2. **`viz/lattice.ts` owns `RENDER_ORDER` for the entire 3D column, background included.** This
   exists because of a real bug: the atmosphere was compositing *on top of* the data at α ≈ 0.66,
   silently veiling every cmocean colour. Two rounds of shader tuning went into a field that was
   being covered a moment after it rendered. **If a `renderOrder` is written anywhere else, the
   table is already wrong.**

3. **`viz/colormaps.ts` defines value→colour exactly once** (`encodeRange` / `normaliseValue` /
   `lutIndex`). The diverging re-centring used to live inline in *both* `volume.ts` and
   `Colorbar.tsx`, and the map's rasterizer would have been a third copy — which is precisely how
   the same value ends up a different colour in two views.

---

## 11. The ocean assistant (AI)

Added 2026-09-06. It answers questions about the water from **real fetched data**, answers
general questions from its own knowledge, and **drives the application** in plain language:
*"add the chlorophyll layer and hide temperature"* applies as two state changes with one-click
undo.

### The danger, stated plainly

A plausible invented sea temperature inside an INCOIS-branded government tool is worse than no
assistant at all. So the grounding rule is **structural, not prompted**.

### How grounding is actually enforced

**The citation line is built from the tool calls that executed, never from the prose.** Read
tools return values *with* their provenance attached. The panel renders the citation from those
records. An answer that fetched nothing therefore has nothing to cite, and is visibly marked
**"General knowledge — not from your data"** in `advisory` amber — paired with words, never
carrying the meaning by colour alone. The system prompt states the rule too; **the interface
does not depend on the model having obeyed it.**

Web sources (when search grounding is enabled) are marked `kind="web"` and styled apart, because
a page Google returned is not the ocean analysis.

**Verified live 2026-09-08:** asked for the sea surface temperature at 15°N, 88°E, it answered
`30.06 °C` and rendered
`Temperature forecast · Copernicus Marine analysis & forecast · 2026-06-23 · 0 m · °C`
— built from the tool call that actually ran.

### The split tool loop — and why it has to be split

| | Where it runs | Why |
|---|---|---|
| **Read tools** (3 declared) | Backend, against the same endpoints the UI uses | `query_point`, `list_floats`, `compare_float` |
| **Action tools** (7) | **Validated** server-side against a state snapshot the client sends with every message, then **returned for the client to apply** | They mutate React state; a server cannot do that |

That split is what lets the model be told **the truth** about whether an action succeeded — it
learns *"that would need more than 3 layers"* rather than assuming it worked.

**Action tools:** `set_layers`, `set_view`, `set_time`, `set_depth`, `zoom_to_region`, `set_pin`,
`set_area`.

**`zoom_to_region` resolves a fixed lookup table and nothing else.** A model supplying its own
bounding box for a place name is the most dangerous kind of wrong here, because a
plausible-looking box is indistinguishable from a correct one on screen.

**`get_screen_state` and `search_variables` are deliberately *not* declared as tools** — they are
inlined into the system prompt instead. Measured: that took "add chlorophyll and hide
temperature" from three rounds to two, and two is the floor for a tool loop. On a per-minute
quota that is the difference between working and not.

### Persistence

SQLite behind a `ConversationStore` protocol — conversations, messages, tool calls, and an
`analysis_cache` table so a repeated question skips both the upstream and the model.

### Operational facts worth knowing on stage

- Model: **`gemini-3.5-flash`**, not the newer 3.8. Free-tier quota is *per model*, and the
  newest flash is the one everyone is hammering: measured on a real key, 3.8 returned 429
  (20/min, ~55 s to reset) while 3.5 answered the identical request immediately.
- One answer costs **two requests** (one tool call, one summary), so ~10 questions per minute on
  the free tier. Fine for a demo; tight if judges pass a laptop around.
- **Google Search grounding is wired but not in the free tier.** Every request carrying the tool
  429s with "check your plan and billing details"; the identical request without it succeeds.
  The client strips search and retries, then remembers for the process — so a missing grounding
  quota degrades *one feature* instead of taking down every question. Enable billing and live
  answers begin with **no code change**.
- **`store=False`** — no transcript persists on Google's servers. The defensible choice for a
  government deliverable.
- The key lives in gitignored `backend/.env`, **server-side only**. Without a key the dock button
  states the reason and everything else works.

---

## 12. The design system

The design is documented as canon in `context.md` §5 and made literal in
`frontend/src/styles/tokens.css`. It runs to **13 numbered principles** and a decision log of
~75 entries, several of which explicitly *reverse* earlier ones with a note on what survives.

### 12.1 Two colour systems that never mix

**Chrome — six named tokens, one job each:**

| Token | Role |
|---|---|
| `abyss` | Base background — deep water, near-seafloor |
| `thermocline` | Panel surfaces, dividers |
| `current` | Primary UI accent — buttons, active states, links |
| `bioluminescence` | **Live data** — the signature "alive" colour |
| `advisory` | **Hazard/alert state only** — ties to the Disaster Management theme, used nowhere else |
| `foam` | Primary text on dark surfaces |

**Data — perceptually-uniform `cmocean` ramps, as 256-stop lookup tables:**

| Colormap | Encodes |
|---|---|
| `thermal` | Temperature, D26, heat content |
| `haline` | Salinity |
| `speed` | Current magnitude |
| `algae` | Chlorophyll |
| `delta` | Anomalies, residuals, MLD (diverging, zero-centred) |

**The rule: no token ever encodes a physical value, and no colormap colour ever appears in the
chrome.** This is not aesthetics — using a brand gradient as a temperature scale produces uneven
perceptual steps that read as structure that is not in the data, and it fails the
colour-vision requirement. `cmocean` is oceanography's own standard for exactly this reason.

### 12.2 The current theme — Theme C, "Warm Maritime Chronometer & Copper"

Adopted 2026-09-07. Ground `#15161A`, surface `#1C1D22`, inset `#111215`, border `#2E303A`,
ink `#F4EFE6`, muted `#9698A3`, accent copper `#E59858`. Defined canonically as `--rt-*`
variables in `tokens.css`.

**Geometry: strict 0px border-radius, mathematical Swiss grid alignment, 8px spacing scale.**
This replaced an earlier rounded-card treatment specifically to restore the "instrument, not
dashboard" ethos.

**What Theme C deliberately removed** — a slide in its own right, because it is unusually honest
for a hackathon deliverable: fake status badges (`● 3D ACTIVE`, `HIDDEN`, `⏱ 2s auto-close`),
"Under Testing" chips, a fake 4K animation-export toast, and decorative wave SVGs in the
catalogue. They were replaced by standard GIS semantics — a 3px copper active indicator, an eye
visibility toggle — and by genuine oceanographic provenance tags (`INCOIS-HYCOM Analysis`,
`MODIS-Aqua Satellite`, `Reference Dataset`).

### 12.3 The principles that shaped the product

Abridged from `context.md` §5.1. These are the ones worth a judge's attention:

1. **Depth is the organizing metaphor.** The same ramp that encodes ocean depth in the render
   also darkens the surrounding chrome.
2. **Instrument, not dashboard.** The depth control is a real ruler with correctly-scaled ticks;
   the colorbar is a real labelled unit ruler. Never a decorative gradient.
3. **One bold gesture.** The load-in descent, and nothing else. Everything else is instant.
   `prefers-reduced-motion` cuts it in both directions.
4. **Two audiences, one interface.** *(Rewritten 2026-09-08 — see the warning below.)*
5. **Structure carries information.** No numbered eyebrows, no dividers that do not correspond
   to real structure.
6. **The viewport is a place, not a diagram.** A data volume in a void reads as a *chart* of the
   ocean; a data volume inside the sea reads as *the ocean*.
7. **The basemap is imagery; everything drawn on it is data.** The only marks added to the globe
   are things we measured.
8. **The viewport may carry instrument markings — but only ones the console already states.**
   The lattice uses the *same tick values* as the DOM ruler and vanishes for surface variables.
9. **A plan view is a chart table, and every layer states its own resolution.**
10. **Uppermost active layer rules the water column.**
11. **Side-by-side right HUD lanes** — instruments never overlap or obscure each other.
12. **Vertical depth discretization matches physical sampling** — the true 24-level grid, with
    real oceanographic zone callouts.
13. **An assistant may state a measurement only if it fetched one, and the interface proves
    which.**

### ⚠️ 12.4 The Ops/Explore toggle no longer exists — do not put it in the deck

Earlier documentation, and probably any deck draft written before 2026-09-08, describes an
**"Ops mode / Explore mode"** toggle. **It was removed on 2026-09-08 and it is not in the
product.**

An audit before deleting found that of the four things the mode controlled, **two were already
dead code**, and the three behaviours Principle 4 had promised Explore would provide — hiding
isosurface extraction, hiding colorbar editing, adding per-variable captions — **none of the
three ever existed**. A control that advertises three behaviours, delivers none, and silently
changes a fourth thing is worse than no control.

**PS requirement 7 — "doubles as a public science-communication / outreach tool" — is now met by
the interface being approachable by default**, not by a mode that strips controls: the load-in
descent, the globe, real place names on the map, plain-language empty and error states, and an
assistant anyone can ask a question in words.

### 12.5 Voice and microcopy

- Sentence case, active voice. Buttons say exactly what happens: "Show temperature", "Play
  timeline" — never "Enable Layer" or "Submit".
- Loading states name what is loading: *"Loading 25 Aug model run…"*, not *"Loading…"*.
- Empty states are an invitation with a next step: *"No Argo or Glider data in this window — try
  widening the date range"*, not *"No data found"*.
- Errors state what happened and what to do, without apologising: *"Model field unavailable for
  this depth — showing nearest available level (50 m)"*.

### 12.6 Accessibility floor

- Full keyboard operability — including a **keyboard-reachable float list**, because a marker in
  a WebGL canvas cannot be tabbed to. (It is also faster for a forecaster who already knows the
  platform they want.)
- Visible `focus-visible` ring on dark surfaces.
- `prefers-reduced-motion` respected in both directions.
- Hazard state is **never colour alone** — `advisory` amber is always paired with an icon or a
  label.
- Perceptually-uniform colormaps, which are colour-vision-safe by construction.

*Known gaps, recorded rather than hidden:* six of the newer component stylesheets carry no
`focus-visible` rule yet, and `CommandPill` overflows a 414 px viewport. See §16.

---

## 13. Scientific correctness — the things that make it trustworthy

**This is the section that separates this project from a visualization demo.** Each item below
is a correctness requirement that was found by looking at real data, and each is covered by a
test.

### 13.1 Argo quality control is not optional

Argo ships a QC flag per level. **Only flags 1 (good) and 2 (probably good) are accepted**, and
delayed-mode `*_ADJUSTED` values are preferred over real-time ones. The count of rejected levels
is computed and reported (**1,532 levels rejected** across the Phailin window).

The proof is float `2900757` (§5): it presents a beautiful −4.03 °C cold wake and is a broken
instrument. Without QC filtering it would be the most compelling thing on screen and it would be
a lie.

### 13.2 Pressure is not depth

Argo measures **decibar**; the analysis is indexed in **metres**. They differ by roughly 2%,
growing with depth. Since this application draws both on **one shared axis**, an unconverted
comparison would silently misalign — the model-vs-observation residual would be wrong in a way
that looks entirely plausible.

The conversion happens **exactly once, at ingestion**, using the latitude-dependent
**UNESCO / Fofonoff–Millard** formula. Two tests assert the conversion and its monotonicity.

### 13.3 Colour scales are percentile-clipped, and the UI says so

Geostrophic currents diverge as 1/f toward the equator, and chlorophyll is strongly
right-skewed. On raw min/max, one outlier flattens the entire colorbar — chlorophyll spans
**0.12–9.27 raw vs 0.28–1.29 clipped**. Scales are stretched over the **2nd–98th percentile**,
the true range is still reported, and the colorbar is marked *scale 2–98%* whenever clipping
applied.

### 13.4 Units we inferred are marked as inferred

`incois_valueadded_products_datasets` publishes **no units** for any of its variables. D26
(35–107), MLD (17–79) and heat content (3–251) are unambiguous from their physical ranges —
metres, metres, kJ/cm². **Current speed is not.** `sqrt(GEO_U² + GEO_V²)` spans 1.77–508: as
cm/s that is 5 m/s, impossible for geostrophic flow; as mm/s it is ~0.5 m/s, entirely plausible
for the Bay of Bengal.

It is labelled cm/s and **marked "units inferred"** in the UI, pending confirmation with INCOIS.
The interface states the uncertainty rather than hiding it. (Copernicus now gives a cross-check:
it publishes u/v in m/s over the same box.)

### 13.5 Post-processing may never shift a data colour

Three separate defences, each from a real incident:

- **No renderer-wide tone mapping.** ACES filmic looked better on the water but remaps *every*
  colour in the frame — the data volume included — shifting a reader's sense of a temperature
  away from what the colorbar states. `renderer.toneMapping = NoToneMapping` is deliberate.
- **Bloom is layer-selective by construction, not by threshold.** Only marker and sun-glint
  objects are in the bloom render at all. A brightness threshold would have failed silently the
  first time someone picked a warm palette.
- **The float ribbon uses a raw GLSL3 material, not Three's `Line2`.** `LineMaterial`'s fragment
  shader ends with a colour-space conversion that nothing neutralises — it is identity only
  because the composer's targets happen to be Linear-sRGB today. Change that and the ribbon
  shifts colour while the volume does not, silently disagreeing with the colorbar.

**The one deliberate exception, and why it is not a violation:** the globe basemap gets a gamma
shadow-lift (≈1.5) in its own shader, because Blue Marble's deep ocean sits at 3–12% luminance
and read as a black hole. That is confined to one shader, on a basemap that by Principle 7
encodes nothing. A future session tempted to "fix the inconsistency" would either flatten the
globe or corrupt the data.

### 13.6 Land is derived from the data's own no-data mask

Not from a coastline asset. It therefore cannot drift from the data, needs no external file, and
its blockiness is a *true statement* about the grid resolution. It also correctly shows mid-ocean
analysis gaps rather than pretending they are water.

Coastline and border *strokes* are drawn from Natural Earth for legibility — but strokes only,
never fills, so a line can never hide an ocean cell or invent one.

### 13.7 Mixed cadences are shown, not smoothed

There is exactly **one clock**. Each layer resolves it to its own **nearest** step and states the
offset (`−3 d`) in its housing when it exceeds half a cadence. The timeline draws one tick row
per visible layer, so a daily field and a 10-daily field visibly differ. A layer outside its
coverage greys out and its fetch is skipped, rather than silently drawing nothing.

Related, and it was a real bug: **a truncated time axis is a display sample, not the real
steps.** CMEMS is daily over 12,227 days and the timeline receives every 7th stamp to stay
~36 KB — snapping to that sample was reporting a "−4 d" offset on a product that has a step for
every single day. **The offset chip must only ever report an offset the data actually has.**

### 13.8 The rule that is enforced by a test

Drawing code in `map/` **must never read `ctx.canvas`**. The map's contexts are
`setTransform(dpr, …)`-scaled, so every coordinate is a CSS pixel while `ctx.canvas.*` is the
device-pixel backing store — on a HiDPI display every frame-relative threshold was **twice the
size of the frame**. That produced a coastline drawn straight across the map at the antimeridian
and a 1.54× vertical stretch of the streamline canvas, both reproducing only on a teammate's
Retina laptop.

`map.test.ts` now passes a context whose `canvas` getter **throws**, so reintroducing any of
this fails the suite rather than waiting for someone with the right screen to notice.

---

## 14. Engineering rigour and verification

### 14.1 Test suites — run and verified 2026-09-09

| Suite | Result | Notes |
|---|---|---|
| **Backend (pytest)** | **52 passed in 37.78 s** | Runs against the **live INCOIS server** and its disk cache |
| **Frontend (vitest)** | **31 passed in 0.84 s** | Projection, rasterization, colour encoding, assistant actions |
| **TypeScript** | **`tsc --noEmit` clean, exit 0** | |

*(The repository docs recorded "28/28 frontend"; the real current count is 31. Verified by
running it.)*

### 14.2 The backend tests assert real values, verified by hand before the code existed

These are not smoke tests. A representative selection:

- `test_phailin_cold_wake_is_present_in_float_2901335` — the demo narrative is a regression test.
- `test_bad_qc_float_is_rejected_entirely` — float `2900757` must produce **no profile at all**.
- `test_qc_rejection_is_counted_and_reported`
- `test_pressure_to_depth_conversion` / `test_pressure_to_depth_is_monotonic`
- `test_land_and_nodata_are_nan_not_zero` — because a zero temperature over land is a plausible
  ocean.
- `test_deep_water_is_colder_than_surface` — a physics assertion.
- `test_descending_latitude_is_normalised_to_ascending` — VIIRS stores latitude descending,
  HYCOM ascending. Getting it wrong is a **plausible-looking upside-down ocean**.
- `test_a_missing_component_never_becomes_a_valid_vector`
- `test_derive_stride_always_respects_the_cell_budget` (parametrized)
- `test_refuses_an_unknown_region_rather_than_guessing_coordinates` — the assistant's
  hallucination guard.
- `test_refuses_to_exceed_the_three_layer_cap`

### 14.3 The browser verification harness

`screenshot.mjs` drives a **real browser** via Puppeteer. It does not just take a picture — it:

- checks the 3D canvas actually renders data rather than a default-grey WebGL surface;
- **reads back the depth ruler's tick positions** and the colorbar's units;
- selects a float and confirms the profile panel opens;
- verifies `prefers-reduced-motion` genuinely suppresses the intro;
- verifies a **414 px viewport does not scroll sideways**;
- asserts **zero console errors**.

`shot.mjs` gives a fast single frame for iterating (`--skip`, `--globe`, `--globe-mode`);
`shot-map.mjs` covers the 2D map. Screenshots land in `temporary screenshots/`,
auto-incremented, never overwritten (~150 so far), gitignored.

**Stated honestly, and this belongs in the deck's limitations slide:** the harness runs on
**SwiftShader software rendering at 1–2 fps**. It verifies composition and correctness and tells
you **nothing** about real performance or subtle shading. Every visual constant in the 3D scene
was tuned against it.

### 14.4 The decision log as an engineering artifact

`context.md` §10 carries **~75 dated decision entries**, each with a one-line rationale. Several
explicitly **reverse** earlier decisions and state *what survives the reversal* rather than
quietly editing the old entry. Examples worth citing:

- *"The globe is a graticule, not a textured Earth"* → **reversed** when the team supplied NASA
  SVS reference frames. The risk the old decision named (a photographic sphere implying global
  coverage) is **paid down** — Principle 7 now forbids painting any field on the sphere, and the
  globe-mode caption states the basemap is a static 2004 image.
- *"Camera default is an elevated 3/4 view above the waterline"* → **reversed** to a submerged
  default, with the reasoning for the old one preserved: dragging up still returns to the basin
  overview.

`next_session.md` §6 lists **ten hard-won bugs** — each of which shipped once, looked entirely
plausible while doing so, and cost most of a session. Reading it is a precondition for touching
`frontend/src/viz/`.

**This is worth a slide.** It is unusual, and it is exactly the discipline that a government
deliverable maintained by rotating staff actually needs.

---

## 15. Problem-statement compliance matrix

| # | PS requirement | Status | Where |
|---|---|---|---|
| 1 | Render volumetric / depth-resolved ocean model fields (temp, salinity, currents) | ✅ **Built** | Raymarched 3D volume, 24 levels 5–2000 m. Temperature, salinity, current speed, chlorophyll + 3 hazard fields |
| 2 | Overlay Argo/Glider/CTD/BGC observations as markers with clickable depth-vs-variable profile charts | ✅ **Built** (Argo end to end) | Markers with true depth stems + `ProfilePanel`. Glider/CTD/BGC are architecturally supported via `InSituSource`, not implemented — scope boundary stated in §2.4 |
| 3 | Ingest NetCDF (via xarray) and delimited text through a modular parser layer | ✅ **Built** | `ingestion/base.py` `DataSource` protocol; xarray + netCDF4 for grids, pandas for tabular. **Proven by 5 upstreams on 3 protocols** |
| 4 | Interactive controls: variable selector, depth-slice slider, time-step animation, layer opacity, vertical exaggeration | ✅ **Built** | Layer stack (3 layers, per-layer opacity + log scale), 24-level depth ruler, timeline with play, ~425× vertical exaggeration |
| 4b | *Colorbar editor (palette / min-max / log-linear)* | ⚠️ **Partial** | Per-layer log/linear toggle and percentile clipping are built; a full palette/min-max editor is not |
| 5 | Open standards — OGC WMS/WCS, CF Conventions | ⚠️ **Partial** | **CF Conventions: yes** — all NetCDF ingestion is CF-1.6 compliant. **OGC WMS/WCS endpoints: not built**, named as roadmap |
| 6 | Deployable on INCOIS infra, no client-side plugin dependencies | ✅ **Built** | Pure browser, WebGL2 only, no plugins. All assets bundled locally — no CDN calls. SQLite rather than a hosted DB, deliberately. *Docker Compose packaging is roadmap* |
| 7 | Doubles as a public science-communication / outreach tool | ✅ **Built** | Met by the interface being approachable **by default** — the descent, the globe, real place names, plain-language empty/error states, and a plain-language assistant. **Not** by a mode toggle (§12.4) |
| — | *Stretch:* isosurface extraction | ❌ **Roadmap** | Scoped as Phase 5 from the start; described as roadmap, never claimed |

**Five of seven core requirements fully met, two partially, with the gaps named explicitly in the
same breath.** That honesty is a strength in front of a domain-expert panel — INCOIS engineers
will know immediately whether WMS is there.

---

## 16. What is *not* built — the honest roadmap

State these as roadmap. Do not let a slide imply otherwise; the panel includes people who will
check.

### Features not implemented

| Item | Status | Effort estimate |
|---|---|---|
| **OGC WMS/WCS endpoints** (PS req. 5) | Not built | Moderate — the field data is already served; this is a protocol adapter over existing slice logic |
| **Isosurface extraction** | Not built | Substantial — marching cubes over the volume, plus a UI for the threshold |
| **Docker Compose packaging** | Not built | Small — two Dockerfiles and a compose file; nothing in the architecture resists it |
| **Current *direction* in the 3D column** | Not built — the 3D layer shows **speed** only | The 2D map already has animated streamlines through the real u/v field, so the technique is proven; the 3D version must draw **only inside the INCOIS box** where GEO_U/GEO_V exist |
| **Glider / CTD / BGC ingestion** | Interface supports it; no implementation | One file each against `InSituSource` |
| **Full colorbar editor** (palette + min/max) | Log/linear and percentile clipping only | Small |
| **Bounding-box refetch at high map zoom** | The map always fetches globally at a stride, so deep zoom shows ~0.4° cells under a 50 m coastline | `derive_stride` already takes a bbox — **the most visible quality win available** |
| Assistant: token-streaming prose; conversation history in the panel | Only status streams today; the store and endpoints exist but nothing reads them | Small |

### Known defects, recorded rather than hidden

1. **Three colour systems are live at once.** The Theme C redesign touched no file in
   `frontend/src/viz/`, and `viz/scene.ts` carries a hardcoded copy of the six tokens. So the 3D
   viewport renders the *original* six values, `app.css` the *rewritten* six, and the console
   Theme C `--rt-*`. Worst case: `bioluminescence` — defined as "live data" — is `#4FE8C4` on the
   3D float markers and `#10B981` in the chrome, **in the same frame**. *Fix: make `viz/scene.ts`
   read the tokens rather than restate them.* **This is the biggest open design item.**
2. **`--rt-font-ui` declares Inter, which is not bundled.** There is no `@fontsource/inter`
   dependency, so on a clean demo machine the whole console falls back to Segoe UI. *Fix: one
   `npm i`, or return the token to IBM Plex Sans, which is already bundled.* **Do this before
   the pitch, not during it.**
3. **`CommandPill` overflows a 414 px viewport.** Document `scrollWidth` is 618 px against a 414
   viewport (down from 722 after the mode toggle was removed). Every offending element is
   `command-pill__*`. What the bar should *do* at 414 px — wrap, scroll, or collapse behind a
   control — is a design decision, so it is recorded rather than guessed at.
4. **Six component stylesheets carry no `focus-visible` rule** (`command-pill`, `layers-panel`,
   `tool-dock`, `timeline`, `depth-ruler`, `data-catalogue-modal`). `assistant.css` was rewritten
   with rings; the other six need the same pass. The accessibility floor makes this
   non-negotiable.
5. **`ToolDock.tsx` (443 lines) renders nowhere** — dead code after the Theme C merge
   redistributed its jobs into `CommandPill`. Delete it or wire it; a file that renders nowhere
   is worse than either.
6. **`screenshot.mjs` is stale.** It still drives a `.float-list__item` list that renders nowhere,
   and its step labels ("entry-globe", "ops-temperature") predate both the map landing view and
   the removal of Ops mode. The harness needs bringing back in line with the current UI.
7. **`--linear-blue-rgb: #5E6AD2`** — another product's brand colour, defined and used nowhere.
   Delete on sight.
8. Some dark silhouettes remain where coastal terrain is steepest; the scene is hazier than ideal
   (water fog constants tuned by eye on a software renderer).

### Open questions

| Question | Owner | Impact |
|---|---|---|
| **Nothing has been judged on a real GPU.** Every visual constant — water fog, the globe's shadow lift, the submerged camera, streamline density — was tuned against SwiftShader at 1–4 fps. The team chose fixed maximum quality with no fallback. | Team | **The single largest unknown before the pitch.** Mitigation: the offer of a manual High/Reduced toggle still stands |
| **Confirm current-speed units with INCOIS** (cm/s vs mm/s) | INCOIS | Labelled "units inferred" until then |
| **Enable Google Cloud billing for search grounding?** | Team | One decision, **no code either way** |
| Paste the official Acronyms and Dataset Links tables from the PS PDF into `context.md` §9 | Team | Needed for the report, not the build |
| Which Blue Marble month ships — October (seasonally honest for Oct 2013) or December (matches the supplied reference frames) | Team | **One line** in `backend/app/config.py`; both months are already committed |
| The hazard fields stop 2019-03-30 while the 3D grid runs to Jul 2026. If a "recent data" mode is added, those layers must degrade **with a stated reason** rather than silently vanish | Team | Design constraint for future work |

---

## 17. Impact and benefits

### 17.1 Who this serves

| Audience | What changes for them |
|---|---|
| **INCOIS forecasters** | Model field and instrument truth in one browser screen, on one depth axis. No export, no import, no format conversion, no second application. |
| **Disaster-management officials** (NDMA, state agencies, district collectors) | Cyclone-relevant subsurface fields — D26, upper-ocean heat content, mixed layer depth — visible without oceanographic tooling or training. |
| **Search-and-rescue coordinators** | Current fields plus real float positions, at depth, for drift estimation. |
| **Fishery advisory services** | Chlorophyll and SST are the inputs to INCOIS's potential-fishing-zone advisories; this makes their vertical and temporal context legible. |
| **Ocean modellers** | A live model-validation loop. The `/compare` residual points directly at where the analysis is smoothing real structure. |
| **Students, teachers, the public** | The same instrument, approachable by default. INCOIS's public-outreach mandate served by its own analysis stack rather than by a separate microsite. |

### 17.2 The disaster-management case, concretely

Cyclone intensification over the Bay of Bengal is governed by **subsurface heat**, not surface
temperature. A cyclone mixes the upper ocean; if the warm layer is deep (high D26, high heat
content), mixing brings up more warm water and the storm keeps intensifying. If the warm layer
is thin, mixing brings up cold water and the storm weakens. **This is a depth question, and every
existing operational display flattens it.**

This platform puts D26, upper-ocean heat content and mixed layer depth on the same clock and the
same map as the analysis and the floats — and then lets a forecaster check any of it against
whatever instrument was actually in the water.

Phailin is the proof case, and it is INCOIS's own: their forecast supported the evacuation of
**over a million people** from the Odisha coast. The cold wake this platform renders from float
`2901335` — 28.96 °C to 26.38 °C in 24 hours — is the physical signature of exactly the
process that governs whether the next storm intensifies or not.

### 17.3 Benefits by category

**Operational**
- Removes the export/import cycle between incompatible tools from the hazard-assessment loop.
- Zero client install. Any machine with a browser — an emergency operations centre, a district
  office, a ship — is a workstation.
- Cached-with-provenance operation means a degraded network downgrades gracefully and **says so**,
  rather than failing or, worse, silently showing stale data as live.

**Scientific**
- A visible, quantified model-validation loop. The −1.21 °C residual at 76 m is a finding, not a
  feature.
- QC-correct by construction — a broken instrument cannot become a published signal.
- Multi-source: INCOIS, HYCOM, VIIRS and Copernicus in one comparable frame, each labelled with
  its own real resolution and cadence.

**Economic**
- Entirely open-source stack. No per-seat GIS licences.
- Deployable on existing INCOIS infrastructure; no cloud dependency, no hosted database, no
  outbound calls a government network might refuse.
- Extending to a new sensor is one file against a documented protocol, not a subsystem.

**Social and educational**
- Turns an operational analysis stack into a public science-communication instrument at no extra
  build cost.
- Plain-language assistant lowers the entry barrier to real, cited ocean data for students,
  journalists and coastal communities.

**Environmental / climate**
- The upstreams reach back to 1993 (Copernicus) and 2002 (Argo), so the same interface serves
  long-record climate monitoring, not only event response.

### 17.4 What is genuinely novel here

Be precise about this in front of a domain panel — the novelty is not "3D ocean visualization",
which exists. It is:

1. **Model *and* observation on one shared depth axis in a browser, with the residual computed
   and drawn.** This is the specific gap the problem statement names, and it is the thing no
   desktop tool does in a browser.
2. **Provenance as a rendered, structural property.** Every layer states its own dataset,
   resolution, cadence and upstream. Every assistant answer's citation is built from executed
   tool calls, not prose. Inferred units are labelled as inferred. Clipped scales say they are
   clipped.
3. **A heterogeneous upstream fleet behind one interface** — 5 organisations, 3 protocols —
   which converts the extensibility requirement from a claim into a demonstration.
4. **Scientific honesty enforced by tests, not by intention** — QC rejection, pressure→depth,
   no tone mapping over data, and a unit test that throws if drawing code reads the wrong
   canvas dimension.

---

## 18. Feasibility, viability and risk

### 18.1 Feasibility — already demonstrated, not projected

| Concern | Evidence |
|---|---|
| Can a browser handle a 3D ocean volume? | **Yes, measured.** 24 × 60 × 90 = 129,600 points is trivial for WebGL2. The full volume is 1.0 MB as NetCDF, ~259 KB as Float32. |
| Is the data actually available? | **Yes.** INCOIS runs a public, CF-1.6-compliant ERDDAP server. Verified live: 17 datasets, `institution = INCOIS`. |
| Will it work on a slow network? | **Yes.** Disk cache with fresh → network → stale, provenance always shown. Copernicus: 11.6 s cold, **0.03 s cached**. |
| Can it be extended to new sensors? | **Demonstrated.** Five upstreams, three protocols, one interface. |
| Does it deploy on government infrastructure? | Pure browser, no plugins, all assets local, SQLite rather than a hosted DB. |

### 18.2 Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Real-GPU performance is unmeasured** | Highest-priority pre-pitch action. Volume payload is small and the map path is CPU-rasterized (immune). If the 3D scene is slow, a manual High/Reduced quality toggle is a scoped, understood change. |
| **Venue wifi fails during the demo** | Already solved: the disk cache serves the last good response and the header says `Cached · <date>`. Pre-warm the demo dates beforehand. |
| **INCOIS ERDDAP is down or slow** | Same cache path. Committed fixtures in `data/` are a further fallback. |
| **Gemini free-tier quota exhausted mid-demo** | ~10 questions/minute. Ask the assistant *early* in the demo, once. A 429 surfaces as "the free Gemini quota is used up for the moment" with Gemini's own retry delay, and **nothing else in the app is affected**. |
| **A judge asks about WMS/WCS** | Answer directly: not built, named as roadmap, and it is a protocol adapter over slice logic that already exists. |
| **A judge asks about current-speed units** | Answer directly: INCOIS publishes no units for that dataset, we labelled it "units inferred" rather than guess, and Copernicus gives us a cross-check. **This is a strength, not a gap.** |
| Long-term maintenance by rotating staff | The decision log, the trap list and `CONTRIBUTING.md` exist precisely for this. |

---

## 19. Deployment

### 19.1 Running it

**One command from the repo root:**

```bash
npm run dev          # both processes, prefixed output, Ctrl+C stops both
npm run dev -- --open  # ...and opens the browser once both answer
```

It resolves the venv itself (`Scripts/` on Windows, `bin/` elsewhere), refuses to start on a port
that already answers, and **takes both down if either dies**.

**Separately** (backend first — the browser cannot reach ERDDAP directly):

```bash
# Backend → http://127.0.0.1:8000   (OpenAPI docs at /docs)
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Windows
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# Frontend → http://localhost:5173
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to port 8000, so development and production both use same-origin paths.

On a fresh clone, if `frontend/public/*.jpg` is missing:
`cd frontend && node scripts/fetch-textures.mjs`

### 19.2 Configuration

`backend/.env` (gitignored; `.env.example` is committed with the variable names only):

| Variable | Effect if absent |
|---|---|
| `COPERNICUSMARINE_SERVICE_USERNAME` / `_PASSWORD` | Copernicus layers do not appear. Everything else works. |
| `GEMINI_API_KEY` | The assistant dock states the reason. Everything else works. |
| `GEMINI_MODEL` | Defaults to `gemini-3.5-flash`. |
| `GEMINI_SEARCH` | `auto` (default) probes once per process; `off` skips it; `on` insists. |

**Every optional capability degrades to a stated reason, never to a broken screen.** That
pattern is deliberate and worth stating on the deployment slide.

### 19.3 Production shape

Two processes plus a static bundle: `vite build` produces the frontend; `uvicorn` (behind
gunicorn/nginx) serves the API and can serve the bundle. Docker Compose packaging is the named
roadmap item. No external database, no message queue, no object store required.

---

## 20. Project statistics

*Measured 2026-09-09.*

| Metric | Value |
|---|---|
| **Total code** | **~24,900 lines** |
| Backend (Python, incl. tests) | 5,542 lines across 33 files |
| Frontend (TypeScript / TSX) | 13,178 lines |
| Frontend (CSS) | 5,221 lines across 9 stylesheets |
| Tooling / verification harness | 918 lines (`dev.mjs`, `screenshot.mjs`, `shot.mjs`, `shot-map.mjs`) |
| **Documentation** | `context.md` 1,486 lines (112 KB) · `next_session.md` 711 · `CLAUDE.md` 324 · `CONTRIBUTING.md` 191 |
| **Tests** | **52 backend** (live data, 37.78 s) + **31 frontend** (0.84 s) = **83 passing** |
| API endpoints | 20 |
| Data upstreams | 5 organisations, 3 protocols, 11 datasets |
| Variables served | 7 in the 3D column + 4 global map variables + 3 hazard fields |
| Depth levels | 24 (INCOIS, 5–2000 m) · 40 (HYCOM, to 5000 m) · 50 (Copernicus, to 5728 m) |
| Design principles documented | 13 |
| Decision-log entries | ~75, dated, several explicit reversals |
| Documented traps ("bugs that shipped once") | 10 in `next_session.md` §6, plus 8 map traps and 5 assistant traps |
| Git | 30 commits on `main`, 3 contributors, 4 feature branches merged |
| Screenshots captured during development | ~150 |

---

## 21. Team and working method

**Repository:** `github.com/yuvrajshr/Ocean3D` (private). Default branch `main`.

**Contributors:** Yuvraj Sharma (28 commits), Ashish Sinsinwal (2 — the Theme C redesign),
AarohiJ24 (2).

**Branches merged:** `sidePannel` (GIS layer stack, catalogue, depth ruler), `globe-enhancements`,
`designTest` (Theme C), `feature/ai-assistant`, `fix/map-alignment`, `tooling/one-command-dev`,
`ui/remove-mode-toggle`, `viz/chunk-lattice`.

### Working agreements that are actually enforced

- **Never commit directly to `main`.** Branch (`area/short-description`), PR, one review.
- **Rebase daily** — the highest-leverage habit in the repo. It does not prevent conflicts; it
  makes each one surface at the single commit that caused it, in your own branch, instead of all
  at once at PR time.
- **One person in `frontend/src/viz/scene.ts` at a time.** At 1,464 lines it is the composition
  hub and nearly every 3D change lands in it. `app.css`, `App.tsx`, `context.md` §10 and the two
  lockfiles are the other known collision points — documented in `CONTRIBUTING.md` §4 as a
  collision map.
- **Append to the decision log at the end and do not reflow neighbours.** Two branches both
  appending produces a small conflict whose resolution is obvious (keep both); reflowing makes it
  large and genuinely ambiguous.
- **`context.md` and `CLAUDE.md` must never drift from the code.** A new colour, shadow, type
  role or structural pattern goes into canon **before** it ships. When a decision is reversed,
  say so and say what survives — never quietly edit the old entry.
- **Before a PR:** backend tests, typecheck, build, and a screenshot pass with zero console
  errors.

### One merge lesson worth a slide

`designTest` and `feature/ai-assistant` merged into `main` **with no git conflict at all** — and
the result compiled, passed every test, and **had no way to open the assistant.** The redesign
had moved the dock's jobs elsewhere and stopped rendering the file the assistant's button lived
in; git auto-merged the two edits because they were in different regions of that file.

**The generalisable lesson: a clean merge between a redesign and a feature says nothing about
whether the feature is still reachable.** Check reachability, not just the build.

---

## 22. Deck outline — slide by slide

### 22.1 If using the standard SIH template (5–6 slides)

> Confirm against the official SIH 2026 template file before building; the section headings below
> follow the shape SIH has historically used.

**Slide 1 — Problem statement**
PS 26067 · MoES / INCOIS · Software · Disaster Management. Title verbatim. One line: *"Model and
observation cannot be seen together, in 3D, in a browser — so hazard assessment is slower than
it needs to be."*

**Slide 2 — Proposed solution**
- The three views (map / water column / globe), one screenshot each.
- **The signature feature**: float cast + model + residual on one depth axis.
- Innovation: model-vs-observation co-visualization; provenance rendered structurally; five
  upstreams on one interface; a grounded assistant.
- *Emphasise: runs on INCOIS's own public data, nothing synthesized.*

**Slide 3 — Technical approach**
- The architecture diagram from §7.1.
- Stack: React 19 + TypeScript + Three.js (WebGL2 raymarching) / FastAPI + xarray + pandas.
- The `DataSource` protocol and the two normalized schemas.
- Binary Float32 volumes; Zarr/tiling measured and rejected.
- Working prototype — 52 + 31 tests passing, screenshots.

**Slide 4 — Feasibility and viability**
- Everything from §18.1 — each row is a measured number, not a projection.
- Risks table from §18.2, with the real-GPU item stated openly.
- Open-source stack, no licences, deployable on existing infrastructure.

**Slide 5 — Impact and benefits**
- The six audiences (§17.1).
- The disaster-management case: cyclone intensification is a *subsurface heat* question, and
  every existing display flattens it (§17.2).
- Phailin: over a million evacuated. The −2.6 °C cold wake this platform renders is the physical
  signature of that process.
- Economic / social / environmental bullets from §17.3.

**Slide 6 — Research and references**
INCOIS ERDDAP · Copernicus Marine (with the required credit line) · NOAA NCEI ETOPO1 · APDRC
HYCOM · NOAA CoastWatch VIIRS · NASA Blue Marble (Visible Earth) · Argo QC manual ·
UNESCO/Fofonoff–Millard · cmocean · CF Conventions · OGC WMS/WCS · NASA SVS.

### 22.2 If a longer demo-day deck is wanted (15–18 slides)

| # | Slide | Source section |
|---|---|---|
| 1 | Title — PS 26067, team, one-line pitch | §1 |
| 2 | The problem — model vs. observation, and why it's a *depth* problem | §2.2 |
| 3 | Why current tools fail — the five barriers table | §2.3 |
| 4 | **What we built** — the three views, three screenshots | §3 |
| 5 | **The signature feature** — the comparison, and the −1.21 °C at 76 m | §4 |
| 6 | The demo narrative — Phailin, the two good floats | §5 |
| 7 | **The trap** — float `2900757`, and why QC is a correctness requirement | §5, §13.1 |
| 8 | Data — five organisations, three protocols, nothing synthesized | §6 |
| 9 | Architecture diagram | §7.1 |
| 10 | The extensibility claim, demonstrated — `DataSource` + two schemas | §7.3 |
| 11 | Tech stack, with the three decisions we *rejected* (Cesium, Zarr, Tailwind) | §8 |
| 12 | Scientific correctness — QC, pressure→depth, percentile clipping, no tone mapping | §13 |
| 13 | Design system — two colour systems that never mix; instrument, not dashboard | §12 |
| 14 | The ocean assistant — grounding enforced structurally, live citation screenshot | §11 |
| 15 | Engineering rigour — 83 tests, the browser harness, the decision log | §14 |
| 16 | PS compliance matrix — 5 met, 2 partial, gaps named | §15 |
| 17 | Impact | §17 |
| 18 | Roadmap + what's honestly not built | §16 |

### 22.3 Screenshots to capture for the deck

Run `node screenshot.mjs deck` and `node shot-map.mjs deck` with both servers running, on a
**real GPU machine**, and pick from `temporary screenshots/`:

1. The 2D map with two stacked layers and visible streamlines — showing the per-layer provenance
   housings.
2. The 3D water column, submerged default view, with float markers and the depth lattice visible.
3. **The profile panel open on `2901327`** — this is the money shot. Make the residual curve
   readable.
4. The globe with the analysis extent outlined over the Bay of Bengal.
5. The assistant panel with a real answer and its citation line.
6. The data catalogue modal.
7. A colorbar close-up showing real units and the *scale 2–98%* marking.

---

## 23. Demo script (8 minutes)

**Before you start:** both servers running, demo dates pre-warmed (Copernicus is 12 s cold and
0.03 s cached), browser at 1920×1080, and **run this once end-to-end on the actual demo machine**.

| Time | Beat | What to say |
|---|---|---|
| 0:00 | **Open on the 2D map.** | "This is the global ocean, today. Every layer states its own source, resolution and cadence — this one is Copernicus at 0.083°, daily. Nothing here is synthesized." |
| 0:45 | Set the date to **10 October 2013**. Add the **D26** layer. | "October 2013. Cyclone Phailin is about to cross the Bay of Bengal. This layer is the depth of the 26 °C isotherm — the warm layer a cyclone feeds on. It comes from INCOIS, at 1°, ten-daily — and the housing says so, because a reader must always be able to tell which upstream a pixel came from." |
| 1:30 | **Dive into the water column.** | *(Let the descent play — it is the one orchestrated moment.)* "Now we're in the water. This is the INCOIS analysis, raymarched: 24 depth levels from 5 metres to 2000. The opacity is driven by the local gradient, so a thermocline reads as a surface instead of as fog." |
| 2:30 | Show the **depth ruler**, hover a zone. | "This is a real ruler on the real 24-level grid, and it names the physical zone — mixed layer, thermocline core, Argo parking depth." |
| 3:00 | **Select float `2901335`.** | "These are the Argo floats that actually reported in this window, at their true positions. The stem shows how deep each one profiled." |
| 3:30 | **The cold wake.** | "10 October: 28.96 °C at the surface. 11 October, as Phailin passes overhead: 26.38 °C. A 2.6 degree cold wake in 24 hours — the storm mixing cold water up from below. It recovers to 29.14 by the 20th." |
| 4:30 | **Select `2901327`. Open the profile panel.** | "Here is the point of the whole project. Blue is what the float measured. Orange is what the INCOIS analysis predicted at the same place and the same time. And this third trace is the difference, on its own scale." |
| 5:00 | **The money shot.** | "The mean residual across the profile is minus 0.10 degrees — which on its own says the model is fine. **At 76 metres it's minus 1.21.** The 1° analysis smoothed out a thermocline the float actually measured. The average hides it; the depth axis reveals it; and no 2D tool would have shown you either. That's a live model-validation loop." |
| 5:45 | **The QC slide, verbally.** | "One more float looked even better — a 4 degree wake. Every level of it is QC flag 4, all at zero decibar, salinity 0.014. It's a broken instrument, not an ocean signal. We reject it at ingestion, and there's a regression test that fails if it ever produces a profile again." |
| 6:15 | **The assistant.** Ask: *"add the chlorophyll layer and hide temperature"*, then *"what is the sea surface temperature at 15 N, 88 E"*. | "It drives the app in plain language — with one-click undo. And when it states a measurement, look at the citation line: it's built from the API call that actually ran, not from the model's prose. If it fetched nothing, it says so in amber. A plausible invented sea temperature inside an INCOIS tool is worse than no assistant." |
| 7:15 | **Globe, then close.** | "Five upstream organisations on three different protocols, all behind one interface — which is what makes 'extensible to new sensors' a demonstration instead of a claim. 83 tests, run against live data. Everything I showed you came off INCOIS's own public server." |

**Fallbacks rehearsed:** if the network drops, the header switches to `Cached · <date>` and the
demo continues — *say so out loud, it is a feature*. If the assistant 429s, it names the quota
and nothing else breaks.

---

## 24. Judge Q&A preparation

**"Why Three.js and not CesiumJS / Google Earth Engine?"**
The 3D analysis is a regional 1° box — 30.5–119.5°E, 29.5°S–29.5°N. A globe-primary product
renders a small patch on a mostly empty sphere. We needed a custom raymarch shader with a
gradient transfer function and depth-dependent water absorption; Three.js gives that, Cesium
fights it. Decision recorded and closed 2026-08-31. *We do have a globe — it's a basemap and a
navigation surface, deliberately not a data surface.*

**"Where is the data actually coming from? Is it real?"**
INCOIS's own public ERDDAP server, plus four other real upstreams. Every dataset was verified
against the live server — dimensions read from `/info/`, payload sizes and latency measured.
Nothing is synthesized, and 52 backend tests run against the live server every time.

**"How do you handle a new sensor type — ADCP, moorings, HF-radar?"**
One file implementing the `DataSource` protocol in `backend/app/ingestion/base.py`. Nothing else
in the application changes, because everything normalizes to two schemas before it reaches a
router. We've already done this five times across three different protocols — ERDDAP griddap and
tabledap, an ArcGIS ImageServer returning binary GeoTIFF, and the Copernicus Zarr toolbox.

**"Is OGC WMS/WCS implemented?"**
No, and it is named as roadmap rather than claimed. CF Conventions compliance *is* there — all
NetCDF ingestion is CF-1.6. WMS/WCS is a protocol adapter over slice logic that already exists;
`/map/slice/data` already does the hard part.

**"Will this run on our hardware?"**
The payloads are small — a full 3D volume is 1.0 MB and 129,600 points is trivial for WebGL2.
**In fairness: we have not yet profiled it on a discrete GPU** — our verification harness runs
software rendering. That's our top open item, and if it needs it, a manual quality toggle is a
scoped change.

**"What if the network fails during a real operation?"**
Every upstream response is cached to disk with provenance, resolving fresh → network → stale.
If INCOIS is unreachable you get the last good response and the header says `Cached · <date>`.
The user is always told which. That is the honest behaviour for an operational tool.

**"Those current-speed values look wrong."**
They may be. INCOIS publishes no units for that dataset. `sqrt(u²+v²)` spans 1.77–508, which is
impossible as cm/s and plausible as mm/s. We label it cm/s and mark it **"units inferred"** in the
UI rather than guess silently — and Copernicus now gives us a cross-check in m/s over the same
box. It's a question for INCOIS, and it's on the open list.

**"Why is the ocean blocky at high zoom?"**
Because that is the real grid. We disable image smoothing deliberately: bilinear scaling
interpolates *between* colormap entries and produces colours that are not in the ramp, and it
bleeds land colour across coastlines. Blocky is the honest result. Higher-resolution refetch at
deep zoom is on the roadmap.

**"How do you stop the AI making things up?"**
Structurally, not by prompting. The citation line is rendered from the tool calls that actually
executed — so an answer that fetched nothing has nothing to cite and is marked "General knowledge
— not from your data" in amber, paired with words rather than colour alone. `zoom_to_region`
resolves a fixed table and refuses unknown places rather than supplying a bounding box, because a
plausible-looking box is indistinguishable from a correct one on screen. And action tools are
validated server-side against real state, so the model is told the truth about whether something
worked.

**"What's the hardest bug you hit?"**
The analysis volume and the seafloor cannot share one vertical axis. The analysis needs ~425×
exaggeration to read as a water column; the seafloor needs almost none to read as a basin. On one
axis the continental slope — 2 km of drop over 60 km — renders as a sheer wall, right inside the
visible band. Four rebuilds. Smoothing didn't help, clamping made it worse. The resolution is two
separate axes plus a photic-zone dissolve below ~250 m. It's decision-logged, and the cost is
stated: seafloor height is indicative, nothing reads a depth off it.

**"What would you build next, with more time?"**
In order: WMS/WCS endpoints, bounding-box refetch at high zoom, current direction as streamlines
in the 3D column, then isosurface extraction and Docker packaging.

---

## 25. Pre-pitch checklist

**Blocking — do these before the deck is final**

- [ ] **Bundle Inter, or point `--rt-font-ui` back at IBM Plex Sans.** On a clean demo machine the
      whole console currently falls back to Segoe UI. One `npm i` either way. (§16, defect 2)
- [ ] **Run the app on a real GPU** and judge the visuals. The single largest unknown; every visual
      constant was tuned against software rendering at 1–4 fps.
- [ ] **Remove every reference to "Ops mode / Explore mode" from any deck draft.** The toggle was
      deleted on 2026-09-08 and does not exist. (§12.4)
- [ ] **Pre-warm the demo dates** — walk every date you will show so Copernicus is 0.03 s, not 12 s.
      A short script against `/api/map/slice/meta` is enough.
- [ ] **Capture deck screenshots on the GPU machine** (§22.3).
- [ ] **Rehearse the Phailin narrative end to end** on the actual demo laptop.

**Should do**

- [ ] Decide Google Search billing — one decision, no code either way.
- [ ] Decide the Blue Marble month (October is seasonally honest for the scenario; December
      matches the reference frames). One line in `backend/app/config.py`.
- [ ] Paste the official Acronyms and Dataset Links tables from the PS PDF into `context.md` §9.
- [ ] Confirm current-speed units with INCOIS if there is any channel to ask.
- [ ] Add `focus-visible` rules to the six stylesheets missing them.
- [ ] Fix or scope the `CommandPill` 414 px overflow.
- [ ] Delete or wire `ToolDock.tsx`; delete `--linear-blue-rgb`.

**Nice to have**

- [ ] Make `viz/scene.ts` read tokens rather than hardcode them — collapses three colour systems
      to one.
- [ ] Bring `screenshot.mjs` back in line with the current UI.

---

## 26. Glossary

| Term | Meaning |
|---|---|
| **INCOIS** | Indian National Centre for Ocean Information Services, Hyderabad |
| **MoES** | Ministry of Earth Sciences |
| **Argo** | Global array of ~4,000 autonomous profiling floats measuring temperature and salinity |
| **CTD** | Conductivity, Temperature, Depth — the standard ship-deployed profiling sensor |
| **BGC** | Bio-Geo-Chemical — a float/sensor variant adding oxygen, nitrate, chlorophyll, pH |
| **ADCP** | Acoustic Doppler Current Profiler |
| **ERDDAP** | NOAA's open data server protocol. `griddap` for gridded fields, `tabledap` for point/tabular data |
| **NetCDF** | Network Common Data Form — the standard self-describing scientific array format |
| **CF Conventions** | Climate and Forecast metadata conventions for NetCDF |
| **OPeNDAP** | Open-source Project for a Network Data Access Protocol |
| **OGC WMS / WCS** | Open Geospatial Consortium Web Map Service / Web Coverage Service |
| **D26** | Depth of the 26 °C isotherm — the depth to which water stays above 26 °C. A primary predictor of cyclone intensification |
| **OHC / HTCNT** | Upper-ocean heat content — the thermal energy available to a passing cyclone |
| **MLD** | Mixed layer depth — how deep wind and waves have stirred the surface layer |
| **Thermocline** | The depth band where temperature falls sharply with depth |
| **Cold wake** | The band of cooled surface water a cyclone leaves behind by mixing cold water upward |
| **Geostrophic current** | Current inferred from the balance of pressure gradient and Coriolis force. Diverges as 1/f toward the equator |
| **cmocean** | The standard perceptually-uniform colormap family for oceanography |
| **Raymarching** | Volume rendering by stepping a ray through a 3D texture and accumulating colour and opacity |
| **Decibar (dbar)** | Pressure unit Argo reports depth in. ≈ 1.02 dbar per metre, latitude-dependent |
| **QC flag** | Argo per-level quality code. 1 = good, 2 = probably good, 4 = bad |
| **HYCOM** | HYbrid Coordinate Ocean Model — global operational ocean model |
| **GLORYS12V1** | Copernicus Marine global ocean physics reanalysis, 0.083°, 50 levels |
| **VIIRS** | Visible Infrared Imaging Radiometer Suite — the satellite sensor behind the global chlorophyll product |
| **ETOPO1** | NOAA's 1 arc-minute global relief model (topography + bathymetry) |
| **EEZ** | Exclusive Economic Zone |
| **Blue Marble (BMNG)** | NASA's public-domain global true-colour Earth imagery, with topography and bathymetry shading baked in |
| **SwiftShader** | Google's CPU-based software renderer for WebGL — what our screenshot harness runs on |

---

## 27. References

### Data sources

| Source | URL | Use | Licence / attribution |
|---|---|---|---|
| **INCOIS ERDDAP** | `https://erddap.incois.gov.in/erddap` | The 3D analysis grid, Argo profiles, hazard fields, chlorophyll | Public; INCOIS, Ministry of Earth Sciences |
| **Copernicus Marine Service** | `https://data.marine.copernicus.eu/` | GLORYS12V1 reanalysis + analysis/forecast | **Licence condition:** *"Generated using E.U. Copernicus Marine Service Information"* + product DOIs `10.48670/moi-00021`, `10.48670/moi-00016`. Rendered in the layer housing |
| **NOAA NCEI** | `https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics` | ETOPO1 bedrock relief | Public domain |
| **APDRC, University of Hawaii** | `https://apdrc.soest.hawaii.edu/erddap` | HYCOM GLBv0.08 | Public |
| **NOAA CoastWatch** | `https://coastwatch.noaa.gov/erddap` | S-NPP VIIRS chlorophyll | Public domain |
| **NASA Visible Earth** | `https://visibleearth.nasa.gov/` | Blue Marble Next Generation basemap | Public domain, credited in UI |
| **Natural Earth** | `https://www.naturalearthdata.com/` | Coastlines and national borders | Public domain |

### Standards and methods

- **CF Conventions** — Climate and Forecast metadata conventions for NetCDF.
- **OGC WMS / WCS** — Open Geospatial Consortium web map and coverage services (roadmap).
- **Argo Quality Control Manual** — QC flag semantics; flags 1 and 2 accepted.
- **UNESCO / Fofonoff–Millard** — the latitude-dependent pressure-to-depth conversion.
- **cmocean** (Thyng et al.) — perceptually-uniform colormaps for oceanography.

### Design references

- **Copernicus Marine Service** — studied for data and metadata rigour: how a national ocean
  service names variables, states units, documents depth levels and describes product
  uncertainty. **Not** for its interface — its catalogue-portal layout (faceted list + 2D map +
  side panel) is the opposite of this brief.
- **NASA Scientific Visualization Studio** (`https://svs.gsfc.nasa.gov/`) — studied for
  scientific-visualization visual language: field colouring, annotation, flow rendering, and
  motivated camera moves. SVS content is public domain and legally reusable; **that we do not
  ship SVS renders as project assets is our design decision, not a licence limit** — a borrowed
  film frame shows their data, not ours.

### Internal documents

| File | What it owns |
|---|---|
| `context.md` | **Canon.** Problem statement, architecture, data model, locked design system, ~75-entry decision log, open questions |
| `CLAUDE.md` | Frontend working rules |
| `next_session.md` | Status report and **the trap list** (§6 = ten bugs that already shipped once) |
| `CONTRIBUTING.md` | Branch/PR workflow, the collision map, the pre-PR verification suite |
| `README.md` | How to run it |
| `REDESIGN_SPEC.md`, `DESIGN.md` | Design-system exploration documents |

---

*Compiled 2026-09-09 from the working repository. Test results, line counts and suite timings in
this document were run and verified on that date; every unverified claim is flagged as such in
§14 and §16.*
