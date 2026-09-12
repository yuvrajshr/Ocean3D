"""Dataset facts for the INCOIS ERDDAP server.

Every value here was read off the live server (``/info/{id}/index.json``) rather
than assumed, because getting a dimension name or a unit wrong silently produces
a plausible-looking but wrong picture. See context.md §10.
"""

from __future__ import annotations

import os

from dataclasses import dataclass, field
from pathlib import Path

ERDDAP_BASE = "https://erddap.incois.gov.in/erddap"

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent
CACHE_DIR = BACKEND_ROOT / "app" / "cache_store"
FIXTURE_DIR = PROJECT_ROOT / "data"

# How long a cached upstream response is considered fresh. Beyond this we try
# the network again, but a stale entry is still served if the network fails —
# the demo must never hard-fail on venue wifi (context.md §10).
CACHE_TTL_SECONDS = 60 * 60 * 12

# INCOIS's certificate chain is served without its intermediate, so strict
# clients reject it (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Browsers usually recover
# via AIA fetching; httpx does not. This is the single place that decision is
# made — see erddap_client.py.
ERDDAP_VERIFY_TLS = False


# --- Credentials -----------------------------------------------------------
# Copernicus Marine needs an account. The credentials live in `backend/.env`,
# which is gitignored; only the variable NAMES are committed, in .env.example.
# Loaded here rather than by the toolbox so a missing file degrades to "the
# Copernicus layers are unavailable" instead of an import-time crash.
def _load_dotenv() -> None:
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for raw in env.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

COPERNICUS_USERNAME = os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME", "")
COPERNICUS_PASSWORD = os.environ.get("COPERNICUSMARINE_SERVICE_PASSWORD", "")
COPERNICUS_AVAILABLE = bool(COPERNICUS_USERNAME and COPERNICUS_PASSWORD)

# Licence condition, not a courtesy: using Copernicus Marine data obliges us to
# display this plus each product's DOI. It ships with the data or the data does
# not ship (context.md 5.5).
COPERNICUS_CREDIT = "Generated using E.U. Copernicus Marine Service Information"

# ---------------------------------------------------------------- assistant

# The ocean assistant. Server-side only: the key never reaches the browser,
# exactly like the Copernicus credentials above. Without a key the assistant
# simply does not appear and every other part of the app still works, which is
# the same degradation the Copernicus layers already have.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_AVAILABLE = bool(GEMINI_API_KEY)
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

# Conversations and the analysis cache. SQLite rather than a hosted database:
# context.md 1 requires the app be deployable on INCOIS infrastructure, and 4
# already sanctions "SQLite for demo". Lives beside the disk cache and is
# gitignored the same way.
ASSISTANT_DB = BACKEND_ROOT / "app" / "assistant_store" / "assistant.db"

# How long a cached tool result stays fresh. Ocean analyses for a past date do
# not change, so this is generous; it exists to stop a repeated question
# spending free-tier quota, not to guarantee recency.
ASSISTANT_CACHE_TTL_SECONDS = 60 * 60 * 24

# A hard ceiling on tool-calling rounds per message. Without it a confused
# model can loop until the quota is gone.
ASSISTANT_MAX_STEPS = 6

# A read past this budget is reported to the model as still loading. The fetch
# finishes in the background and lands in the analysis cache for the next ask.
ASSISTANT_READ_BUDGET_SECONDS = 10.0
# Conversation turns resent to the model. Older ones cost latency on every
# request and rarely change the answer.
ASSISTANT_HISTORY_MESSAGES = 12

# Google Search grounding, which lets the assistant answer live real-world
# questions ("what is oil trading at?") with real sources instead of an honest
# refusal.
#
# It is billed separately from generation and is NOT part of the free tier:
# measured on a free key, every request carrying the `google_search` tool
# returned 429 "check your plan and billing details", while the identical
# request without it succeeded. Enable billing on the Google Cloud project and
# it starts working with no code change.
#
# "auto" (the default) tries once per process and remembers the answer. Set to
# "off" on a free key to skip that probe and save a request per restart, or
# "on" to insist.
GEMINI_SEARCH = os.environ.get("GEMINI_SEARCH", "auto").strip().lower()


