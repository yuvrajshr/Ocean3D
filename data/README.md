# Sample data

Real INCOIS data, downloaded from `https://erddap.incois.gov.in/erddap` by
`backend/snapshot_fixtures.py`. Nothing here is synthesized.

The window is Cyclone Phailin, 1-25 October 2013, over the Bay of Bengal
(5.0-23.0°N, 78.0-95.0°E).

- `sample_netcdf/` — CF-1.6 NetCDF from griddap: the gridded temperature and
  salinity analysis (24 levels, 5-2000 m) for the three model runs bracketing
  landfall on 12 October, plus the value-added hazard fields and chlorophyll.
- `sample_instruments/` — Argo profiles from tabledap, **with quality flags
  intact and nothing filtered**. Filtering happens at ingestion so the raw
  record stays inspectable; see `backend/app/ingestion/erddap_argo.py`.

Regenerate with `cd backend && .venv/Scripts/python snapshot_fixtures.py`.
