# Ocean assistant — view-scoped, correct, fast: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant answers point questions from the source the view actually draws, acts only on the view on screen (including the chunk), and returns a typical answer in ~2–5 s.

**Architecture:** A server-authoritative per-view tool registry (`assistant/tools.py`) validated against a full three-view screen snapshot; view-aware reads that resolve a source by preference *and* coverage and read one native level; a Gemini loop on `gemini-3.5-flash-lite` with a model fallback chain, one-round commands and parallel budgeted reads. The browser routes each validated action by its `scope` to the map, the globe, or a `ChunkView` controller.

**Tech Stack:** FastAPI, xarray, httpx, google-genai 2.22 (Interactions API), copernicusmarine ARCO; React 19 + TypeScript + Vite; pytest; vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-assistant-view-scoped-design.md`

## Global Constraints

- Point values are the source's **native cell**, never a strided on-screen slice (user decision).
- Default model `gemini-3.5-flash-lite`, `thinking_level: "minimal"`; fallbacks `gemini-3.1-flash-lite`, `gemini-3.5-flash`; env `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_THINKING`.
- Every validated action carries `scope` (`"map" | "globe" | "chunk"`): the view it was validated against. `set_view`'s own target stays in `view`.
- Chunk layers are `scalar`, `currents`, `bathy` only (sea surface and instrument traces were removed upstream in 6718bc1 / 38db870). No `open_float`.
- Copy follows context.md §5.3: sentence case, active voice, name what is loading, no apology.
- No new colour, radius, shadow or type role. Readouts use IBM Plex Mono (`--rt-font-mono`).
- **No commits during execution.** The user asked for no commits until they say so. Each task ends at a green-test checkpoint. When commits happen they carry the human author only, never an AI co-author trailer (CLAUDE.md hard rule).
- Backend tests: `cd backend && .venv/Scripts/python -m pytest tests -q`. Frontend: `cd frontend && npx tsc --noEmit && npx vitest run`.

---

### Task 1: One resolver — preference and coverage

**Files:**
- Modify: `backend/app/config.py` (`map_dataset_for`, new `coverage_for`, assistant constants)
- Test: `backend/tests/test_assistant_resolve.py`

**Interfaces:**
- Produces: `map_dataset_for(variable_key: str, date: str | None = None) -> MapDataset | None`; `coverage_for(variable_key: str) -> list[tuple[str, str, str]]` (provider, start, end, most preferred first); constants `GEMINI_FALLBACK_MODELS: tuple[str, ...]`, `GEMINI_THINKING: str`, `GEMINI_TIMEOUT_SECONDS = 20.0`, `ASSISTANT_READ_BUDGET_SECONDS = 10.0`, `ASSISTANT_HISTORY_MESSAGES = 12`; `GEMINI_MODEL` default `"gemini-3.5-flash-lite"`.

- [ ] **Step 1: Write the failing test** — `backend/tests/test_assistant_resolve.py`:

```python
"""Which dataset answers a variable on a date — the root cause of "HYCOM unreachable".

The assistant took the FIRST dataset serving a variable. MAP_DATASETS is not in
preference order (Copernicus and INCOIS are appended after HYCOM and VIIRS), so
temperature went to HYCOM — which ends in 2015 — for a 2026 date the map was
drawing from Copernicus. These pin the resolver to preference AND coverage.
No network.
"""
import pytest

from app import config

BASE = tuple(d for d in config.MAP_DATASETS if d.protocol != "cmems")
WITH_CMEMS = BASE + config.CMEMS_DATASETS


def pick(key, date=None):
    ds = config.map_dataset_for(key, date)
    return ds.id if ds else None


@pytest.fixture
def cmems(monkeypatch):
    monkeypatch.setattr(config, "MAP_DATASETS", WITH_CMEMS)


@pytest.fixture
def no_cmems(monkeypatch):
    monkeypatch.setattr(config, "MAP_DATASETS", BASE)


def test_temperature_in_2026_is_the_copernicus_layer_the_map_draws(cmems):
    assert pick("temperature", "2026-06-23") == "cmems_temperature"


def test_temperature_in_2013_prefers_copernicus_when_configured(cmems):
    assert pick("temperature", "2013-10-12") == "cmems_temperature"