@dataclass(frozen=True)
class VariableSpec:
    """One variable a user can select, and how to actually fetch it."""

    key: str  # stable id used by the frontend
    dataset_id: str  # ERDDAP datasetID
    erddap_name: str  # variable name on the server
    label: str  # sentence case, for the UI
    units: str  # normalized, display-ready
    kind: str  # "volume" (has depth) | "surface" | "vector"
    colormap: str  # cmocean ramp, per context.md §5.1
    caption: str  # one line, Explore mode
    units_declared_by_us: bool = False  # True when ERDDAP omitted the units


# --- The 3D volume. This is the hero: 24 depth levels, 5-2000 m. ------------
GRID_DATASET = "incois_argo_10d_VAM"
GRID_DIMS = ("time", "ZAX", "latitude", "longitude")
GRID_SHAPE = {"ZAX": 24, "latitude": 60, "longitude": 90}
GRID_LAT_RANGE = (-29.5, 29.5)
GRID_LON_RANGE = (30.5, 119.5)
GRID_DEPTH_RANGE = (5.0, 2000.0)

# --- In-situ observations --------------------------------------------------
ARGO_DATASET = "Indian_ARGO_Floats"
# Argo quality flags: 1 = good, 2 = probably good. Everything else is rejected.
# This is a correctness requirement: float 2900757 looks like a -4 C cold wake
# but is entirely QC=4. See context.md §10.
ARGO_ACCEPTED_QC = ("1", "2")

# --- Derived hazard fields + currents. Stops 2019-03-30. -------------------
VALUE_ADDED_DATASET = "incois_valueadded_products_datasets"
VALUE_ADDED_TIME_RANGE = ("2004-01-10", "2019-03-30")

# --- Chlorophyll (surface, cloud-gapped) ----------------------------------
CHLOROPHYLL_DATASET = "incois_oceansat2_datasets"


VARIABLES: tuple[VariableSpec, ...] = (
    VariableSpec(
        key="temperature",
        dataset_id=GRID_DATASET,
        erddap_name="TEMP",
        label="Temperature",
        # ERDDAP reports the unit as "degs"; the CF standard_name and the value
        # range (-2..33) make it unambiguous that this is Celsius.
        units="°C",
        kind="volume",
        colormap="thermal",
        caption="How warm the water is, from the surface down to 2000 m.",
    ),
    VariableSpec(
        key="salinity",
        dataset_id=GRID_DATASET,
        erddap_name="SAL",
        label="Salinity",
        units="PSU",
        kind="volume",
        colormap="haline",
        caption="How salty the water is. Rivers and rain make the Bay of Bengal fresher near the surface.",
    ),
    VariableSpec(
        key="currents",
        dataset_id=VALUE_ADDED_DATASET,
        erddap_name="GEO_U,GEO_V",
        # Shown as speed, sqrt(u^2 + v^2), not a single component. Direction is
        # not yet drawn — see the roadmap note in README.
        label="Current speed",
        units="cm/s",
        kind="vector",
        colormap="speed",
        caption="How fast the surface water is moving.",
        units_declared_by_us=True,
    ),
    VariableSpec(
        key="chlorophyll",
        dataset_id=CHLOROPHYLL_DATASET,
        erddap_name="CHL",
        label="Chlorophyll",
        units="mg/m³",
        kind="surface",
        colormap="algae",
        caption="Plant life near the surface. Satellites cannot see through cloud, so there are gaps.",
    ),
)

