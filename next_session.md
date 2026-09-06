# Session handoff — INCOIS 3D Ocean Data Visualization

**SIH 2026 · Problem statement 26067 · MoES / INCOIS · Disaster Management theme**
Written 2026-09-01. Updated the same day, at the end of the globe session.

> Read this first, then `context.md` (problem statement, data model, locked design system)
> and `CLAUDE.md` (frontend working rules). Those two are canon; this file is the status
> report and the list of traps.

---

## 0. Start here — state as of 2026-09-06

**`main` is pushed and clean** (`origin/main` = `7700f6a`, the globe merge). Two further
commits landed on `main` after it — the hint-box removal and the map longitude clamp — and
**the AI assistant is on an unpushed branch, `feature/ai-assistant` (3 commits).**

Suite green: **52/52 backend, 28/28 frontend**, typecheck clean, build clean, zero console
errors.

**Run it:** backend `uvicorn app.main:app --port 8000`, frontend `npm run dev` → :5173.
`npm install` and `pip install -r requirements.txt` first if pulling fresh — `lucide-react`
and `google-genai` are new.

**The assistant needs a key.** `GEMINI_API_KEY` in `backend/.env` (gitignored; see
`.env.example`). Without one the dock button states the reason and everything else works.
Free-tier generation is **20 requests/minute per model** and one answer costs two.

### What to work on next, in the order I would do it

0. **Finish two assistant checks — one minute, do it first.** Ask it "who was Alan Turing"
   (a general-knowledge question) and "what is the sea surface temperature at 15 N, 88 E"
   (an ocean one, which must still render a citation). Both are unverified only because the
   per-minute quota ran out mid-testing; everything else in the feature was confirmed live.

1. **Decide on Google Search billing.** Grounding is wired and inert on a free key
   (`context.md` §10, 2026-09-06). Enable billing on the Google Cloud project and the
   assistant answers live questions with cited sources; leave it and it declines honestly.
   One decision, no code either way.

2. **Merge or PR `feature/ai-assistant`.** It touches `App.tsx`, `app.css`, `ToolDock.tsx`
   and `VariablePanel.tsx` — four of the five files `CONTRIBUTING.md` names as real
   collision points. The longer it sits unmerged the worse that gets, so land it before
   anyone else starts frontend work.

3. **Look at it on a real GPU.** Still the oldest open item and still the single largest
   unknown. Every visual decision — water fog, the globe's shadow lift, the submerged
   camera, streamline density — was tuned against SwiftShader at 1-4 fps. The map's CPU
   raster path is immune; the 3D column is not.

4. **Resolve the two-palette split (§11, §5.1.2).** The 3D viewport uses the six named
   tokens; the floating console uses slate+cyan that `tokens.css` does not define, and two
   of those colours duplicate roles the tokens already fill. The assistant panel followed
   the console, so the inconsistency is now larger, not smaller. Biggest design debt.

5. **Bounding-box refetch on the map at high zoom.** The map always fetches globally at a
   stride, so zooming in shows ~0.4° cells under a 50 m coastline. `derive_stride` already
   takes a bbox; the work is refetching on zoom-settle without giving up "pan never
   refetches". Most visible quality win available.

4. **Pre-warm the demo dates.** Copernicus is ~12 s cold and 0.03 s cached. Before the pitch,
   walk the dates you will actually show so every one is warm. A short script against
   `/api/map/slice/meta` is enough.

5. **Wire the tool dock's remaining buttons or remove them.** Points, Areas and the 2D toggle
   are live. Lines and Import are not, and a dead control is worse than an absent one.

6. **Confirm current-speed units with INCOIS** (§11) — unchanged, and still needed before the
   pitch. Copernicus now gives a cross-check: it publishes u/v in m/s over the same box.

7. **§9 acronyms and dataset-links tables** from the PS PDF. Needed for the report, not the
   build.

### Traps added today

