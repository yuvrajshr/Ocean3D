"""FastAPI app.

Kept thin on purpose: it proxies ERDDAP (the browser can't, no CORS), converts
everything into our two shapes (gridded field / point profile), and caches
responses so the demo works offline.
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
    # Opening the Copernicus store takes ~8 s, so do it at startup.
    # Set OCEANVIZ_WARM=off to skip (tests, offline machines).
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

# Vite proxies /api in dev; this covers serving the frontend from another origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
    # Custom headers have to be exposed or the browser can't read them.
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