def test_temperature_in_2013_falls_back_to_hycom_without_copernicus(no_cmems):
    assert pick("temperature", "2013-10-12") == "hycom_temperature"


def test_a_date_no_source_covers_resolves_to_nothing(no_cmems):
    assert pick("temperature", "2026-06-23") is None


def test_chlorophyll_in_2013_is_incois_not_viirs(cmems):
    assert pick("chlorophyll", "2013-10-12") == "incois_chlorophyll"


def test_chlorophyll_inside_the_viirs_window_uses_viirs(cmems):
    assert pick("chlorophyll", "2026-01-15") == "viirs_chlorophyll"


def test_no_date_keeps_the_old_behaviour_most_preferred(cmems):
    assert pick("temperature") == "cmems_temperature"


def test_coverage_lists_sources_most_preferred_first(cmems):
    spans = config.coverage_for("temperature")
    assert spans[0][0] == "Copernicus Marine GLORYS12V1"
    assert ("HYCOM GLBv0.08", "1994-01-01", "2015-12-30") in spans
```

- [ ] **Step 2: Run it and expect FAIL.** Run `cd backend && .venv/Scripts/python -m pytest tests/test_assistant_resolve.py -q`. Expected: `TypeError: map_dataset_for() takes 1 positional argument but 2 were given`.

- [ ] **Step 3: Implement.** In `config.py`, replace `map_dataset_for` and add `coverage_for`:

```python
def map_dataset_for(variable_key: str, date: str | None = None) -> MapDataset | None:
    """The best source for a variable, or None if nothing serves it.

    Lowest `preference` wins. With `date`, only sources whose stated coverage
    includes that day are considered: the assistant asking HYCOM (1994-2015)
    for a 2026 date is how "HYCOM is unreachable" reached a reader (2026-09-10).
    """
    candidates = [d for d in MAP_DATASETS if d.variable_key == variable_key]
    if date:
        day = date[:10]
        candidates = [
            d for d in candidates if d.time_range[0][:10] <= day <= d.time_range[1][:10]
        ]
    return min(candidates, key=lambda d: d.preference) if candidates else None


def coverage_for(variable_key: str) -> list[tuple[str, str, str]]:
    """(provider, start, end) for every source of a variable, most preferred first."""
    ranked = sorted(
        (d for d in MAP_DATASETS if d.variable_key == variable_key), key=lambda d: d.preference
    )
    return [(d.provider, d.time_range[0][:10], d.time_range[1][:10]) for d in ranked]
```

Replace the `GEMINI_MODEL` block (its comment and the line itself) with:

```python
# gemini-3.5-flash-lite at minimal thinking: measured 1.86 s per round against
# 8-13 s for gemini-3.5-flash on the same prompt and tools (2026-09-10), choosing
# the same tool call. Every answer costs at least one round and most cost two,
# so this is the difference between a 3 s answer and a 20 s one.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Tried in order when the model above is rate limited or times out. Free-tier
# quota is per model, so the next model is a fresh quota, not a retry.
GEMINI_FALLBACK_MODELS: tuple[str, ...] = tuple(
    m.strip()
    for m in os.environ.get(
        "GEMINI_FALLBACK_MODELS", "gemini-3.1-flash-lite,gemini-3.5-flash"
    ).split(",")
    if m.strip()
)
# "minimal" | "low" | "medium" | "high", or "" for the model's own default.
GEMINI_THINKING = os.environ.get("GEMINI_THINKING", "minimal").strip().lower()
# A request past this is abandoned for the next model rather than waited on.
GEMINI_TIMEOUT_SECONDS = 20.0
```

After `ASSISTANT_MAX_STEPS`, add:

```python
# A read past this budget is reported to the model as still loading. The fetch
# finishes in the background and lands in the analysis cache for the next ask.
ASSISTANT_READ_BUDGET_SECONDS = 10.0
# Conversation turns resent to the model. Older ones cost latency on every
# request and rarely change the answer.
ASSISTANT_HISTORY_MESSAGES = 12
```

- [ ] **Step 4: Run it and expect PASS** (8 passed). Then run the full backend suite to confirm it stays green.

---

### Task 2: A refused request is not an unreachable server

**Files:**
- Modify: `backend/app/erddap_client.py`, `backend/app/routers/map.py` (`_guard`), `backend/app/routers/chunk.py` (`_guard`)
- Test: `backend/tests/test_upstream_errors.py`

**Interfaces:**
- Produces: `class UpstreamRefused(UpstreamUnavailable)` with `.host: str` and `.status: int`, message `"{host} refused this request (HTTP {status})."`.

- [ ] **Step 1: Write the failing test** — `backend/tests/test_upstream_errors.py`:

```python
"""An HTTP error from an upstream says "refused", not "unreachable".

APDRC answered HTTP 500 for a date outside HYCOM's coverage, and every HTTP
error used to surface as "did not answer ... not cached" — sending a reader to
check the network when the query itself was the problem. No network.
"""
import httpx
import pytest
from fastapi import HTTPException