- **`enterColumn()` early-returns when the scene is already in "column".** The scene does not
  know the map exists, so its view never leaves "column" while the map is up; diving from the
  map hit that guard and left the view toggle permanently disabled. `App.handleView` routes to
  `startEntry()` unless the scene is genuinely on the globe. **Test a full Map → Column →
  Globe → Map round trip after touching view switching**, never one hop.
- **A layer is a variable, not a dataset.** `map_dataset_for()` resolves one to a source per
  view. If you add an upstream, give it a `variable_key` or it will never appear in the panel.
- **A truncated time axis is a display sample, not the real steps.** Snapping to it invents an
  offset on a product that has a step for every day.
- **`*.pfeg.noaa.gov` is dead.** NOAA retired it. Terrain now comes from NCEI's ArcGIS
  ImageServer as a tiled Float32 GeoTIFF.
- **Latitude direction differs per server** — VIIRS descends, HYCOM ascends. Both normalised at
  the boundary and asserted in tests; getting it wrong is a plausible-looking upside-down ocean.

---

## 1. Where things stand

**The app is built and working end to end on live INCOIS data.** Backend and frontend both
run, the demo narrative is real and verified, and the full verification suite passes.

The work so far, in five phases:
1. Research + full-stack build (backend, API, React/Three.js console, profile comparison).
2. A visual rebuild after feedback that the 3D view "looked like a chunk floating in space" —
   added sky, sea surface, ETOPO seafloor, and water optics.
3. A globe rebuild after feedback that the entry globe "does not look like the Earth" —
   added real coastlines, filled continents, terminator.
4. **The globe session.** Given four NASA SVS "Perpetual Ocean" reference frames, replaced
   that globe with real NASA Blue Marble imagery and made the globe a view you can return
   to, via a header toggle and by clicking the analysis extent on the sphere.
5. **The GIS Panels, Catalogue, Right-Hand HUD & Depth Slider session (`sidePannel` branch).**
   - Built the multi-layer GIS stack manager in `VariablePanel.tsx` governed by the uppermost
     active layer rule (revealing sub-layers when upper eyes toggle off, clearing volume when 0 layers).
   - Created `DataCatalogueModal.tsx` focusing on Physical Variables and Cyclone hazards with 1-click add-to-map.
   - Introduced `ToolDock.tsx` on the right side for in-situ float point inspection with 1-click graph overlays.
   - Redesigned `DepthRuler.tsx` into a modern vertical pill slider (`depth-ruler.css`) calibrated to INCOIS
     ERDDAP's 24 vertical depth levels with oceanographic zone callouts and non-conflicting lateral layout.

Phase 4 **deliberately reversed two locked decisions** — "the globe is a graticule, not a
textured Earth" and "the globe is never a destination". Both reversals, and the parts of
them that survive, are recorded in `context.md` §10 and §5.1 Principle 7. Do not treat the
current globe as drift: it was asked for, and the risks the old decisions named are paid
down rather than ignored.

Streamlines (the white current ribbons that are the actual subject of the NASA reference)
were explicitly deferred, not rejected — see §8.

Nothing is committed. `git init` was run and ~100 files are staged, but **there are zero
commits**. Committing is the user's call; they have not asked for it.

---

## 1b. The 2D map view (added 2026-09-05)

A third view, reached from the header toggle, and **now the landing view**. It is a global
equirectangular ocean map modelled on Copernicus MyOcean Pro and NASA Worldview.

**It has its own canvas and never touches `viz/scene.ts`.** The 3D camera rig, the entry
gesture and the bloom composer are untouched by this work — that was the point of giving it
a separate renderer.

**New global upstreams** (all public, no key, reached through the existing ERDDAP client):
- `hawaii_soest_6a0a_5127_d118` @ APDRC — HYCOM GLBv0.08. Global 0.08°, **40 depth levels to
  5000 m**, daily 1994–2015, `water_temp` / `salinity` / `water_u` / `water_v`. One dataset
  drives the field, the depth slider, the profile, the depth-time section and the streamlines.
- `noaacwNPPVIIRSSQchlaDaily` @ `coastwatch.noaa.gov` — global 4 km chlorophyll, 2012→present.

