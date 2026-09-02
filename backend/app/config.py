"""Dataset facts for the INCOIS ERDDAP server.

Every value here was read off the live server (``/info/{id}/index.json``) rather
than assumed, because getting a dimension name or a unit wrong silently produces
a plausible-looking but wrong picture. See context.md §10.
"""

from __future__ import annotations

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
TERRAIN_BASE = "https://coastwatch.pfeg.noaa.gov/erddap"
TERRAIN_DATASET = "etopo180"

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