from app import erddap_client
from app.config import MAP_DATASETS_BY_ID
from app.erddap_client import UpstreamRefused, UpstreamUnavailable
from app.routers import map as map_router

URL = "https://apdrc.soest.hawaii.edu/erddap/griddap/x.nc?water_temp"


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_http_500_is_refused_and_names_the_status(monkeypatch):
    monkeypatch.setattr(erddap_client, "_strict_client", _client(lambda r: httpx.Response(500)))
    with pytest.raises(UpstreamRefused) as e:
        erddap_client.fetch(URL, allow_cache=False)
    assert e.value.status == 500
    assert "apdrc.soest.hawaii.edu" in str(e.value) and "HTTP 500" in str(e.value)
    assert isinstance(e.value, UpstreamUnavailable), "existing handlers must still catch it"


def test_a_connection_failure_is_still_unreachable(monkeypatch):
    def boom(request):
        raise httpx.ConnectError("no route", request=request)

    monkeypatch.setattr(erddap_client, "_strict_client", _client(boom))
    with pytest.raises(UpstreamUnavailable) as e:
        erddap_client.fetch(URL, allow_cache=False)
    assert not isinstance(e.value, UpstreamRefused)
    assert "did not answer" in str(e.value)


def test_the_map_router_reports_a_refusal_as_one():
    ds = MAP_DATASETS_BY_ID["hycom_temperature"]

    def refuse():
        raise UpstreamRefused("apdrc.soest.hawaii.edu", 500)

    with pytest.raises(HTTPException) as e:
        map_router._guard(ds, refuse)
    assert e.value.status_code == 502
    assert "refused" in e.value.detail and "unreachable" not in e.value.detail
```

- [ ] **Step 2: Run it and expect FAIL.** Expected: `ImportError: cannot import name 'UpstreamRefused'`.

- [ ] **Step 3: Implement.** In `erddap_client.py`, after `UpstreamUnavailable`:

```python
class UpstreamRefused(UpstreamUnavailable):
    """The upstream answered, with an error status, for this request.

    Split from "unreachable" because the two send a reader to different places:
    a refused request usually means the query is outside what the dataset holds
    (a date past its end, a depth range APDRC chokes on), not that the network is
    down. Subclassing keeps every existing `except UpstreamUnavailable` working.
    """

    def __init__(self, host: str, status: int) -> None:
        super().__init__(f"{host} refused this request (HTTP {status}).")
        self.host = host
        self.status = status
```

In `fetch()`, replace the final `raise UpstreamUnavailable(...) from exc` with:

```python
        if isinstance(exc, httpx.HTTPStatusError):
            raise UpstreamRefused(_host(url), exc.response.status_code) from exc
        raise UpstreamUnavailable(
            f"{_host(url)} did not answer this request and it has not been cached."
        ) from exc
```

In `routers/map.py` and `routers/chunk.py`, import `UpstreamRefused` alongside `UpstreamUnavailable`, and add this as the **first** `except` in `_guard`:

```python
    except UpstreamRefused as exc:
        raise HTTPException(
            502,
            f"{ds.provider} refused this request (HTTP {exc.status}). The date or "
            "area may be outside what it serves — try another.",
        ) from exc