HAZARD_VARIABLES: tuple[VariableSpec, ...] = (
    VariableSpec(
        key="d26",
        dataset_id=VALUE_ADDED_DATASET,
        erddap_name="D26",
        label="Depth of the 26 °C isotherm",
        units="m",
        kind="surface",
        colormap="thermal",
        caption="How deep the water stays above 26 °C. Cyclones feed on this layer.",
        units_declared_by_us=True,
    ),
    VariableSpec(
        key="heat_content",
        dataset_id=VALUE_ADDED_DATASET,
        erddap_name="HTCNT",
        label="Upper ocean heat content",
        units="kJ/cm²",
        kind="surface",
        colormap="thermal",
        caption="The fuel available to a cyclone passing overhead.",
        units_declared_by_us=True,
    ),
    VariableSpec(
        key="mixed_layer_depth",
        dataset_id=VALUE_ADDED_DATASET,
        erddap_name="MLD",
        label="Mixed layer depth",
        units="m",
        kind="surface",
        colormap="delta",
        caption="How deep the wind has stirred the surface water.",
        units_declared_by_us=True,
    ),
)


# --- Terrain relief -------------------------------------------------------
# ETOPO from NOAA CoastWatch: 1 arc-minute global relief, `altitude` in metres,
# positive on land and negative at sea. One dataset gives both the Eastern
# Ghats and the floor of the Bay of Bengal, which is the point — they are one
# continuous surface, and rendering them as one is what stops the analysis
# looking like a box in a void (context.md §5.1, Principle 6).
# 2026-09-05: repointed. The old base, coastwatch.pfeg.noaa.gov, is a legacy
# host NOAA has retired — it no longer resolves, and `etopo180` exists on no
# reachable ERDDAP. Terrain was therefore loading only from the disk cache, so a
# fresh clone lost the seafloor entirely. NCEI's ArcGIS ImageServer publishes the
# same ETOPO1 bedrock grid and returns real Float32 metres, so the fix is a new
# transport rather than a new dataset.
TERRAIN_BASE = "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics"
TERRAIN_DATASET = "ETOPO1_bedrock"
# ETOPO1 is 1 arc-minute, so a span in degrees times 60 is its native cell count.
TERRAIN_ARCMIN_PER_DEG = 60

# Deliberately wider than the analysis box so the sea continues past the data
# to a horizon rather than stopping at its edge.
TERRAIN_LAT_RANGE = (0.0, 25.0)
TERRAIN_LON_RANGE = (75.0, 100.0)

# Stride over the 1-arc-minute grid. 4 gives 376 x 376 (~550 KB as Float32),
# fine enough for a legible coastline and trivial for the GPU as a mesh.
TERRAIN_STRIDE = 4


@dataclass(frozen=True)
class Scenario:
    """A preset the demo opens on."""

    key: str
    title: str
    summary: str
    time_start: str
    time_end: str
    focus_time: str
    lat_range: tuple[float, float]
    lon_range: tuple[float, float]
    featured_platforms: tuple[str, ...] = field(default_factory=tuple)
    # Which bundled Blue Marble month the globe shows. Both ship; a scenario picks
    # the one that matches its season. See frontend/scripts/fetch-textures.mjs.
    basemap: str = "october"


# Cyclone Phailin is the only window where the 3D grid, the in-situ floats and
# the hazard fields all overlap — the value-added products stop in March 2019.
PHAILIN = Scenario(
    key="phailin",
    title="Cyclone Phailin",
    summary=(
        "Phailin crossed the Bay of Bengal and made landfall near Gopalpur on "
        "12 October 2013. Argo float 2901335 was directly under the track and "
        "recorded the ocean cooling as the storm passed."
    ),
    time_start="2013-10-01",
    time_end="2013-10-25",
    focus_time="2013-10-10",
    lat_range=(5.0, 23.0),
    lon_range=(78.0, 95.0),
    # 2901335 profiled near-hourly and shows the cold wake; 2901327 shows the
    # same event in the subsurface (100 m: 23.72 -> 20.27 C).
    featured_platforms=("2901335", "2901327", "2901334", "2901288"),
    # October 2013: the December basemap's Arctic and Scandinavian snow would be
    # the wrong season for this window.
    basemap="october",
)

SCENARIOS = {PHAILIN.key: PHAILIN}


