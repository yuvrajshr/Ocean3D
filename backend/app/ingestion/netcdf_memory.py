"""Open an ERDDAP .nc response in memory, with padding so netCDF-C can read it.

netCDF-C reads classic headers in fixed-size chunks and can read past the end
of the buffer. From a file that's fine; from memory it fails with EPERM
("Operation not permitted"). It depends on the payload length, so it looks
random. Appending 8 KB of zeros fixes it (the header gives every variable's
offset, so the padding is never read as data). HDF5 payloads are left alone.
"""

from __future__ import annotations

import netCDF4
import xarray as xr

_PAD = b"\0" * 8192
_CLASSIC_MAGIC = b"CDF"


def open_in_memory(payload: bytes, name: str = "inmemory.nc") -> xr.Dataset:
    if payload[:3] == _CLASSIC_MAGIC:
        payload = payload + _PAD
    nc = netCDF4.Dataset(name, mode="r", memory=payload)
    return xr.open_dataset(xr.backends.NetCDF4DataStore(nc))