```

- [ ] **Step 4: Run it and expect PASS** (3 passed). The full backend suite stays green.

---

### Task 3: One native level at one point

**Files:**
- Modify: `backend/app/ingestion/erddap_map.py`, `backend/app/ingestion/cmems.py`, `backend/app/main.py`
- Test: `backend/tests/test_point_value.py`

**Interfaces:**
- Produces: `erddap_map.PointValue(value: float | None, lat, lon, depth: float | None, time: str, units: str, source: SourceStatus, direction_deg: float | None)`; `erddap_map.speed_direction(u, v) -> tuple[float | None, float | None]` (speed, bearing the water moves towards); `erddap_map.fetch_point_value(*, ds, lat, lon, time, depth=None) -> PointValue`; `cmems.fetch_point_value(...)` with the same signature; `cmems.warm_in_background(datasets) -> threading.Thread | None`.

- [ ] **Step 1: Write the failing test** — `backend/tests/test_point_value.py`:

```python
"""One value at one cell and one level — the assistant's readout.

The old path read the map panel's 40-level x month block to answer one number.
Live HYCOM for the Phailin date; Copernicus only when credentials exist.
"""
import pytest

from app.config import COPERNICUS_AVAILABLE, CMEMS_DATASETS, MAP_DATASETS_BY_ID
from app.ingestion import erddap_map
from app.ingestion.erddap_map import speed_direction


def test_speed_and_bearing_from_u_and_v():
    assert speed_direction(0.0, 1.0) == (1.0, 0.0)  # due north
    speed, bearing = speed_direction(1.0, 0.0)
    assert speed == 1.0 and bearing == 90.0  # due east
    assert speed_direction(0.3, 0.4)[0] == pytest.approx(0.5)
    assert speed_direction(None, 1.0) == (None, None)


def test_hycom_surface_value_matches_the_panel_block():
    ds = MAP_DATASETS_BY_ID["hycom_temperature"]
    pv = erddap_map.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2013-10-12")
    # 27.79 °C is what the 40-level block's surface row reads for this cell.
    assert pv.value == pytest.approx(27.79, abs=0.05)
    assert abs(pv.lat - 15.0) < 0.1 and abs(pv.lon - 88.0) < 0.1
    assert pv.depth == 0.0


def test_hycom_currents_are_speed_and_direction_not_u_alone():
    ds = MAP_DATASETS_BY_ID["hycom_currents"]
    pv = erddap_map.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2013-10-12")
    assert pv.value is not None and pv.value >= 0
    assert 0.0 <= pv.direction_deg < 360.0


@pytest.mark.skipif(not COPERNICUS_AVAILABLE, reason="no Copernicus credentials")
def test_copernicus_point_value_through_the_held_handle():
    from app.ingestion import cmems

    ds = next(d for d in CMEMS_DATASETS if d.id == "cmems_temperature")
    pv = cmems.fetch_point_value(ds=ds, lat=15.0, lon=88.0, time="2026-06-23")
    assert 20.0 < pv.value < 35.0
    assert pv.depth is not None and pv.depth < 1.0
```

- [ ] **Step 2: Run it and expect FAIL.** Expected: `ImportError: cannot import name 'speed_direction'`.

- [ ] **Step 3: Implement.** In `erddap_map.py`, add `from concurrent.futures import ThreadPoolExecutor` to the imports. After `PointBlock`, add:

```python
class PointValue:
    """One value at one grid cell, one time and one depth — the assistant's readout.

    Not a `PointBlock`: that carries every level for a month for the map's point
    panel and costs seconds. A question about one number should cost one level.
    """

    __slots__ = ("value", "lat", "lon", "depth", "time", "units", "source", "direction_deg")

    def __init__(self, value, lat, lon, depth, time, units, source, direction_deg=None) -> None:
        self.value = value
        self.lat = lat
        self.lon = lon
        self.depth = depth
        self.time = time
        self.units = units
        self.source = source
        self.direction_deg = direction_deg


def speed_direction(u, v) -> tuple[float | None, float | None]:
    """Speed, and the compass bearing the water moves TOWARDS, from u (east) and v (north)."""
    if u is None or v is None or not (np.isfinite(u) and np.isfinite(v)):
        return None, None
    return float(np.hypot(u, v)), float((np.degrees(np.arctan2(u, v)) + 360.0) % 360.0)
