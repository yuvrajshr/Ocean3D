"""Snapshot the Cyclone Phailin demo window from INCOIS ERDDAP into data/.

The runtime disk cache already keeps the demo alive without a network, but that
cache is machine-local and disposable. These fixtures are the committed,
reproducible copy: real CF-1.6 NetCDF and real Argo JSON, so the repository
carries the demo's data rather than only a pointer to it.

    cd backend && .venv/Scripts/python snapshot_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

from app import erddap_client as client
from app.config import (
    ARGO_DATASET,
    CHLOROPHYLL_DATASET,
    FIXTURE_DIR,
    GRID_DATASET,
    PHAILIN,
    VALUE_ADDED_DATASET,
)

NETCDF_DIR = FIXTURE_DIR / "sample_netcdf"
INSTRUMENT_DIR = FIXTURE_DIR / "sample_instruments"

# The three model runs that bracket landfall on 12 October 2013.
TIMESTEPS = ["2013-09-30", "2013-10-10", "2013-10-20"]

LAT = PHAILIN.lat_range
LON = PHAILIN.lon_range


def save(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    print(f"  {path.relative_to(FIXTURE_DIR.parent)}  {len(payload) / 1024:,.1f} KB")


def main() -> None:
    print("Gridded analysis (temperature + salinity, all 24 depth levels):")
    for stamp in TIMESTEPS:
        query = (
            f"TEMP[({stamp}T00:00:00Z)][][({LAT[0]}):({LAT[1]})][({LON[0]}):({LON[1]})],"
            f"SAL[({stamp}T00:00:00Z)][][({LAT[0]}):({LAT[1]})][({LON[0]}):({LON[1]})]"
        )
        payload, source = client.fetch(client.griddap_url(GRID_DATASET, query, fmt="nc"))
        save(NETCDF_DIR / f"incois_argo_vam_{stamp}.nc", payload)
        print(f"      ({source.provenance})")

    print("\nHazard fields and currents (value-added product):")
    for stamp in ["2013-10-10"]:
        variables = ["D26", "HTCNT", "MLD", "GEO_U", "GEO_V"]
        query = ",".join(
            f"{v}[({stamp}T00:00:00Z)][({LAT[0]}):({LAT[1]})][({LON[0]}):({LON[1]})]"
            for v in variables
        )
        payload, _ = client.fetch(client.griddap_url(VALUE_ADDED_DATASET, query, fmt="nc"))
        save(NETCDF_DIR / f"incois_value_added_{stamp}.nc", payload)

    print("\nChlorophyll (Oceansat-2, cloud-gapped):")
    query = (
        f"CHL[(2013-10-10T00:00:00Z)][({LAT[0]}):({LAT[1]})][({LON[0]}):({LON[1]})]"
    )
    payload, _ = client.fetch(client.griddap_url(CHLOROPHYLL_DATASET, query, fmt="nc"))
    save(NETCDF_DIR / "incois_oceansat2_chl_2013-10-10.nc", payload)

    print("\nArgo profiles for the whole Phailin window (raw, QC flags intact):")
    columns = [
        "PLATFORM_NUMBER", "CYCLE_NUMBER", "time", "latitude", "longitude",
        "PRES", "PRES_ADJUSTED", "TEMP", "TEMP_ADJUSTED", "PSAL", "PSAL_ADJUSTED",
        "PRES_QC", "TEMP_QC", "PSAL_QC",
    ]
    constraints = [
        f"time>={PHAILIN.time_start}T00:00:00Z",
        f"time<={PHAILIN.time_end}T23:59:59Z",
        f"latitude>={LAT[0]}", f"latitude<={LAT[1]}",
        f"longitude>={LON[0]}", f"longitude<={LON[1]}",
    ]
    payload, _ = client.fetch(client.tabledap_url(ARGO_DATASET, columns, constraints))
    save(INSTRUMENT_DIR / "indian_argo_floats_phailin_2013-10.json", payload)

    doc = json.loads(payload)
    rows = doc["table"]["rows"]
    names = doc["table"]["columnNames"]
    platforms = {r[names.index("PLATFORM_NUMBER")] for r in rows}
    qc_index = names.index("TEMP_QC")
    good = sum(1 for r in rows if str(r[qc_index]).strip() in ("1", "2"))
    print(
        f"\n  {len(rows):,} levels from {len(platforms)} floats; "
        f"{good:,} pass QC, {len(rows) - good:,} rejected."
    )

    (FIXTURE_DIR / "README.md").write_text(
        "# Sample data\n\n"
        "Real INCOIS data, downloaded from `https://erddap.incois.gov.in/erddap` by\n"
        "`backend/snapshot_fixtures.py`. Nothing here is synthesized.\n\n"
        "The window is Cyclone Phailin, 1-25 October 2013, over the Bay of Bengal\n"
        f"({LAT[0]}-{LAT[1]}°N, {LON[0]}-{LON[1]}°E).\n\n"
        "- `sample_netcdf/` — CF-1.6 NetCDF from griddap: the gridded temperature and\n"
        "  salinity analysis (24 levels, 5-2000 m) for the three model runs bracketing\n"
        "  landfall on 12 October, plus the value-added hazard fields and chlorophyll.\n"
        "- `sample_instruments/` — Argo profiles from tabledap, **with quality flags\n"
        "  intact and nothing filtered**. Filtering happens at ingestion so the raw\n"
        "  record stays inspectable; see `backend/app/ingestion/erddap_argo.py`.\n\n"
        "Regenerate with `cd backend && .venv/Scripts/python snapshot_fixtures.py`.\n",
        encoding="utf-8",
    )
    print(f"\nWrote {FIXTURE_DIR / 'README.md'}")


if __name__ == "__main__":
    main()