**What is built:** up to three stacked layers with per-layer visibility, opacity, log scale
and inline colorbar; a free timeline over the union of layer coverage with one tick row per
layer; a discrete-stop depth ruler; a point tool with four readouts from one request; an area
tool that rebuilds the 3D column around a dragged box; animated streamlines.

**New files:** `frontend/src/map/` (projection, raster, streamlines, state, MapView,
LayerStack, MapDepthRuler, MapTimeline, PointReadout, map.test.ts),
`backend/app/ingestion/erddap_map.py`, `backend/app/routers/map.py`, `backend/app/scaling.py`,
`backend/tests/test_map.py`, `shot-map.mjs`.

**Frontend now has tests.** `vitest` is a devDependency and `npm test` runs 18 of them over
`projection.ts`, `raster.ts` and the colour encoding. There were none before.

### Traps found while building this — read before touching the map

1. **`*.pfeg.noaa.gov` is dead.** NOAA retired the PFEG ERDDAP. `TERRAIN_BASE` pointed at it,
   so terrain was loading only from the disk cache and a fresh clone would have lost the
   seafloor silently. Now NCEI's ArcGIS ImageServer, decoded as a tiled Float32 GeoTIFF with
   struct + numpy (no new dependency). Arbitrary boxes work now; the old one could not.
2. **The value→colour mapping was duplicated** in `viz/volume.ts` and `Colorbar.tsx`. It is now
   `encodeRange`/`lutIndex` in `viz/colormaps.ts`. **Do not write a third copy** — that is how
   the same value becomes two colours in two views.
3. **Latitude direction differs per server.** VIIRS stores it descending, HYCOM ascending. A
   griddap range written in the wrong direction returns 404, and a raster written in the wrong
   direction is a plausible-looking upside-down ocean. Both are normalised at the boundary and
   both are asserted in tests.
4. **`imageSmoothingEnabled = false` is load-bearing**, not a style choice. Bilinear scaling
   interpolates between LUT entries and invents colours outside the cmocean ramp.
5. **`:nth-child` on the timeline rows counted the year labels too.** Row offsets are inline now.
6. **The provenance chip had "INCOIS ERDDAP" hardcoded**, so a HYCOM layer was credited to
   INCOIS. It reads the active layer's provider now.
7. **`enterColumn()` early-returns when the scene is already in "column".** The scene has no
   idea the map exists, so its own view never leaves "column" while the map is up — diving
   from the map hit that guard, never fired `onEntryComplete`, and left the view toggle
   disabled for good. `App.handleView` routes to `startEntry()` (the same descent, no guard)
   unless the scene is genuinely on the globe. **Verify a Map → Column → Globe → Map round
   trip after touching view switching**, not just one hop.
8. The point block is expensive in its TIME extent, not its depth extent: 40 levels × 31 days
   is 5–9 s cold, 40 × 60 was ~50 s. Keep the window near a month.

## 1c. The AI assistant (added 2026-09-06, branch `feature/ai-assistant`)

A Gemini-backed assistant, first icon in the right dock ("Ask"), opening a 420 px floating
panel. It answers questions about the water from real data, answers general questions from
its own knowledge, and **drives the app** — "add the chlorophyll layer and hide temperature"
applies as two state changes with one-click undo.

```
backend/app/assistant/   gemini_client.py (the only place that talks to Gemini)
                         tools.py (declarations + action validation)
                         reads.py (read tools, each returning provenance)
                         prompt.py · store.py (SQLite behind a protocol)
backend/app/routers/assistant.py    SSE: status → answer → done
frontend/src/assistant/  AssistantPanel.tsx · useAssistant.ts · actions.ts
```

**How grounding is enforced, and why it is not just prompt wording.** Read tools return
values *with* provenance; the panel builds its citation line from the calls that actually
ran, never from the prose. An answer that fetched nothing has nothing to cite and shows
"General knowledge — not from your data". Web sources (when search is enabled) are marked
`kind="web"` and styled apart, because a page Google returned is not the ocean analysis.