```

At the end of the module, add:

```python
def _read_point(payload: bytes, ds: MapDataset, name: str):
    with _open(payload) as dset:
        raw = float(np.asarray(dset[name].values, dtype=np.float64).ravel()[0])
        lat = float(np.atleast_1d(dset[ds.lat_dim].values)[0])
        lon = float(np.atleast_1d(dset[ds.lon_dim].values)[0])
        depth = (
            float(np.atleast_1d(dset[ds.depth_dim].values)[0]) if ds.depth_dim is not None else None
        )
    return (raw if np.isfinite(raw) else None), lat, lon, depth


def fetch_point_value(
    *, ds: MapDataset, lat: float, lon: float, time: str, depth: float | None = None
) -> PointValue:
    """One level at one cell. A vector product returns speed and bearing.

    `ds.variable` alone is only the u component of a current, so a vector
    product reads both components (in parallel) and combines them.
    """
    names = list(ds.vector_components) if ds.vector_components else [ds.variable]

    def one(name: str):
        query = _query(ds, name, time=time[:10], depth=depth, lat_point=lat, lon_point=lon)
        payload, source = client.fetch(
            client.griddap_url(ds.dataset_id, query, fmt="nc", base=ds.base)
        )
        return _read_point(payload, ds, name), source

    if len(names) == 1:
        results = [one(names[0])]
    else:
        with ThreadPoolExecutor(max_workers=len(names)) as pool:
            results = list(pool.map(one, names))

    (value, cell_lat, cell_lon, cell_depth), source = results[0]
    direction = None
    if ds.vector_components:
        value, direction = speed_direction(results[0][0][0], results[1][0][0])
    return PointValue(
        value=value, lat=cell_lat, lon=cell_lon, depth=cell_depth,
        time=_stamp(time[:10]), units=ds.units, source=source, direction_deg=direction,
    )
```

In `cmems.py`, add `import threading`, and extend the `erddap_map` import to `PointBlock, PointValue, SliceResult, VectorResult, speed_direction`. Then add:

```python
_arco_lock = threading.Lock()
_arco: dict[str, xr.Dataset] = {}


def _arco_handle(ds: MapDataset) -> xr.Dataset:
    """A lazily-opened ARCO store, held for the life of the process.

    Spiked 2026-09-10: opening costs ~8 s once, and after that one cell costs
    4-6 s, against ~11 s for every `subset`. Point reads are the one request
    shape where holding the handle pays, so only they use it.
    """
    with _arco_lock:
        handle = _arco.get(ds.dataset_id)
        if handle is None:
            _ensure_login()
            import copernicusmarine as cm

            try:
                handle = cm.open_dataset(dataset_id=ds.dataset_id, service="arco-time-series")
            except Exception as exc:  # noqa: BLE001 - toolbox raises a wide variety
                raise CopernicusUnavailable(
                    f"Copernicus Marine could not open {ds.dataset_id}: {exc}"
                ) from exc
            _arco[ds.dataset_id] = handle
        return handle


def _point_value(arrays: dict, ds: MapDataset, day: str, source: SourceStatus) -> PointValue:
    vals = [float(v) if np.isfinite(v) else None for v in arrays["values"]]
    value, direction = vals[0], None
    if ds.vector_components:
        value, direction = speed_direction(vals[0], vals[1])
    cell = arrays["cell"]
    return PointValue(
        value=value, lat=float(cell[0]), lon=float(cell[1]),
        depth=float(cell[2]) if np.isfinite(cell[2]) else None,
        time=f"{day}T00:00:00Z", units=ds.units, source=source, direction_deg=direction,
    )