# ---------------------------------------------------------------------------
# 2D map layers (added 2026-09-05)
# ---------------------------------------------------------------------------
# Deliberately a separate dataclass from VariableSpec. These live on other
# ERDDAP servers, carry their own depth axes, cadences and axis orders, and are
# addressed one depth level at a time. Widening VariableSpec would force every
# 3D consumer to care about a `base` URL and an axis order it never uses.
#
# Every dataset below was verified live on 2026-09-05: dimensions read from the
# server's own /info/ endpoint, payload sizes and latency measured by fetching
# them. Nothing here is assumed.

MAP_ERDDAP_APDRC = "https://apdrc.soest.hawaii.edu/erddap"
MAP_ERDDAP_COASTWATCH = "https://coastwatch.noaa.gov/erddap"

# A slice is capped at this many cells; the server raises the stride to fit and
# reports what it used, rather than refusing. 400k cells is 1.6 MB as Float32.
MAX_SLICE_CELLS = 400_000
# A time axis longer than this is summarised rather than enumerated. HYCOM has
# 8034 daily steps and VIIRS 4833; sending every stamp is ~200 KB of JSON.
MAX_TIME_ENTRIES = 2_000

# The same budget for a volume, counted across every level rather than per
# level. A 5-degree chunk of HYCOM is 63 x 63 x 36 = 143k cells (571 KB as
# Float32) and needs no striding at all; the cap only bites if someone asks for
# a chunk far larger than the view was designed around.
MAX_VOLUME_CELLS = 400_000

# The chunk view's tile size, in degrees. A globe click floors to this grid, so
# the same click always resolves to the same tile and the backend cache is
# reused across visits. This is a request-shaping convention, not a storage
# tiling layer — see context.md §12, which rules the latter out.
CHUNK_TILE_DEGREES = 5.0
# Chunks stop where Argo does. Below 2000 m nothing in this project has measured
# anything, and drawing HYCOM's deeper levels would claim otherwise.
CHUNK_MAX_DEPTH = 2000.0

# Which product serves each of the chunk view's variables.
#
# Named explicitly rather than resolved through `map_dataset_for`, which picks by
# preference and would silently hand the chunk view a surface product or a
# different grid the day another upstream is enabled. The chunk view needs one
# grid across all four variables, so this table is the place that decision is
# made and the place to change it.
#
# INCOIS's own `incois_argo_10d_VAM` is deliberately not here: at 1 degree a
# 5-degree chunk is 6x6 cells, which is thirty-six columns of water rather than
# a block of it. The map view still draws INCOIS, and states that it does.
CHUNK_DATASETS: dict[str, str] = {
    "temperature": "hycom_temperature",
    "salinity": "hycom_salinity",
    # Advected client-side from u and v; the scalar path serves hypot(u, v).
    "speed": "hycom_currents",
    # The one variable with no 3D source anywhere. VIIRS is surface-only, so the
    # chunk view disables its depth-dependent modes and says why.
    "chlorophyll": "incois_chlorophyll",
}