**The tool loop is split.** Read tools run on the backend. Action tools cannot — they mutate
React state — so they are validated server-side against a state snapshot the client sends
with every message, then returned for the client to apply. That is what lets the model be
told the truth ("that would need more than 3 layers") instead of assuming success.

### Traps, in the same spirit as §6

1. **Writing a layer from outside has TWO wrong seams and both fail silently.**
   `dispatchMap({type:"layer/add"})` is overwritten by the `layers/sync` effect. And
   `setLayerStack` alone changes nothing on screen: **`VariablePanel` owns the stack in its
   own `useState`** and only mirrors it up, so `App.tsx`'s `layerStack` is downstream, not
   the source. The working seam sets the mirror *and* hands the panel a stack via the
   `externalStack` prop, whose **nonce** marks a fresh instruction — a nonce rather than
   value equality, so undoing back to a stack you were already in still applies. Both
   failures look identical from outside: the assistant cheerfully reports a change that
   did not happen. This cost a full debugging cycle; do not rediscover it.

2. **Free-tier quota is per model, and the newest model is the exhausted one.**
   `gemini-3.8-flash` returned 429 (20/min) while `gemini-3.5-flash` answered the identical
   request immediately. Default is 3.5-flash; `GEMINI_MODEL` overrides.

3. **Every tool-calling round is one request.** Two rounds is the floor (one call, one
   summary). The screen state and the variable catalogue are inlined into the system prompt
   precisely so the model does not spend a round asking for them — that change took a layer
   command from three rounds to two. Adding a chatty tool costs quota on every question.

4. **Google Search grounding is not in the free tier.** Every request carrying the tool
   429s with "check your plan and billing details"; the identical request without it
   succeeds. The client strips it and retries, then remembers — so a missing grounding
   quota degrades one feature instead of taking down every question.

5. **The Gemini API is not the one you remember.** It is
   `client.interactions.create(...)` → `Interaction` with `steps`/`output_text`, a
   `function_call` step answered by a `function_result` entry. Not `generate_content`.
   Verified against `google-genai` 2.22 and the live docs; do not "fix" it back.

## 2. Running it

Two processes. Backend first — the browser cannot reach ERDDAP directly (no CORS headers),
so nothing renders without it.

```bash
# Backend  →  http://127.0.0.1:8000   (docs at /docs)
cd backend
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Frontend →  http://localhost:5173
cd frontend
npm run dev
```

Both were running at the end of the session. Vite proxies `/api` to port 8000.

**On a fresh clone, fetch the globe basemaps first** — they are committed, so this is only
needed if `frontend/public/*.jpg` is missing:

```bash
cd frontend && node scripts/fetch-textures.mjs
```

Without them the globe still renders, as a plain dark sphere; the app does not break.

> **Gotcha:** starting Vite from a backgrounded shell died repeatedly (exit 127) part-way
> through this session, which produced a *blank* page and a null canvas that looked exactly
> like a rendering bug. If the app suddenly stops loading, check the server is still
> listening before debugging the 3D. Launching it detached
> (`Start-Process cmd "/c npx vite ..."` on Windows) held fine.

Environment already provisioned: Python 3.14.0 venv at `backend/.venv` (numpy 2.5.2,
pandas 3.0.5, xarray 2026.7.0, netCDF4 1.7.4, fastapi 0.141.1, pytest 9.1.1); Node 24.11.0
with React 19.2.8, three 0.185.1, Vite 8.2.2, TypeScript 7.0.2, puppeteer.

---

## 3. Data sources — all verified live, nothing synthesized

**INCOIS runs a public ERDDAP server** at `https://erddap.incois.gov.in/erddap`. This was the
pivotal discovery of the session: the demo runs on the problem-statement organisation's own
data. It resolved four of the five open questions in `context.md` §11.

