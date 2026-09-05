"""Seafloor and land relief from NOAA ETOPO1.

A second upstream, on a different server, behind the same `DataSource` shape as
the INCOIS sources. That is the point as much as the pixels are: the problem
statement asks for an architecture that accepts new sensors and products with
minimal change, and this is the first chance to show that rather than claim it.

Physically this is one surface. ETOPO's `altitude` is positive on land and
negative at sea, so the Eastern Ghats, the Indian coastline and the floor of the
Bay of Bengal all come from a single grid and render as a single mesh — which is
what they are.
"""

from __future__ import annotations

import struct

import numpy as np

from .. import erddap_client as client
from ..config import (
    TERRAIN_ARCMIN_PER_DEG,
    TERRAIN_BASE,
    TERRAIN_DATASET,
    TERRAIN_LAT_RANGE,
    TERRAIN_LON_RANGE,
    TERRAIN_STRIDE,
)
from ..models.schemas import SourceStatus


class TerrainResult:
    """Elevation in metres on a regular lat/lon grid, C order (lat, lon)."""

    __slots__ = ("elevation", "lats", "lons", "source")

    def __init__(
        self,
        elevation: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        source: SourceStatus,
    ) -> None:
        self.elevation = elevation
        self.lats = lats
        self.lons = lons
        self.source = source


# ArcGIS returns an uncompressed, tiled, single-band Float32 GeoTIFF. That is a
# narrow enough shape to read with struct + numpy, which is why this adds no
# dependency: Pillow/rasterio would be a large install for ~40 lines of header.
_TIFF_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
_TIFF_TYPE_CODE = {1: "B", 3: "H", 4: "I", 6: "b", 8: "h", 9: "i", 11: "f", 12: "d"}


def _tiff_tags(payload: bytes, endian: str) -> dict[int, list[int]]:
    offset = struct.unpack(endian + "I", payload[4:8])[0]
    count = struct.unpack(endian + "H", payload[offset : offset + 2])[0]
    tags: dict[int, list[int]] = {}
    for i in range(count):
        entry = offset + 2 + i * 12
        tag, kind, n = struct.unpack(endian + "HHI", payload[entry : entry + 8])
        size = _TIFF_TYPE_SIZE.get(kind, 1) * n
        if size <= 4:
            raw = payload[entry + 8 : entry + 8 + size]
        else:
            at = struct.unpack(endian + "I", payload[entry + 8 : entry + 12])[0]
            raw = payload[at : at + size]
        code = _TIFF_TYPE_CODE.get(kind)
        if code is None:
            continue
        tags[tag] = list(struct.unpack(endian + code * n, raw))
    return tags


def _decode_geotiff(payload: bytes) -> np.ndarray:
    """Single-band Float32 GeoTIFF to a (row, col) array, north-up as stored."""
    if payload[:2] not in (b"II", b"MM"):
        raise ValueError("terrain response is not a TIFF (upstream may have returned an error page)")
    endian = "<" if payload[:2] == b"II" else ">"
    tags = _tiff_tags(payload, endian)

    width, height = tags[256][0], tags[257][0]
    if tags.get(259, [1])[0] != 1:
        raise ValueError("terrain TIFF is compressed; expected uncompressed")
    if tags.get(339, [3])[0] != 3 or tags.get(258, [32])[0] != 32:
        raise ValueError("terrain TIFF is not 32-bit float")

    image = np.full((height, width), np.nan, dtype=np.float32)
    if 324 in tags:  # tiled
        tw, th = tags[322][0], tags[323][0]
        across = (width + tw - 1) // tw
        for k, at in enumerate(tags[324]):
            tile = np.frombuffer(payload, dtype=endian + "f4", count=tw * th, offset=at)
            tile = tile.reshape(th, tw)
            r0, c0 = (k // across) * th, (k % across) * tw
            rows, cols = min(th, height - r0), min(tw, width - c0)
            if rows > 0 and cols > 0:
                image[r0 : r0 + rows, c0 : c0 + cols] = tile[:rows, :cols]
    else:  # stripped
        parts = [
            np.frombuffer(payload, dtype=endian + "f4", count=n // 4, offset=at)
            for at, n in zip(tags[273], tags[279])
        ]
        image = np.concatenate(parts)[: width * height].reshape(height, width)
    return image


def fetch_relief(
    *,
    lat_range: tuple[float, float] = TERRAIN_LAT_RANGE,
    lon_range: tuple[float, float] = TERRAIN_LON_RANGE,
    stride: int = TERRAIN_STRIDE,
) -> TerrainResult:
    lat0, lat1 = sorted(lat_range)
    lon0, lon1 = sorted(lon_range)

    # The old ERDDAP transport subsampled with a stride; ArcGIS resamples to a
    # requested pixel size instead. Deriving the size from the stride keeps the
    # callers' units unchanged: stride 4 over a 25 deg box is still ~376 px.
    n_lon = max(2, round((lon1 - lon0) * TERRAIN_ARCMIN_PER_DEG / max(1, stride)))
    n_lat = max(2, round((lat1 - lat0) * TERRAIN_ARCMIN_PER_DEG / max(1, stride)))

    url = (
        f"{TERRAIN_BASE}/{TERRAIN_DATASET}/ImageServer/exportImage"
        f"?bbox={lon0},{lat0},{lon1},{lat1}&bboxSR=4326&imageSR=4326"
        f"&size={n_lon},{n_lat}&pixelType=F32"
        f"&noDataInterpretation=esriNoDataMatchAny&format=tiff&f=image"
    )
    payload, source = client.fetch(url)
    image = _decode_geotiff(payload)

    # ArcGIS returns the image north-up (row 0 is the northern edge). Every
    # consumer here expects latitude ascending, as ERDDAP served it, so flip
    # once at the boundary rather than making the mesh builder care.
    elevation = np.flipud(image).astype(np.float32)
    lats = np.linspace(lat0, lat1, elevation.shape[0], dtype=np.float32)
    lons = np.linspace(lon0, lon1, elevation.shape[1], dtype=np.float32)

    # ETOPO has no gaps, but a NaN reaching the vertex shader would tear a hole
    # in the mesh, so anything non-finite is pinned to sea level. ArcGIS also
    # marks no-data with a large negative sentinel rather than NaN.
    elevation = np.where(np.isfinite(elevation) & (elevation > -1e30), elevation, 0.0)
    return TerrainResult(
        elevation=np.ascontiguousarray(elevation, dtype=np.float32),
        lats=lats,
        lons=lons,
        source=source,
    )


def summarize(result: TerrainResult) -> dict[str, float | int]:
    """Numbers the frontend needs to scale and shade the mesh."""
    elevation = result.elevation
    land = elevation > 0
    return {
        "min_elevation": float(elevation.min()),
        "max_elevation": float(elevation.max()),
        "land_fraction": float(land.mean()),
        "n_lat": int(elevation.shape[0]),
        "n_lon": int(elevation.shape[1]),
    }
