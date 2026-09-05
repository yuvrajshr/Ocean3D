Good news — yes, real public APIs exist for almost everything this project needs, and one of them is INCOIS's own data server, which is a strong story for your pitch. Here's what I found:

How NASA Worldview actually works (the pattern you're copying):
Worldview is a thin client over NASA's GIBS (Global Imagery Browse Services) — a WMTS/WMS tile service. Layers are pre-rendered image tiles; the timeline works because GIBS accepts a TIME=YYYY-MM-DD parameter on each tile request. That's the mechanism behind "pick a layer, scrub a date." It's a good UX reference, but GIBS itself mostly serves 2D satellite imagery (SST, chlorophyll, imagery composites) — not full depth-resolved ocean model fields. So it's worth studying for the interaction pattern, less useful as your primary data source.

What you actually need instead — four real options:

Source	What it gives you	Access	Fit
INCOIS ERDDAP (erddap.incois.gov.in) + Live Access Server (las.incois.gov.in)	INCOIS's own model output & observations, per their public Data Holdings page	Public, no key for most datasets	Best possible fit — it's literally the target organization's own server
Copernicus Marine Service (CMEMS)	Global 3D ocean model fields — temp, salinity, currents — on 50 depth levels, updated daily, going back years	Free account required; Python Toolbox/API, WMTS, subsetting	Best source for full depth+time model data if INCOIS's own holdings are thin for your demo
Argovis API (argovis-api.colorado.edu)	Argo float profiles (temp/salinity/BGC) by location and time, JSON	Public REST API, no key	Best for instrument-overlay markers, easiest to wire up fast
Argo GDAC	Raw Argo NetCDF, the authoritative source	Public FTP/HTTPS	Backup if Argovis rate-limits or omits a field you need

On INCOIS's ERDDAP specifically — I couldn't crawl it directly (it blocks automated fetching from here), but it's listed as a live, public service on INCOIS's own Data Holdings page, alongside a Live Access Server and an "Earth System Science Data Portal." ERDDAP is a standard, well-documented protocol (used by NOAA and dozens of ocean agencies): two flavors —

griddap for gridded model output (temperature, salinity, currents by lat/lon/depth/time) — exactly your model-field schema in context.md §6.1.
tabledap for point/instrument data (Argo, buoys) — exactly your observation schema in §6.2.

Both return NetCDF, CSV, or JSON depending on the URL suffix, so your backend's xarray/pandas ingestion layer can consume them directly with minimal parsing work.

My recommendation for the build order:

Start against INCOIS's own ERDDAP/LAS — even a partial working integration with the actual target agency's data is a much stronger demo story than "we used a generic global dataset."
Use CMEMS as the fallback/supplement for full 3D coverage if INCOIS's public holdings turn out to be limited in scope or depth resolution for your demo window.
Use Argovis for the instrument-marker layer — it's the fastest to integrate (plain REST, JSON, no auth).

One thing worth doing before you commit: someone on your team should actually hit erddap.incois.gov.in in a browser and check what datasets are listed — I could see it referenced but couldn't inspect its dataset catalog directly. That'll tell you exactly which variables/depth ranges are really available versus what you'd need to backfill from CMEMS.