| Dataset | Shape | Used for |
|---|---|---|
| `incois_argo_10d_VAM` | time(813) × ZAX(24: 5–2000 m) × lat(60) × lon(90); TEMP, SAL, TERR, SERR; CF-1.6; 2004 → Jul 2026 | The 3D volume |
| `Indian_ARGO_Floats` | tabledap; PRES/TEMP/PSAL + `_ADJUSTED` + QC flags; 2002 → Apr 2025 | In-situ profiles |
| `incois_valueadded_products_datasets` | GEO_U, GEO_V, MLD, ILD, D26, D20, HTCNT, DYN_HT; **2004 → Mar 2019 only** | Currents + hazard layers |
| `incois_oceansat2_datasets` | CHL mg/m³; 2011 → 2020 | Chlorophyll (cloud-gapped) |
| `etopo180` @ NOAA CoastWatch | 1 arc-minute global relief, `altitude` in m | Seafloor + land |

**Performance is a solved problem.** A full 3D volume for one timestep is **1.0 MB as NetCDF
in ~570 ms**, ~259 KB per variable as `Float32Array`. No Zarr, no tiling.

Committed fixtures live in `data/` (~3 MB), regenerable with
`cd backend && .venv/Scripts/python snapshot_fixtures.py`.

**The globe basemap is not in this list, on purpose.** NASA Blue Marble
(`frontend/public/*.jpg`, ~3.2 MB) is a *basemap asset*, not a data source: it is a static
2004 photograph that encodes nothing and is credited in the UI. Everything in the table
above is measurement; the sphere is scenery. §5.1 Principle 7 draws that line, and the
globe-mode caption states it to the reader.

---

## 4. The demo narrative — and the trap in it

**Cyclone Phailin, October 2013.** Landfall near Gopalpur on 12 Oct; INCOIS/IMD's landmark
forecast, over a million evacuated. It is the only window where the 3D grid, the in-situ
floats, and the hazard fields all overlap (the value-added products stop in March 2019).

Scenario box: **5–23°N, 78–95°E**, 1–25 October 2013. Defined in `backend/app/config.py`
as `PHAILIN`.

**Featured floats:**
- `2901335` — near-hourly profiling at ~15.9°N, 88.8°E, directly under the track. SST falls
  from **28.96 °C on 10 Oct to 26.38 °C on 11 Oct** (a −2.6 °C cold wake) and recovers to
  29.14 °C by 20 Oct.
- `2901327` — corroborates it in the subsurface: 100 m cooled 23.72 → 20.27 °C.

> ### ⚠️ The trap: float `2900757`
> It *looks* like a dramatic −4.03 °C cold wake and is very tempting. It is **unusable**:
> 2 rows per cycle, all at 0 db, `TEMP_QC=4`, salinity 0.014 PSU. A broken instrument, not an
> ocean signal. `tests/test_ingestion.py::test_bad_qc_float_is_rejected_entirely` fails if it
> ever produces a profile again. **Do not put it in the pitch.**

This is why QC filtering is a correctness requirement: only flags 1 and 2 are accepted,
`*_ADJUSTED` values are preferred, and the count of rejected levels is surfaced in Ops mode
(currently 1,532 for the Phailin window).

---

## 5. What is built

**Backend** (`backend/app/`) — deliberately thin: a translator, not a platform.
- `ingestion/base.py` — the `DataSource` protocol. The PS's extensibility claim lives here.
- `ingestion/erddap_grid.py` — griddap `.nc` → xarray → volumes/surfaces; `fetch_vector_magnitude` for current speed.
- `ingestion/erddap_argo.py` — tabledap → pandas; QC filtering; **decibar → metre conversion (UNESCO/Fofonoff-Millard, latitude-dependent)**.
- `ingestion/etopo_terrain.py` — a *second, different upstream* on the same interface, which is what makes the extensibility claim demonstrable rather than asserted.
- `erddap_client.py` — the only place that talks upstream. Contains the TLS workaround and the URL encoder.
- `cache.py` — disk cache; fresh → network → stale, with provenance recorded.
- `routers/` — `catalog`, `field` (binary volumes), `instruments` (+ `/compare`), `terrain`.