@dataclass(frozen=True)
class MapDataset:
    """A gridded product the 2D map can draw.

    `axis_order` is the griddap dimension order, which differs per server and is
    the single most common source of a silently-wrong query: HYCOM is
    (time, LEV, latitude, longitude) while VIIRS carries a singleton `altitude`
    where a depth would go. Building the query by walking this tuple means a new
    upstream is a table entry, not a new code path.
    """

    id: str
    base: str
    dataset_id: str
    variable: str
    label: str
    provider: str
    attribution: str
    units: str
    kind: str  # "volume" (has depth) | "surface" | "vector"
    colormap: str
    caption: str
    axis_order: tuple[str, ...]
    depth_dim: str | None  # the member of axis_order that is a real depth
    lat_dim: str = "latitude"
    lon_dim: str = "longitude"
    # Some servers store latitude north-to-south. A griddap range must be given
    # in axis order, so asking for (lo):(hi) on a descending axis returns 404.
    lat_descending: bool = False
    lon_range: tuple[float, float] = (-180.0, 180.0)
    lat_range: tuple[float, float] = (-90.0, 90.0)
    native_shape: tuple[int, int] = (0, 0)  # (n_lat, n_lon)
    time_range: tuple[str, str] = ("", "")
    cadence: str = "daily"
    cadence_days: float = 1.0
    vector_components: tuple[str, str] | None = None
    regional: bool = False
    units_declared_by_us: bool = False
    default_stride: int = 1
    # "erddap" reaches the server with a griddap URL; "cmems" goes through the
    # Copernicus Marine toolbox, which subsets server-side and has no stride.
    protocol: str = "erddap"
    # Which VariableSpec key this dataset is a source for. A layer in the UI is a
    # *variable*, not a dataset: adding "Temperature" gives the 3D column INCOIS's
    # analysis and the 2D map whichever global product serves it best. This field
    # is what lets one layer resolve to a different source per view.
    variable_key: str = ""
    # Lower wins when several datasets satisfy the same variable.
    preference: int = 100
    # Licence attribution that MUST appear wherever the layer does.
    doi: str = ""


# HYCOM GLBv0.08 — the workhorse. Global, 40 levels to 5000 m, daily.
# One dataset supplies the coloured field, the depth slider, the profile, the
# depth-time section and the u/v for streamlines.
_HYCOM = dict(
    base=MAP_ERDDAP_APDRC,
    dataset_id="hawaii_soest_6a0a_5127_d118",
    provider="HYCOM GLBv0.08",
    attribution="HYCOM GLBv0.08 via APDRC, University of Hawaii",
    axis_order=("time", "LEV", "latitude", "longitude"),
    depth_dim="LEV",
    lat_range=(-80.0, 90.0),
    lon_range=(-180.0, 179.92),
    native_shape=(3251, 4500),
    time_range=("1994-01-01", "2015-12-30"),
    cadence="daily",
    cadence_days=1.0,
    default_stride=16,
)

MAP_DATASETS: tuple[MapDataset, ...] = (
    MapDataset(
        id="hycom_temperature",
        variable_key="temperature",
        preference=2,
        variable="water_temp",
        label="Temperature",
        units="°C",
        kind="volume",
        colormap="thermal",
        caption="How warm the water is, from the surface down to 5000 m.",
        **_HYCOM,
    ),
    MapDataset(
        id="hycom_salinity",
        variable_key="salinity",
        preference=2,
        variable="salinity",
        label="Salinity",
        units="PSU",
        kind="volume",
        colormap="haline",
        caption="How salty the water is. Rivers and rain freshen the surface.",
        **_HYCOM,
    ),
    MapDataset(
        id="hycom_currents",
        variable_key="currents",
        preference=2,
        variable="water_u",
        vector_components=("water_u", "water_v"),
        label="Currents",
        units="m/s",
        kind="vector",
        colormap="speed",
        caption="How fast the water is moving, and which way.",
        **{k: v for k, v in _HYCOM.items() if k != "default_stride"},
        default_stride=16,
    ),
    MapDataset(
        id="viirs_chlorophyll",
        variable_key="chlorophyll",
        # Repointed and demoted 2026-09-09. The science-quality dataset this row
        # used to name, `noaacwNPPVIIRSSQchlaDaily`, was retired by CoastWatch and
        # now answers 404 "Currently unknown datasetID". Nothing noticed because
        # the response was still on disk — the test that covers this path was
        # green from cache while a clean machine would have shown an empty map.
        #
        # The replacement is near-real-time and carries a ROLLING one-year window,
        # so `time_range` below goes stale on its own and nothing may hardcode a
        # date inside it. It cannot serve the 2013 demo at all, which is why
        # INCOIS Oceansat-2 is preferred for chlorophyll.
        preference=2,
        base=MAP_ERDDAP_COASTWATCH,
        dataset_id="noaacwNPPVIIRSchlaDaily",
        variable="chlor_a",
        label="Chlorophyll",
        provider="S-NPP VIIRS, near real-time",
        attribution="NOAA CoastWatch, S-NPP VIIRS Level 3",
        units="mg/m³",
        kind="surface",
        colormap="algae",
        caption="Plant life near the surface. Satellites cannot see through cloud, so there are gaps.",
        # `altitude` is a singleton, not a depth — it must still be indexed, but
        # it must never produce a depth ruler.
        axis_order=("time", "altitude", "latitude", "longitude"),
        depth_dim=None,
        lat_descending=True,
        lat_range=(-89.75625, 89.75625),
        lon_range=(-180.01875, 180.01875),
        native_shape=(4788, 9602),
        # Rolling. Read off the server 2026-09-09; it moves every day.
        time_range=("2025-08-07", "2026-08-12"),
        cadence="daily",
        cadence_days=1.0,
        default_stride=24,
    ),
)