def fetch_point_value(
    *, ds: MapDataset, lat: float, lon: float, time: str, depth: float | None = None
) -> PointValue:
    """One native cell through the held ARCO handle, disk-cached for 30 days."""
    day = time[:10]
    names = list(ds.vector_components) if ds.vector_components else [ds.variable]
    key = _key(ds, "value", var=",".join(names), lat=round(lat, 3), lon=round(lon, 3), t=day, d=depth)
    hit = cache.read(key, ttl=30 * 24 * 3600)
    if hit is not None:
        return _point_value(_unpack(hit.payload), ds, day, _status("cached", hit.fetched_at, ds))

    sel: dict[str, object] = {"time": day, "latitude": lat, "longitude": lon}
    if ds.depth_dim is not None:
        sel["depth"] = depth if depth is not None else 0.0
    try:
        picked = _arco_handle(ds)[names].sel(**sel, method="nearest").load()
    except CopernicusUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CopernicusUnavailable(f"Copernicus Marine request failed: {exc}") from exc

    arrays = {
        "values": np.asarray([float(picked[n].values) for n in names], dtype=np.float64),
        "cell": np.asarray([
            float(picked["latitude"].values),
            float(picked["longitude"].values),
            float(picked["depth"].values) if "depth" in picked.coords else np.nan,
        ]),
    }
    at = cache.write(key, _pack(arrays))
    return _point_value(arrays, ds, day, _status("live", at, ds))


def warm_in_background(datasets) -> threading.Thread | None:
    """Open the ARCO handles off the request path, so a first question skips ~8 s."""
    unique = list({d.dataset_id: d for d in datasets if d.protocol == "cmems"}.values())
    if not unique or not COPERNICUS_AVAILABLE:
        return None

    def run() -> None:
        for d in unique:
            try:
                _arco_handle(d)
            except Exception as exc:  # noqa: BLE001 - a failed warm-up only costs time
                log.warning("Copernicus warm-up for %s failed: %s", d.dataset_id, exc)

    thread = threading.Thread(target=run, name="cmems-warm", daemon=True)
    thread.start()
    return thread
```

In `main.py`, add a lifespan that warms Copernicus (skippable with `OCEANVIZ_WARM=off`):

```python
import os
from contextlib import asynccontextmanager

from .config import CACHE_DIR, MAP_DATASETS
from .ingestion import cmems


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The first Copernicus point read otherwise pays ~8 s to open the store.
    if os.environ.get("OCEANVIZ_WARM", "on").lower() != "off":
        cmems.warm_in_background(MAP_DATASETS)
    yield
