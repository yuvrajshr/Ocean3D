# INCOIS 3D Ocean Data Visualization

**Smart India Hackathon 2026 · Problem statement 26067 · Ministry of Earth Sciences / INCOIS**

A browser-based tool for looking at ocean model output and real Argo float measurements
together, in 3D, in one screen.

---

## What it does

The demo is set on **Cyclone Phailin, October 2013**, the storm INCOIS and IMD forecast well
enough to evacuate over a million people from the Odisha coast.

- **Map** (the landing view): a global ocean map with up to three stacked layers such as
  temperature, salinity, chlorophyll, currents, wave height, pH and mixed layer depth. Each
  layer shows its source, grid spacing and date range. Currents are drawn as animated
  streamlines, and clicking a point gives its profile, time series and depth-time section.
- **Globe**: NASA Blue Marble with the Argo floats in the analysis area. Clicking a float
  opens the **profile panel**: the float's measured profile, the INCOIS analysis at the same
  place and time, and the difference between the two.
- **Chunk view**: one 5° block of ocean from the surface to 2000 m in 3D. The field can be
  shown as slices, a stacked volume or an isosurface, along with current traces, the seabed
  and Argo tracks.
- **Assistant**: ask questions in plain English ("what is the temperature at 100 m here?")
  or give commands ("add the chlorophyll layer"). Answers that use data show where the
  numbers came from, and every change it makes can be undone.

All data comes from public servers: INCOIS ERDDAP for the analysis, Argo floats and ocean
colour; Copernicus Marine and HYCOM (via APDRC) for the global layers; NOAA NCEI for the
seabed. The source is named on screen wherever its data is drawn. Nothing is synthesized.

---

## Running it

The app has two parts, a FastAPI backend on `:8000` and the Vite frontend on `:5173`, and it
needs both. The browser can't call ERDDAP directly (no CORS headers), so without the backend
the frontend shows nothing and logs `ECONNREFUSED 127.0.0.1:8000`.

### First time

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS / Linux

cd ../frontend
npm install
```

Copy `backend/.env.example` to `backend/.env` and fill in the keys you have. The Copernicus
layers need a free Copernicus Marine account, and the assistant needs a Gemini API key.
Without them, those features are turned off and everything else still works.

### Every time

```bash
npm run dev             # from the repo root or from frontend/, starts both
npm run dev -- --open   # same, and opens the browser
```

App at `http://localhost:5173`, API docs at `http://127.0.0.1:8000/docs`. Ctrl+C stops both.

To run them separately (for example, the backend under a debugger):

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
cd frontend && npm run dev:vite      # frontend only
```

---

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest tests -v     # hits the live servers
cd frontend && npm test && npx tsc --noEmit
```

The backend tests check real values, for example that Phailin's cold wake shows up in float
2901335, and that float 2900757 (every level QC-flagged bad) produces no profile.

---

## Two things to know before trusting a number

**Quality control matters.** Float `2900757` looks like a dramatic -4 °C cold wake during
Phailin, but every level is QC flag 4, at 0 dbar, with a salinity of 0.014 PSU. It's a broken
sensor. We only accept QC flags 1 and 2 and prefer the adjusted values.

**Pressure is not depth.** Argo reports decibars, while the model uses metres. The difference
is about 2% and grows with depth, so we convert once at ingestion using the UNESCO formula
(which depends on latitude).

---

## Data

| Dataset | Provider | Used for |
|---|---|---|
| `incois_argo_10d_VAM` | INCOIS | Gridded temperature and salinity, 24 levels 5-2000 m, 2004-2026 |
| `Indian_ARGO_Floats` | INCOIS | Argo profiles with QC flags, 2002 - Apr 2025 |
| `incois_valueadded_products_datasets` | INCOIS | Currents, D26, heat content, mixed layer depth, 2004 - Mar 2019 |
| `incois_oceansat2_datasets` | INCOIS | Chlorophyll, 2011-2020 |
| GLORYS12V1 and analysis/forecast | Copernicus Marine | Global temperature, salinity, currents |
| WAVERYS and NRT waves | Copernicus Marine | Significant wave height (`VHM0`, m) |
| BGC products | Copernicus Marine | pH, zooplankton |
| HYCOM GLBv0.08 | APDRC | Chunk view: 0.08°, 40 levels, 1994-2015 |
| ETOPO1 | NOAA NCEI | Seabed and land elevation |

Every upstream response is cached on disk, and the cache is used when a server can't be
reached, so the demo doesn't depend on venue wifi.

Some things the interface says openly rather than hiding. INCOIS publishes no units for the
value-added fields, so those labels are inferred from the value ranges and marked that way.
Colour scales use the 2nd-98th percentile, because geostrophic currents blow up near the
equator and a single outlier would flatten the whole colorbar.

**Open question for INCOIS:** current speed from `sqrt(GEO_U² + GEO_V²)` ranges from 1.77 to
508. That's impossible in cm/s (5 m/s) but reasonable in mm/s. It is labelled cm/s and marked
as inferred until this is confirmed.

### Not built yet

OGC WMS/WCS endpoints, isosurface extraction as a backend service, and Docker Compose
packaging.

---

## Layout

```
backend/app/
  ingestion/     DataSource interface + one reader per upstream (ERDDAP grid, Argo, map, CMEMS, ETOPO)
  routers/       catalog, field, instruments (+ /compare), terrain, map, chunk, assistant
  assistant/     Gemini client, tool definitions, data reads, prompt, conversation store
  erddap_client  all ERDDAP requests go through here
  cache.py       disk cache
frontend/src/
  map/           2D map view (own canvas)
  viz/           Three.js globe, colormaps, depth axis; viz/chunk/ is the chunk view renderer
  components/    panels, depth ruler, colorbar, timeline, profile panel
  assistant/     assistant panel and the code that applies its actions
  styles/        tokens.css (design tokens) + one stylesheet per surface
```

To add a new sensor (ADCP, HF radar, moorings), implement the protocol in
`backend/app/ingestion/base.py`. Everything is converted to one of two shapes, a gridded field
or a point profile, before it reaches a router, so the frontend never needs to know what
format the data came in.