MAP_DATASETS_BY_ID: dict[str, MapDataset] = {d.id: d for d in MAP_DATASETS}


# --- Copernicus Marine (GLORYS) -------------------------------------------
# Better data than HYCOM on every axis that matters here: 0.083 deg, 50 levels
# to 5728 m, daily, and it runs to 2026-06 with a forecast product reaching ten
# days past today. The cost is that CMEMS has no server-side striding and about
# 11 s of fixed request overhead, so slices are downsampled and cached by us.
_GLORYS = dict(
    base="https://data.marine.copernicus.eu",
    dataset_id="cmems_mod_glo_phy_my_0.083deg_P1D-m",
    provider="Copernicus Marine GLORYS12V1",
    attribution=(
        "Generated using E.U. Copernicus Marine Service Information; "
        "Global Ocean Physics Reanalysis, doi.org/10.48670/moi-00021"
    ),
    doi="10.48670/moi-00021",
    protocol="cmems",
    axis_order=("time", "depth", "latitude", "longitude"),
    depth_dim="depth",
    lat_range=(-80.0, 90.0),
    lon_range=(-180.0, 179.9167),
    native_shape=(2041, 4320),
    time_range=("1993-01-01", "2026-06-23"),
    cadence="daily",
    cadence_days=1.0,
    default_stride=5,
)

CMEMS_DATASETS: tuple[MapDataset, ...] = (
    MapDataset(
        id="cmems_temperature",
        variable_key="temperature",
        preference=1,
        variable="thetao",
        label="Temperature (Copernicus)",
        units="°C",
        kind="volume",
        colormap="thermal",
        caption="How warm the water is, at 0.083° and 50 levels, back to 1993.",
        **_GLORYS,
    ),
    MapDataset(
        id="cmems_salinity",
        variable_key="salinity",
        preference=1,
        variable="so",
        label="Salinity (Copernicus)",
        units="PSU",
        kind="volume",
        colormap="haline",
        caption="How salty the water is, through the full water column.",
        **_GLORYS,
    ),
    MapDataset(
        id="cmems_currents",
        variable_key="currents",
        preference=1,
        variable="uo",
        vector_components=("uo", "vo"),
        label="Currents (Copernicus)",
        units="m/s",
        kind="vector",
        colormap="speed",
        caption="How fast the water moves, and which way, at any depth.",
        **_GLORYS,
    ),
    MapDataset(
        id="cmems_forecast_temperature",
        variable_key="temperature_forecast",
        preference=1,
        base="https://data.marine.copernicus.eu",
        dataset_id="cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m",
        variable="thetao",
        label="Temperature forecast",
        provider="Copernicus Marine analysis & forecast",
        attribution=(
            "Generated using E.U. Copernicus Marine Service Information; "
            "Global Ocean Physics Analysis and Forecast, doi.org/10.48670/moi-00016"
        ),
        doi="10.48670/moi-00016",
        protocol="cmems",
        units="°C",
        kind="volume",
        colormap="thermal",
        caption="The operational forecast — today, and ten days ahead.",
        axis_order=("time", "depth", "latitude", "longitude"),
        depth_dim="depth",
        lat_range=(-80.0, 90.0),
        lon_range=(-180.0, 179.9167),
        native_shape=(2041, 4320),
        time_range=("2022-06-01", "2026-09-13"),
        cadence="daily",
        cadence_days=1.0,
        default_stride=5,
    ),
)

