"""Dataset settings. Names and units were checked against each server's
/info/{id}/index.json, not guessed.
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

# Cache entries are fresh for 12 h. After that we retry the network, but still
# serve the stale copy if it fails.
CACHE_TTL_SECONDS = 60 * 60 * 12

# INCOIS serves its cert without the intermediate, so httpx rejects it
# (UNABLE_TO_VERIFY_LEAF_SIGNATURE). See erddap_client.py.
ERDDAP_VERIFY_TLS = False


# --- Credentials ---
# Copernicus Marine needs an account; credentials go in backend/.env (gitignored).
# We load it ourselves so a missing file just disables those layers.
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

# Required by the Copernicus Marine licence, along with each product's DOI.
COPERNICUS_CREDIT = "Generated using E.U. Copernicus Marine Service Information"


# --- Assistant ---
# The Gemini key stays on the server. No key means no assistant; nothing else breaks.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_AVAILABLE = bool(GEMINI_API_KEY)
# flash-lite with minimal thinking is ~2 s per round vs 8-13 s for flash, and picks
# the same tools.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Tried in order on rate limits or timeouts. Free-tier quota is per model.
GEMINI_FALLBACK_MODELS: tuple[str, ...] = tuple(
    m.strip()
    for m in os.environ.get(
        "GEMINI_FALLBACK_MODELS", "gemini-3.1-flash-lite,gemini-3.5-flash"
    ).split(",")
    if m.strip()
)
# "minimal" | "low" | "medium" | "high", or "" for the model's own default.
GEMINI_THINKING = os.environ.get("GEMINI_THINKING", "minimal").strip().lower()
# Give up on a slow request and try the next model.
GEMINI_TIMEOUT_SECONDS = 20.0

# SQLite so it runs on INCOIS infrastructure without a hosted database.
ASSISTANT_DB = BACKEND_ROOT / "app" / "assistant_store" / "assistant.db"

# Cached tool results. Past analyses don't change, this just saves quota.
ASSISTANT_CACHE_TTL_SECONDS = 60 * 60 * 24

# Max tool-calling rounds per message, so a confused model can't loop forever.
ASSISTANT_MAX_STEPS = 6

# Reads slower than this are reported as "still loading"; the result is cached
# for next time.
ASSISTANT_READ_BUDGET_SECONDS = 10.0
# How many previous turns we send back to the model.
ASSISTANT_HISTORY_MESSAGES = 12

# Google Search grounding for live questions. It isn't in the Gemini free tier
# (requests with the search tool get a 429), so "auto" probes once per process
# and remembers. "off" skips the probe, "on" forces it.
GEMINI_SEARCH = os.environ.get("GEMINI_SEARCH", "auto").strip().lower()


@dataclass(frozen=True)
class VariableSpec:
    """One selectable variable and how to fetch it."""

    key: str  # stable id used by the frontend
    dataset_id: str  # ERDDAP datasetID
    erddap_name: str  # variable name on the server
    label: str  # sentence case
    units: str  # normalized, display-ready
    kind: str  # "volume" | "surface" | "vector"
    colormap: str  # cmocean colormap name
    caption: str  # one-line description
    units_declared_by_us: bool = False  # True when ERDDAP doesn't give units


# --- 3D volume: 24 depth levels, 5-2000 m ---
GRID_DATASET = "incois_argo_10d_VAM"
GRID_DIMS = ("time", "ZAX", "latitude", "longitude")
GRID_SHAPE = {"ZAX": 24, "latitude": 60, "longitude": 90}
GRID_LAT_RANGE = (-29.5, 29.5)
GRID_LON_RANGE = (30.5, 119.5)
GRID_DEPTH_RANGE = (5.0, 2000.0)

# --- Argo floats ---
ARGO_DATASET = "Indian_ARGO_Floats"
# Argo QC flags: 1 = good, 2 = probably good. Float 2900757 looks like a -4 C
# cold wake but every level is QC 4, so this filter matters.
ARGO_ACCEPTED_QC = ("1", "2")

# --- Hazard fields + currents (data ends 2019-03-30) ---
VALUE_ADDED_DATASET = "incois_valueadded_products_datasets"
VALUE_ADDED_TIME_RANGE = ("2004-01-10", "2019-03-30")

# --- Chlorophyll (surface only, gaps under cloud) ---
CHLOROPHYLL_DATASET = "incois_oceansat2_datasets"


VARIABLES: tuple[VariableSpec, ...] = (
    VariableSpec(
        key="temperature",
        dataset_id=GRID_DATASET,
        erddap_name="TEMP",
        label="Temperature",
        # ERDDAP says "degs"; the standard_name and value range make it Celsius.
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
        # Speed, sqrt(u^2 + v^2).
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
    VariableSpec(
        key="wave_height",
        dataset_id="cmems_mod_glo_wav_my_0.2deg_PT3H-i",
        erddap_name="VHM0",
        label="Significant wave height",
        units="m",
        kind="surface",
        colormap="speed",
        caption="Total significant wave height from wind waves and swell.",
        units_declared_by_us=False,
    ),
    VariableSpec(
        key="ph",
        dataset_id="cmems_mod_glo_bgc-car_anfc_0.25deg_P1D-m",
        erddap_name="ph",
        label="Ocean acidity (pH)",
        units="pH",
        kind="volume",
        colormap="balance",
        caption="Potential hydrogen (pH) total scale. Monitors ocean acidification.",
        units_declared_by_us=False,
    ),
    VariableSpec(
        key="zooplankton",
        dataset_id="cmems_mod_glo_bgc_my_0.083deg-lmtl_P1D-i",
        erddap_name="zooc",
        label="Zooplankton biomass",
        units="g/m²",
        kind="surface",
        colormap="algae",
        caption="Low and mid-trophic level zooplankton carbon biomass from SEAPODYM-LMTL.",
        units_declared_by_us=False,
    ),
)


# --- Terrain ---
# ETOPO1 bedrock from NCEI's ArcGIS ImageServer (1 arc-minute, metres, positive
# on land). The old coastwatch.pfeg.noaa.gov host is gone.
TERRAIN_BASE = "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics"
TERRAIN_DATASET = "ETOPO1_bedrock"
# ETOPO1 is 1 arc-minute, so degrees * 60 = native cells.
TERRAIN_ARCMIN_PER_DEG = 60

# Wider than the analysis box so the sea carries on past the data.
TERRAIN_LAT_RANGE = (0.0, 25.0)
TERRAIN_LON_RANGE = (75.0, 100.0)

# Every 4th cell: 376 x 376 (~550 KB), plenty for the coastline.
TERRAIN_STRIDE = 4


@dataclass(frozen=True)
class Scenario:
    """A preset the demo can open on."""

    key: str
    title: str
    summary: str
    time_start: str
    time_end: str
    focus_time: str
    lat_range: tuple[float, float]
    lon_range: tuple[float, float]
    featured_platforms: tuple[str, ...] = field(default_factory=tuple)
    # Which Blue Marble month the globe uses (see frontend/scripts/fetch-textures.mjs).
    basemap: str = "october"


# Phailin is the one window where the 3D grid, the floats and the hazard fields
# all overlap (the hazard products stop in March 2019).
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
    # 2901335 shows the cold wake at the surface; 2901327 shows it at 100 m
    # (23.72 -> 20.27 C).
    featured_platforms=("2901335", "2901327", "2901334", "2901288"),
    # October to match the season.
    basemap="october",
)

SCENARIOS = {PHAILIN.key: PHAILIN}


# --- 2D map layers ---
# Separate from VariableSpec because these come from other servers, each with its
# own depth axis, cadence and axis order, and are fetched one level at a time.

MAP_ERDDAP_APDRC = "https://apdrc.soest.hawaii.edu/erddap"
MAP_ERDDAP_COASTWATCH = "https://coastwatch.noaa.gov/erddap"

# Max cells per slice. The server increases the stride to fit (400k cells = 1.6 MB).
MAX_SLICE_CELLS = 400_000
# Longer time axes get sampled instead of sent in full (HYCOM has 8034 days).
MAX_TIME_ENTRIES = 2_000

# Same budget for a whole volume. A 5 degree HYCOM chunk is ~143k cells, so it
# normally doesn't need striding.
MAX_VOLUME_CELLS = 400_000

# Chunk tile size in degrees. Clicks snap to this grid so the same click hits the
# same cache entry.
CHUNK_TILE_DEGREES = 5.0
# Argo only goes to 2000 m, so chunks stop there too.
CHUNK_MAX_DEPTH = 2000.0

# Which dataset feeds each chunk-view variable. Picked explicitly (not via
# map_dataset_for) because the chunk needs all variables on the same grid.
# INCOIS's 1 degree grid would only give 6x6 cells per chunk, so it isn't used here.
CHUNK_DATASETS: dict[str, str] = {
    "temperature": "hycom_temperature",
    "salinity": "hycom_salinity",
    # u and v are advected on the client; the scalar is hypot(u, v).
    "speed": "hycom_currents",
    # No 3D chlorophyll exists anywhere, so the chunk view turns off the depth modes.
    "chlorophyll": "incois_chlorophyll",
}


@dataclass(frozen=True)
class MapDataset:
    """A gridded product the 2D map can draw.

    axis_order is the griddap dimension order, which varies by server (HYCOM is
    time, LEV, lat, lon; VIIRS has a singleton altitude). Queries are built from it.
    """

    id: str
    base: str
    dataset_id: str
    variable: str
    label: str
    provider: str
    attribution: str
    units: str
    kind: str  # "volume" | "surface" | "vector"
    colormap: str
    caption: str
    axis_order: tuple[str, ...]
    depth_dim: str | None  # which axis is depth
    lat_dim: str = "latitude"
    lon_dim: str = "longitude"
    # Some servers store latitude north to south, and griddap wants ranges in axis
    # order, otherwise it returns 404.
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
    # "erddap" uses griddap URLs; "cmems" uses the Copernicus Marine toolbox.
    protocol: str = "erddap"
    # The VariableSpec this dataset serves. A layer is a variable, so each view can
    # pick its own best source for it.
    variable_key: str = ""
    # Lower wins when several datasets serve the same variable.
    preference: int = 100
    # Licence attribution, must be shown with the layer.
    doi: str = ""


# HYCOM GLBv0.08: global, 40 levels to 5000 m, daily. Covers the field, depth
# slider, profile, section and streamlines.
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
        # The science-quality VIIRS dataset was retired by CoastWatch. This one is
        # near-real-time with a rolling one-year window, so don't hardcode dates in it.
        # It can't cover 2013, which is why INCOIS Oceansat-2 is preferred.
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
        # altitude is a singleton, not a real depth axis.
        axis_order=("time", "altitude", "latitude", "longitude"),
        depth_dim=None,
        lat_descending=True,
        lat_range=(-89.75625, 89.75625),
        lon_range=(-180.01875, 180.01875),
        native_shape=(4788, 9602),
        # Rolling window, moves every day.
        time_range=("2025-08-07", "2026-08-12"),
        cadence="daily",
        cadence_days=1.0,
        default_stride=24,
    ),
)

MAP_DATASETS_BY_ID: dict[str, MapDataset] = {d.id: d for d in MAP_DATASETS}


# --- Copernicus Marine (GLORYS) ---
# 0.083 deg, 50 levels to 5728 m, daily, with a forecast product. No server-side
# striding and ~11 s per request, so we downsample and cache.
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
    # --- Mixed layer thickness (mlotst) ---
    # Same GLORYS product as temperature and salinity. It's one value per column,
    # so no depth axis.
    MapDataset(
        id="cmems_mixed_layer_depth",
        variable_key="mixed_layer_depth",
        preference=1,  # wins over the INCOIS regional one
        variable="mlotst",
        label="Mixed layer depth (Copernicus)",
        units="m",
        kind="surface",
        colormap="delta",
        caption=(
            "How deep the wind has stirred the ocean surface layer. "
            "Deep mixing = warm cyclone fuel; shallow = stable, stratified ocean."
        ),
        # mlotst has no depth dimension (it is a depth).
        **{**_GLORYS, "depth_dim": None,
           "axis_order": ("time", "latitude", "longitude")},
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
    # --- Wave height (WAVERYS VHM0) ---
    MapDataset(
        id="cmems_wave_height",
        variable_key="wave_height",
        preference=1,
        base="https://data.marine.copernicus.eu",
        dataset_id="cmems_mod_glo_wav_my_0.2deg_PT3H-i",
        variable="VHM0",
        label="Significant wave height (Copernicus)",
        provider="Copernicus Marine WAVERYS",
        attribution=(
            "Generated using E.U. Copernicus Marine Service Information; "
            "Global Ocean Waves Reanalysis, doi.org/10.48670/moi-00022"
        ),
        doi="10.48670/moi-00022",
        protocol="cmems",
        units="m",
        kind="surface",
        colormap="speed",
        caption=(
            "Total significant height of wind waves and swell. "
            "High values indicate severe storms and hazardous sea states."
        ),
        axis_order=("time", "latitude", "longitude"),
        depth_dim=None,
        lat_range=(-89.8, 89.8),
        lon_range=(-180.0, 179.8),
        native_shape=(899, 1800),
        time_range=("1980-01-01", "2026-09-13"),
        cadence="3-hourly",
        cadence_days=1.0,
        default_stride=2,
    ),
    # --- pH ---
    MapDataset(
        id="cmems_ph",
        variable_key="ph",
        preference=1,
        base="https://data.marine.copernicus.eu",
        dataset_id="cmems_mod_glo_bgc-car_anfc_0.25deg_P1D-m",
        variable="ph",
        label="Ocean acidity (pH)",
        provider="Copernicus Marine Biogeochemistry",
        attribution=(
            "Generated using E.U. Copernicus Marine Service Information; "
            "Global Ocean Biogeochemistry Analysis and Forecast, doi.org/10.48670/moi-00015"
        ),
        doi="10.48670/moi-00015",
        protocol="cmems",
        units="pH",
        kind="volume",
        colormap="balance",
        caption=(
            "Potential hydrogen (pH) total scale across 50 depth levels. "
            "Low values (<8.0) indicate ocean acidification stress on coral reefs and calcifying organisms."
        ),
        axis_order=("time", "depth", "latitude", "longitude"),
        depth_dim="depth",
        lat_range=(-80.0, 90.0),
        lon_range=(-180.0, 179.75),
        native_shape=(681, 1440),
        time_range=("1993-01-01", "2026-09-19"),
        cadence="daily",
        cadence_days=1.0,
        default_stride=2,
    ),
    # --- Zooplankton (SEAPODYM-LMTL zooc) ---
    MapDataset(
        id="cmems_zooplankton",
        variable_key="zooplankton",
        preference=1,
        base="https://data.marine.copernicus.eu",
        dataset_id="cmems_mod_glo_bgc_my_0.083deg-lmtl_P1D-i",
        variable="zooc",
        label="Zooplankton biomass (Copernicus)",
        provider="Copernicus Marine SEAPODYM-LMTL",
        attribution=(
            "Generated using E.U. Copernicus Marine Service Information; "
            "Global Ocean Low and Mid-Trophic Levels Biomass Hindcast, doi.org/10.48670/moi-00033"
        ),
        doi="10.48670/moi-00033",
        protocol="cmems",
        units="g/m²",
        kind="surface",
        colormap="algae",
        caption=(
            "Zooplankton carbon biomass content. Low and mid-trophic level organisms "
            "forming the base of pelagic marine food webs."
        ),
        axis_order=("time", "latitude", "longitude"),
        depth_dim=None,
        lat_range=(-80.0, 90.0),
        lon_range=(-180.0, 179.9167),
        native_shape=(2040, 4320),
        time_range=("1998-01-01", "2026-09-19"),
        cadence="daily",
        cadence_days=1.0,
        default_stride=5,
    ),
)

if COPERNICUS_AVAILABLE:
    MAP_DATASETS = MAP_DATASETS + CMEMS_DATASETS
    MAP_DATASETS_BY_ID = {d.id: d for d in MAP_DATASETS}


# Hazard fields only exist regionally, so these come straight from INCOIS
# (30.5-119.5E, +/-29.5, 1 deg, 10-daily). Nothing is drawn outside that box.
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
        # Preferred: INCOIS's own product, 0.04 deg, and the only one covering 2013.
        preference=1,
        base=ERDDAP_BASE,
        dataset_id=CHLOROPHYLL_DATASET,
        variable="CHL",
        label="Chlorophyll",
        provider="INCOIS Oceansat-2 OCM",
        attribution="INCOIS, Ministry of Earth Sciences",
        # Units come from ERDDAP here.
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
    """Best source for a variable, or None.

    Lowest preference wins. If a date is given, only sources covering that day count.
    """
    candidates = [d for d in MAP_DATASETS if d.variable_key == variable_key]
    if date:
        day = date[:10]
        candidates = [
            d for d in candidates if d.time_range[0][:10] <= day <= d.time_range[1][:10]
        ]
    return min(candidates, key=lambda d: d.preference) if candidates else None


def coverage_for(variable_key: str) -> list[tuple[str, str, str]]:
    """(provider, start, end) for each source of a variable, best first."""
    ranked = sorted(
        (d for d in MAP_DATASETS if d.variable_key == variable_key), key=lambda d: d.preference
    )
    return [(d.provider, d.time_range[0][:10], d.time_range[1][:10]) for d in ranked]