**Frontend** (`frontend/src/`)
- `viz/geo.ts` — **the shared coordinate frame. Read this before touching the 3D.**
- `viz/depth.ts` — the depth axis (power 0.65), shared by ruler, volume and charts.
- `viz/volume.ts` — raymarched 3D texture of the analysis.
- `viz/terrain.ts` — ETOPO relief mesh, smoothed, with photic-zone fade.
- `viz/ocean.ts` — sky, sea surface, marine snow, light shafts.
- `viz/globe.ts` — the Earth: NASA Blue Marble basemap, analysis outline, float markers.
- `viz/water.ts` — shared water optics GLSL.
- `viz/effects.ts` — selective bloom.
- `viz/scene.ts` — composition, camera, entry gesture, view switching, markers, raycasting.
- `scripts/fetch-textures.mjs` — downloads and resamples the two Blue Marble basemaps.
- `components/` — DepthRuler, Colorbar, Timeline, VariablePanel, FloatList, ProfilePanel.
- `styles/tokens.css` — the design system, downstream of `context.md` §5.1.

**Two views, one scene.** `scene.ts` keeps `globeGroup` and `worldGroup` as separate
top-level groups and flips visibility between them; `enterGlobe()` / `enterColumn()` are
the public form of the transition the entry gesture already used.
- The app still **opens by diving** — the globe is never the default view.
- Returning to the globe is instant; diving back replays the 4.6 s descent. Under
  `prefers-reduced-motion` both directions cut instantly.
