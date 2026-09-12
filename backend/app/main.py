"""FastAPI application.

Deliberately thin. Three jobs only:
  1. Cross the CORS/TLS boundary to erddap.incois.gov.in, which the browser
     cannot cross itself.
  2. Normalize every source into the two schemas in context.md §6.
  3. Cache, so a demo never depends on venue wifi.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import CACHE_DIR, MAP_DATASETS
from .ingestion import cmems
from .routers import (
    assistant,
    catalog,
    chunk,
    field,
    instruments,
    map as map_router,
    terrain,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
)

CACHE_DIR.mkdir(parents=True, exist_ok=True)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The first Copernicus point read otherwise pays ~8 s to open the store.
    # OCEANVIZ_WARM=off skips it (tests, or a machine with no network).
    if os.environ.get("OCEANVIZ_WARM", "on").lower() != "off":
        cmems.warm_in_background(MAP_DATASETS)
    yield


app = FastAPI(
    title="INCOIS 3D Ocean Data Visualization",
    description=(
        "Co-visualization of INCOIS gridded ocean analysis and in-situ Argo "
        "observations. SIH 2026, problem statement 26067."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# Vite proxies /api in development, so this is belt-and-braces for the case
# where the frontend is served from a different origin during a demo.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
    # X-Terrain-Shape and the X-Map-* headers must be listed too: a header the
    # browser cannot read is the same as one that was never sent.
    expose_headers=[
        "X-Field-Shape",
        "X-Field-Provenance",
        "X-Terrain-Shape",
        "X-Map-Shape",
        "X-Map-Stride",
        "X-Map-Planes",
        "X-Map-Provenance",
        "X-Chunk-Shape",
        "X-Chunk-Stride",
        "X-Chunk-Planes",
        "X-Chunk-Provenance",
    ],
)

app.include_router(catalog.router, prefix="/api", tags=["catalog"])
app.include_router(field.router, prefix="/api", tags=["field"])
app.include_router(instruments.router, prefix="/api", tags=["instruments"])
app.include_router(terrain.router, prefix="/api", tags=["terrain"])
app.include_router(map_router.router, prefix="/api", tags=["map"])
app.include_router(chunk.router, prefix="/api", tags=["chunk"])
app.include_router(assistant.router, prefix="/api", tags=["assistant"])


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "INCOIS 3D Ocean Data Visualization",
        "docs": "/docs",
        "upstream": "https://erddap.incois.gov.in/erddap",
    }
