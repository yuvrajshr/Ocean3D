# INCOIS 3D Ocean Data Visualization

**Smart India Hackathon 2026 · Problem statement 26067 · Ministry of Earth Sciences / INCOIS**

A browser-native 3D water column that shows INCOIS ocean-analysis fields and real Argo float
observations together, on one depth axis, in one screen.

> Read `context.md` for the problem statement, data model and locked design system, and
> `CLAUDE.md` for the frontend working rules. This file is just how to run it.

---

## What it does

The demo opens on **Cyclone Phailin, October 2013** — the storm INCOIS and IMD forecast
successfully, prompting the evacuation of over a million people from the Odisha coast.

- A **raymarched 3D water column** of the INCOIS gridded analysis: 24 depth levels from 5 m to
  2000 m, temperature and salinity.
- **Argo floats** that reported alongside each model run, drawn as markers with a stem showing
  how deep each one profiled.
- Clicking a float opens the **profile panel**: its measured curve, the INCOIS analysis at the
  same place and time, and the difference between them on its own scale. This is the thing no
  desktop tool does in a browser, and it is the point of the project.
- **Currents, chlorophyll**, and the cyclone-specific hazard fields (**depth of the 26 °C
  isotherm, upper-ocean heat content, mixed layer depth**) — the fields that actually explain
  cyclone intensification.
- **Ops** and **Explore** modes: one visual system at two control densities.

All of it runs against INCOIS's own public ERDDAP server. No data is synthesized.

---

## Running it

Two processes. Backend first — the browser cannot reach ERDDAP directly (it sends no CORS
headers), so nothing renders without it.

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS / Linux

.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

API docs at `http://127.0.0.1:8000/docs`.

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Vite proxies `/api` to port 8000, so both development and production use same-origin paths.

---

## Verifying

```bash
cd backend && .venv/Scripts/python -m pytest tests -v
```

Eleven integration tests run against the live server (and its local cache afterwards). They
assert real values verified by hand before the code existed — including that Cyclone Phailin's
cold wake is present in float 2901335, and that float 2900757, whose levels are all QC-flag 4,
produces no profile at all.

```bash
npx tsc --noEmit                  # from frontend/
node screenshot.mjs <label>       # from the repo root, with both servers running
```

The screenshot harness drives a real browser: it checks the canvas renders, reads back the depth
ruler tick positions and the colorbar units, selects a float, and separately verifies that
`prefers-reduced-motion` suppresses the intro and that a 414 px viewport does not scroll
sideways. Images land in `temporary screenshots/`, auto-incremented, never overwritten.

---

## Two things worth knowing before you trust a number

**Quality control is not optional.** Argo ships a QC flag per level. Float `2900757` looks like a
dramatic −4 °C cold wake during Phailin; every one of its levels is flag 4, at 0 db, with a
salinity of 0.014 PSU. It is a broken instrument, not an ocean signal. The ingestion layer accepts
only flags 1 and 2, prefers delayed-mode adjusted values, and reports how many levels it rejected.

**Pressure is not depth.** Argo measures decibar; the analysis is indexed in metres. They differ
by roughly 2%, growing with depth. Since this app draws both on one axis, the conversion happens
once, at ingestion, using the latitude-dependent UNESCO formula.

---

## Data

Data is sourced from INCOIS ERDDAP (`https://erddap.incois.gov.in/erddap`) and Copernicus Marine Service (CMEMS).

| Dataset | Provider | Provides |
|---|---|---|
| `incois_argo_10d_VAM` | INCOIS | Gridded temperature and salinity, 24 levels 5–2000 m, 2004 → 2026 |
| `Indian_ARGO_Floats` | INCOIS | Argo profiles with QC flags, 2002 → Apr 2025 |
| `incois_valueadded_products_datasets` | INCOIS | Currents, D26, heat content, mixed layer depth, 2004 → Mar 2019 |
| `incois_oceansat2_datasets` | INCOIS | Chlorophyll, 2011 → 2020 |
| `cmems_wave_height` (WAVERYS & NRT) | CMEMS | Spectral significant wave height (`VHM0`, m), 1980 → 2026 |
| `cmems_ph` (BGC-BIO) | CMEMS | Ocean potential hydrogen (`ph`), 2023 → 2026 |
| `cmems_zooplankton` (SEAPODYM-LMTL & Plankton NRT) | CMEMS | Zooplankton surface biomass (`zooc`, g/m²), 1998 → 2026 |

The backend caches every upstream response to disk and falls back to it when INCOIS is
unreachable, so a demo never depends on venue wifi. The header always says which it is showing —
`Live · INCOIS ERDDAP` or `Cached · <date>`.

Two caveats the interface states rather than hides: INCOIS publishes no units for the
value-added fields, so those labels are our reading of the values and are marked *units
inferred*; and colour scales are stretched over the 2nd–98th percentile, marked *scale 2–98%*,
because geostrophic currents diverge toward the equator and one outlier would otherwise flatten
the whole colorbar.

**One open question for INCOIS.** D26, mixed layer depth and heat content are unambiguous from
their physical ranges. Current speed is not: `sqrt(GEO_U² + GEO_V²)` spans 1.77–508, which is
impossible as cm/s (5 m/s) but reasonable as mm/s (0.5 m/s). It is labelled cm/s and marked
inferred pending confirmation. See `context.md` §11.

### Not built yet

Current *direction* is not drawn — the layer shows speed only; vector arrows or streamlines are
the natural next step. OGC WMS/WCS endpoints, isosurface extraction and Docker Compose packaging
are also outstanding; all three are described in the pitch as roadmap rather than implemented.

---

## Layout

```
backend/app/
  ingestion/     DataSource plugin interface + ERDDAP sources (grid, Argo)
  routers/       catalog, field (binary volumes), instruments (+ /compare)
  erddap_client  the only place that talks upstream; contains the TLS quirk
  cache.py       disk cache with provenance
frontend/src/
  viz/           Three.js scene, raymarch volume, colormaps, depth transform
  components/    DepthRuler, Colorbar, Timeline, VariablePanel, FloatList, ProfilePanel
  styles/        tokens.css (design system), app.css (console layout)
```

Adding a new sensor — ADCP, HF-radar, moorings — means implementing the protocol in
`backend/app/ingestion/base.py` and nothing else. Everything normalizes to the two schemas in
`context.md` §6 before it reaches a router, so the frontend never learns what format a point
came from.