- Globe mode unmounts the side panels (a depth ruler describes a water column, and there
  isn't one) but keeps the timeline.
- **The globe never rotates on its own.** In globe mode the *camera* orbits and the Earth
  stays put — which also keeps the terminator anchored to real geography, since the sun
  direction lives in the sphere's object space.
- Clicking the analysis extent dives in. Picking raycasts the *sphere* and tests the
  resulting lat/lon against the extent, rather than raycasting the outline — a `LineLoop`
  is a nearly un-hittable target.
- Basemap month is per-scenario (`basemap` in `backend/app/config.py`). Phailin uses
  **October**, which is seasonally honest for Oct 2013. Note the supplied reference frames
  are the **December** texture — if the demo should match them exactly, that is a one-line
  change and both months are already committed.

**The signature feature** is `/api/compare` + `ProfilePanel`: a float's measured curve against
the INCOIS analysis on one depth axis, with the residual on its own scale. For `2901327` it
reports mean −0.10 °C but **−1.21 °C at 76 m** — the 1° analysis smooths out a thermocline the
float actually measured. That is the demo's money shot.

---

## 6. Hard-won lessons — read before touching the 3D scene

These cost most of the session. They are also in `context.md` §10.

**1. The data column and the seafloor cannot share a vertical axis.** This took four rebuilds.
The analysis needs heavy exaggeration to read as a water column; the seafloor needs almost
none to read as a basin. On one axis the continental slope — 2 km over 60 km — renders as a
sheer wall, and it sits at 0–700 m, *inside the visible band*, so fading the abyss below does
not help. Smoothing did not help. Clamping made it worse (a flat floor with a hard rim, which
is itself a wall). **Current resolution:** analysis on a power curve at ~425×; seafloor on its
own *linear* axis (`SEAFLOOR_HEIGHT`); seafloor dissolves out below ~250 m because that is
where light stops.

**2. Black is not invisible.** Absorption alone turns distant seafloor black, which reads as a
silhouette against lit water. Distant things must fade *into* the water colour.

**3. Never tone-map the frame.** ACES filmic looked better on water but remaps every colour
including the data volume's, shifting perceived temperatures away from the colorbar.
`renderer.toneMapping = NoToneMapping` is deliberate.

**4. Bloom is layer-selective by construction**, not by threshold. Only `BLOOM_LAYER` objects
(markers, sun glint) are in the bloom render at all. A brightness threshold would have failed
silently the first time someone picked a warm palette.

  *Corollary, found on the globe:* the bloom pass sets the camera to that layer **alone**, so
  anything not on it is culled and cannot occlude. Put the globe's outline or float markers on
  `BLOOM_LAYER` and they glow straight *through* the Earth when the Bay of Bengal is on the far
  side. They are deliberately off it, so ordinary depth testing against the opaque sphere hides
  them. Don't "fix" the missing glow.

**5. The volume geometry must be a UNIT cube scaled to aspect.** The raymarch shader
intersects `[-0.5, 0.5]` in object space; a pre-sized `BoxGeometry` silently clips most of the
field. This bug shipped once and looked plausible.

**6. ERDDAP queries must be percent-encoded.** Its syntax uses RFC 3986 reserved characters
(`[` `]` for griddap, `<` `>` `"` for tabledap) and Tomcat rejects them raw with a bare 400.

**7. Globe textures must be power-of-two.** NASA publishes Blue Marble at 5400×2700, which
is NPOT. With mipmaps on, mip generation corrupted the GL context badly enough that three
unrelated materials failed `VALIDATE_STATUS` and the canvas rendered *nothing* — and the
console error named a `LineBasicMaterial`, pointing nowhere near the cause. Resampled to
4096×2048. Turning mipmaps off also clears it but is wrong: 6:1 minification without mips
aliases badly on real hardware. **Keep any replacement texture power-of-two.**

**8. `vertexColors` breaks InstancedMesh colouring.** Use `instanceColor` with a white
material; `vertexColors: true` makes the shader look for a geometry attribute that isn't
there and every instance renders black.

**9. Markers live in their own group.** `clearVolume()` used to wipe them, and React never
rebuilt them because its dependencies hadn't changed — floats silently vanished whenever the
field reloaded after the instruments.

**10. The globe basemap is graded; the frame still is not.** Blue Marble's deep ocean sits at
3–12% luminance and read as a black hole with a coastline around it, so the globe shader
applies a gamma shadow-lift (≈1.5). This is **not** a violation of lesson 3: that forbids a
*renderer-wide* curve because it would also remap the data volume. This one lives in a single
shader, on a basemap that by §5.1 Principle 7 encodes nothing. Keep the distinction — a future
session tempted to "fix the inconsistency" would either flatten the globe or corrupt the data.

---

## 7. Verification

```bash
cd backend && .venv/Scripts/python -m pytest tests -v     # 11 integration tests, live data
cd frontend && npx tsc --noEmit && npm run build          # both clean
node screenshot.mjs <label>    # full pass: interactions, reduced-motion, mobile
node shot.mjs <label> --skip   # fast single frame, for iterating on the look
node shot.mjs <label> --globe        # captures the entry globe
node shot.mjs <label> --globe-mode  # captures globe mode, reached via the header toggle
```

All passing as of session end: 11/11 backend tests, clean typecheck and build, zero console
errors, no horizontal overflow at 414 px, `prefers-reduced-motion` suppresses the entry.

The globe session additionally verified, with a throwaway puppeteer script (not kept — rebuild
it if you touch view switching): panels unmount and remount across the toggle; the timeline
stays live in globe mode; **float count survives two full round trips** (15 → 15; see lesson 9
for why that is worth asserting); clicking inside the extent dives while clicking ocean outside
it does nothing; hover over the extent turns the cursor to a pointer; reduced motion cuts both
ways; the header toggle follows a scene-initiated change.

> **The screenshot harness runs on SwiftShader software rendering at 1–2 fps.** It is fine for
> composition and correctness but tells you **nothing** about real performance or about how
> subtle shading looks. Judge visuals on a real GPU.

Screenshots land in `temporary screenshots/`, auto-incremented, never overwritten (~150 so far).

---

## 8. Known issues and things not built

**Visual, unresolved:**
- Some dark silhouettes remain where coastal terrain is steepest.
- The scene is hazier than ideal; water fog constants in `viz/water.ts` are tuned by eye on a
  software renderer and likely want revisiting on a GPU.
- **Performance on real hardware is unmeasured.** The user chose fixed maximum quality with no
  fallback and declined a quality switch. If it is slow, the offer of a manual High/Reduced
  toggle stands. The globe basemap (4096×2048, ~45 MB on the GPU with mipmaps) is now the
  largest single asset the app loads.
- **The NPOT texture failure in lesson 7 may be harness-only.** It reproduces under
  SwiftShader; a real GPU may well tolerate 5400×2700. The 4096 resample was kept anyway
  because it is also the correct size for the display and costs no visible quality — but if
  someone claims the original works fine on their machine, they are probably right, and it
  still should not be reverted.
- The globe has no visible atmosphere rim at current settings (`uRim` is there but tight).
  The reference frames have a subtle one. Left alone rather than risking the generic glowing-
  planet look; revisit on a GPU if it reads flat.

**Not built (described as roadmap, not implemented):**
- **Current *direction* / streamlines.** Only speed is drawn. This is now the most obvious
  next feature: the NASA reference frames the globe was built from are *about* their flowing
  current ribbons, and the team deferred them only to get the globe itself done first. The
  honest version draws them **only inside the INCOIS box** where `GEO_U`/`GEO_V` actually
  exist — never globally on the sphere, which §5.1 Principle 7 forbids.
- OGC WMS/WCS endpoints (PS requirement #5).
- Isosurface extraction.
- Docker Compose packaging.

**Open question for INCOIS (in `context.md` §11):** the value-added product publishes **no
units**. D26, MLD and heat content are unambiguous from their ranges. **Current speed is not**:
`sqrt(GEO_U² + GEO_V²)` spans 1.77–508, impossible as cm/s (5 m/s) but reasonable as mm/s.
It is labelled cm/s and marked "units inferred" pending confirmation. Also note geostrophy
diverges as 1/f toward the equator, so the box's southern edge carries genuine artifacts —
which is why colour scales are percentile-clipped (2–98%).

**Still TODO from the original docs:** `context.md` §9 needs the official Acronyms and Dataset
Links tables from the PS PDF, which the text extraction dropped. Needed before the pitch.

---

## 9. Working agreement, in short

- `CLAUDE.md` and `context.md` must never drift apart. **Any new colour, shadow, type role or
  structural pattern goes into `context.md` §5.1 *before* it ships.** §5.1 now runs to seven
  principles and §10 to ~30 decision-log entries, including two that explicitly *reverse*
  earlier ones. Keep that up — and when reversing a decision, say so and say what survives,
  rather than quietly editing the old entry.
- Chrome uses the six tokens; data uses cmocean colormaps. They never mix.
- The viewport may be cinematic; the data may not. Every effect is anchored to a real
  phenomenon, and nothing post-processing does may shift a value.
- Invoke `frontend-design` each session before frontend work; extend the locked system rather
  than re-derive it.
- Verification is at least two screenshot passes with numeric deltas, not impressions.

---

## 10. Suggested next steps

See §0 for the ordered list — this is the longer tail.

1. **Finish the two assistant checks** (§0 item 0) and **decide Google Search billing**
   (§0 item 1). Both are minutes, and the second unlocks live answers for the demo.
2. **Land `feature/ai-assistant`** before anyone else touches the frontend — it sits on
   four of the five known collision files.
3. **Look at it on a real GPU** and decide whether the visual work is done. Still the one
   thing no session has been able to do. The globe especially — it was tuned against a
   software renderer at 2–4 fps.
4. Decide the basemap month: October (seasonally correct for the demo) or December (matches
   the supplied reference frames exactly). One line in `backend/app/config.py`; both months
   are already committed.
5. Confirm the current-speed units with INCOIS.
6. If pitching soon: fill in `context.md` §9, and rehearse the Phailin narrative — open on the
   globe, dive, select `2901335` for the cold wake, then `2901327` for the −1.21 °C residual.
   The globe toggle now gives a way back out for a second pass at the story. **The assistant
   is now a strong demo beat**: ask it to add a layer on stage, then ask it for a value and
   show the citation line — it makes the provenance argument visible in one gesture.
7. If building further: current direction as streamlines (see §8), then OGC endpoints, then
   Docker. Assistant follow-ups: token-streaming the prose (only status streams today), and
   conversation history in the panel (the store and endpoints exist; nothing reads them yet).