```

Then pass `lifespan=lifespan` to `FastAPI(...)`.

- [ ] **Step 4: Run it and expect PASS** (4 passed, or 3 passed and 1 skipped without credentials).

---

### Task 4: Per-view tool registry and validation

**Files:**
- Rewrite: `backend/app/assistant/tools.py`
- Rewrite: `backend/tests/test_assistant_tools.py`

**Interfaces:**
- Produces:
  - dataclasses `MapState`, `GlobeState`, `ChunkState`, `ScreenState`, with `ScreenState.from_payload(dict)` and `ScreenState.view_date() -> str`;
  - constants `VIEWS`, `NAMED_REGIONS`, `CHUNK_VARIABLES`, `CHUNK_LAYERS`, `ACTION_TOOLS`, `VIEW_SWITCHING`;
  - `tools_for(view) -> tuple[str, ...]` and `declarations_for(view) -> list[dict]`;
  - `validate_action(name, args, state, catalogue) -> dict`, which adds `scope`;
  - `advance_state(state, action) -> bool`, which returns True when the view changed;
  - `describe_actions(actions) -> str`;
  - helpers `choose(kind, raw, allowed) -> str | None`, `fmt_date(iso) -> str`, `fmt_point(lat, lon) -> str`, `snap_tile(lon, lat) -> list[float]`.

The tests must cover the cases below. The full file contents are written during execution.

- **Map layers:** add and hide in one action; an unknown key is refused; the 3-layer cap holds; adding a layer that's already present counts as satisfied; hiding an absent layer is refused; opacity must be a fraction.
- **Map time:** `set_time` inside a visible layer's coverage is accepted, and outside it is refused with the coverage named; `set_time` with no layers is accepted.
- **Map depth:** `set_depth` snaps to the nearest real level of the active layer and reports `depth_index`; it is refused for a surface layer and for a depth below the grid.
- **Map navigation:** the region table is case-insensitive and refuses unknown regions; pin and area bounds are checked.
- **Scoping:** a chunk action while the map is showing is refused naming the chunk; a map action in the chunk is refused naming the map; `tools_for("chunk")` contains `show_variable` and `describe_chunk` but not `set_layers`; every action carries `scope`.
- **Globe:** `set_time` outside the window is refused; `select_float` is refused for a float that isn't reporting, and when none are reporting.
- **Chunk:**
  - `show_variable` accepts aliases (`"current speed"` → `speed`);
  - `set_time` outside the window is refused, and inside returns the day;
  - `set_display` to volume is refused for chlorophyll;
  - `set_cut` on a longitude outside the tile is refused;
  - `set_iso_value` outside the physical range is refused;
  - `set_exaggeration` is bounded to 10–200;
  - `set_camera` accepts the alias `"top-down"` → `top`;
  - `set_layer` for `"instruments"` is refused, since it was removed upstream;
  - `set_colour_scale` requires an actual change, with min < max;
  - `move_chunk` north shifts the centre by 5°.
- **Common:** `set_view` works for all three views and refuses `column`; `open_chunk` works by region or explicit lat/lon and refuses an unknown region.
- **`advance_state`:** `open_chunk` switches the view to chunk and snaps the bbox; `show_variable("chlorophyll")` followed by `set_display("volume")` in the same turn is refused.
- **`describe_actions`:** produces `"Added chlorophyll. Hid temperature."`, `"Showing salinity."` and `"Date set to 12 Oct 2013."`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them and expect FAIL** (import errors).
- [ ] **Step 3: Implement `tools.py`.**
- [ ] **Step 4: Run them and expect PASS.**

---

### Task 5: View-aware reads

**Files:**
- Rewrite: `backend/app/assistant/reads.py`
- Test: `backend/tests/test_assistant_reads.py`

**Interfaces:**
- Consumes: the Task 1 resolver; Task 3 `fetch_point_value`; Task 4 `ScreenState`, `choose`, `fmt_point`, `CHUNK_VARIABLES`; and `routers.chunk._dataset`, `_volume`, `_tile`.
- Produces: `READ_TOOLS` covering `query_point`, `list_floats`, `compare_float` and `describe_chunk`, each `fn(state, args) -> dict`; `ReadError`; `cache_context(name, state) -> dict`; `status_for(name, args, state) -> str`.

The tests use monkeypatched fakes, with no network, and must cover:
- **Map, with Copernicus configured and the clock at 2026-06-23:** reads `cmems_temperature`.
- **Map, without Copernicus:** raises `ReadError` naming HYCOM's coverage, and **never** calls a fetch.
- **Chlorophyll in 2013:** resolves to `incois_chlorophyll`.
- **Depth:** defaults to the active map layer's depth for that variable; a surface dataset passes `depth=None`.
- **Refusals:** an `UpstreamRefused` becomes a `ReadError` containing "refused" and "HTTP 500".
- **Chunk:**
  - `query_point` inside the tile samples the loaded volume at the nearest cell and level, and reports the cell;
  - outside the tile, it reads one native level instead;
  - `describe_chunk` returns per-level stats and the strongest vertical gradient, between the right pair of levels.
- **Caching:** `cache_context` differs when the view's date differs.

- [ ] **Steps 1–4:** as in the tasks above.

---

### Task 6: Prompt per view

**Files:** Rewrite `backend/app/assistant/prompt.py`. Test: `backend/tests/test_assistant_prompt.py`.

**Interfaces:** `build_system_prompt(*, state: ScreenState, catalogue: list[str]) -> str`.

The tests must check that:
- the chunk prompt names the tile, variable, date and window, and says that only this view's tools act;
- the map prompt lists each layer with its source and coverage;
- the globe prompt lists the window and the reporting floats;
- no prompt mentions a tool its view does not declare.

---

### Task 7: The loop — fast, fallback, view switching

**Files:** Rewrite `backend/app/assistant/gemini_client.py`. Test: `backend/tests/test_assistant_loop.py`.

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `run_turn(*, history, state, catalogue, store=None, on_status=None) -> TurnResult`, with `.text`, `.actions`, `.tool_calls`, `.web_sources`, `.citations`, `.model` and `.rounds`;
  - `start_search_probe() -> None`;
  - `AssistantUnavailable`;
  - `_chain: ModelChain`.

The tests use a fake `interactions.create` with no network, and patch `time.sleep` to fail if called. They must cover:
- a pure command costs **one** request, and its text is composed from the action;
- `open_chunk` then `show_variable` takes two requests: the second declares `show_variable` and not `set_layers`, and the text describes both actions;
- a 429 moves to the next model without sleeping, and the cooled-down model is skipped on the next turn;
- a read that runs past the budget returns `pending`, and the turn still finishes;
- two reads in one round run concurrently;
- a refused action, or any read, makes the loop take a second round;
- every request carries `generation_config.thinking_level` and `timeout`.

---

### Task 8: Router, status probe, history cap

**Files:** Modify `backend/app/routers/assistant.py`. Extend `backend/tests/test_assistant_loop.py`.

- `MessageRequest.state: dict[str, Any]` is parsed with `ScreenState.from_payload`.
- History is sliced to the last `ASSISTANT_HISTORY_MESSAGES`.
- `/assistant/status` calls `gemini_client.start_search_probe()`.
- The `done` event gains `timing: {total_ms, rounds, model}`.

The tests must check that `ScreenState.from_payload` tolerates missing blocks and unknown keys, and that an unknown view falls back to `map`.

---

### Task 9: Chunk actions as pure spec transforms (frontend)

**Files:**
- Create: `frontend/src/assistant/chunkActions.ts`, `frontend/src/assistant/chunkActions.test.ts`.
- Modify: `frontend/src/viz/chunk/spec.ts`, to export `CHUNK_FOCUS_DATE = "2013-10-10"` and `CHUNK_WINDOW_STEPS = 30`; `ChunkView.tsx` imports them.

**Interfaces:**
- `applyChunkAction(spec, action, ctx: {times: string[]; hist: {lo, hi} | null}) -> ChunkEffect`, where `ChunkEffect` is `{spec, variableChanged?, preset?, exaggeration?, move?}`. It never mutates its input.
- `describeChunkSpec(spec, times, bbox, mounted) -> ChunkStatePayload`.
- `ChunkActionQueue`, with `push`, `pushRestore` and `drain(controller)`.

The tests must check that:
- `show_variable` resets palette, range and scale the way the panel does, and forces slices for chlorophyll;
- `set_time` picks the nearest index;
- `set_cut` sets the axis and position;
- `set_iso_value` switches to isosurface;
- `set_layer` works;
- `set_colour_scale` with auto uses the histogram;
- the input spec is untouched;
- `describeChunkSpec(DEFAULT_SPEC, window)` reports 2013-10-07 inside 2013-09-25 to 2013-10-24;
- the queue drains the restore first, then the actions in order.

### Task 10: The bridge — state out, actions in, undo (frontend)

**Files:** Create `frontend/src/assistant/useAssistantBridge.ts`. Modify `actions.ts`, `useAssistant.ts`, `App.tsx` and `components/chunk/ChunkView.tsx`.

`App.tsx` swaps its inline assistant block (the state builder, the action switch and undo) for `useAssistantBridge({...})`. `ChunkView` gains `onAssistantController` and `onMove` props, and registers `{getState, apply, snapshot, restore}` once its engine is ready.

### Task 11: The panel — scope line, examples, chunk placement (frontend)

**Files:**
- `AssistantPanel.tsx`: new props `view` and `scopeLabel`; examples per view.
- `styles/assistant.css`: a new `.assistant-panel__scope` rule, and the chunk placement moved to the right of `.chunk-layers` (`left: 348px; bottom: 88px; top: auto; max-height: min(560px, calc(100vh - 220px))`). Under 900px it falls back to the existing narrow rule.

With the assistant open, `elementFromPoint` over `.chunk-layers`, `.chunk-crumb` and `.chunk-inspector` must hit those panels, not the assistant.

### Task 12: Verify end to end, measure, document

- **Suites:** backend pytest, `tsc`, vitest and `npm run build`.
- **Restart `npm run dev`:** the running backend is stale and has no reload.
- **Throwaway Puppeteer:**
  - one command and one question per view, asserting the visible change and timing each turn;
  - a Map → Globe → Chunk → Map round trip with zero console errors;
  - two screenshot passes of the chunk placement.
- **Latency:** measured with `time_turn.mjs` and reported as measured.
- **Docs:**
  - `context.md` §10 entries at the end;
  - a §5.1 Principle 13 amendment;
  - `next_session.md` §1c;
  - `.env.example`.
