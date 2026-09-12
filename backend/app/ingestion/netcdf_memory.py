"""Open an ERDDAP .nc answer in memory, padded so netCDF-C can read all of it.

netCDF-C reads a classic (netCDF3) header in fixed-size chunks and asks for a
whole chunk beyond its current position even at the header's end. Reading from
disk, a short read past end-of-file is harmless; reading from memory it fails
with EPERM, which surfaces as "PermissionError: Operation not permitted". So a
payload fails when its header ends within a chunk of the buffer's end — i.e.
depending only on its length and header layout, which is why it looked
intermittent: a current's u at one HYCOM cell (4904 bytes) failed on 2026-09-10
while the temperature at the same cell (4780 bytes) did not.

Measured over 1937 generated classic files of every header/data shape: 206 fail
unpadded, none fail with 4096 zero bytes appended. We append 8192 for margin. A
classic header states every variable's offset and size, so trailing zeros are
never read as data. HDF5 payloads keep their own end-of-file bookkeeping and are
left untouched.
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