if COPERNICUS_AVAILABLE:
    MAP_DATASETS = MAP_DATASETS + CMEMS_DATASETS
    MAP_DATASETS_BY_ID = {d.id: d for d in MAP_DATASETS}


# The hazard fields have no global equivalent, so the map serves them from
# INCOIS directly. Regional (30.5-119.5E, +/-29.5), 1 deg, 10-daily, and the
# map simply draws nothing outside that box -- which is the honest result.
_INCOIS_VA = dict(
    base=ERDDAP_BASE,
    dataset_id=VALUE_ADDED_DATASET,
    provider="INCOIS value-added products",
    attribution="INCOIS, Ministry of Earth Sciences",
    protocol="erddap",
    axis_order=("time", "latitude", "longitude"),
    depth_dim=None,
    lat_range=GRID_LAT_RANGE,
    lon_range=GRID_LON_RANGE,
    native_shape=(60, 90),
    time_range=VALUE_ADDED_TIME_RANGE,
    cadence="10-daily",
    cadence_days=10.0,
    regional=True,
    units_declared_by_us=True,
    preference=1,
    default_stride=1,
)

INCOIS_MAP_DATASETS: tuple[MapDataset, ...] = (
    MapDataset(
        id="incois_chlorophyll",
        variable_key="chlorophyll",
        # Preferred over CoastWatch: this is INCOIS's own ocean-colour product,
        # it is four times finer (0.04 deg against VIIRS's 4 km), and it is the
        # only chlorophyll source that still covers the demo window at all.
        preference=1,
        base=ERDDAP_BASE,
        dataset_id=CHLOROPHYLL_DATASET,
        variable="CHL",
        label="Chlorophyll",
        provider="INCOIS Oceansat-2 OCM",
        attribution="INCOIS, Ministry of Earth Sciences",
        # ERDDAP declares mg/m3 here, so this one is not our inference.
        units="mg/m³",
        units_declared_by_us=False,
        kind="surface",
        colormap="algae",
        caption="Plant life near the surface. Satellites cannot see through cloud, so there are gaps.",
        protocol="erddap",
        axis_order=("time", "latitude", "longitude"),
        depth_dim=None,
        lat_range=(0.107, 27.893),
        lon_range=(46.683, 99.317),
        native_shape=(717, 1317),
        time_range=("2011-02-02", "2020-05-01"),
        cadence="daily",
        cadence_days=1.0,
        regional=True,
        default_stride=1,
    ),
    MapDataset(
        id="incois_d26",
        variable_key="d26",
        variable="D26",
        label="Depth of the 26 °C isotherm",
        units="m",
        kind="surface",
        colormap="thermal",
        caption="How deep the water stays above 26 °C. Cyclones feed on this layer.",
        **_INCOIS_VA,
    ),
    MapDataset(
        id="incois_heat_content",
        variable_key="heat_content",
        variable="HTCNT",
        label="Upper ocean heat content",
        units="kJ/cm²",
        kind="surface",
        colormap="thermal",
        caption="The fuel available to a cyclone passing overhead.",
        **_INCOIS_VA,
    ),
    MapDataset(
        id="incois_mixed_layer_depth",
        variable_key="mixed_layer_depth",
        variable="MLD",
        label="Mixed layer depth",
        units="m",
        kind="surface",
        colormap="delta",
        caption="How deep the wind has stirred the surface water.",
        **_INCOIS_VA,
    ),
)

MAP_DATASETS = MAP_DATASETS + INCOIS_MAP_DATASETS
MAP_DATASETS_BY_ID = {d.id: d for d in MAP_DATASETS}


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
