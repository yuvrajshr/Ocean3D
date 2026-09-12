"""ERDDAP .nc responses must parse in memory whatever their length.

netCDF-C's in-memory reader fails on some classic buffers ("PermissionError:
Operation not permitted") depending only on the length. Small generated files
reproduce it. No network.
"""
import tempfile
from pathlib import Path

import netCDF4
import numpy as np
import pytest
import xarray as xr

from app.ingestion import erddap_grid, erddap_map


def _classic(pad: int) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "c.nc"
        with netCDF4.Dataset(path, "w", format="NETCDF3_CLASSIC") as nc:
            nc.createDimension("x", 1)
            nc.createVariable("u", "f4", ("x",))[:] = [0.76]
            nc.setncattr("pad", "a" * pad)
        return path.read_bytes()


def _hdf5() -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "h.nc"
        xr.Dataset({"u": ("x", np.array([0.76], dtype="f4"))}).to_netcdf(path, engine="netcdf4")
        return path.read_bytes()


@pytest.mark.parametrize("opener", [erddap_map._open, erddap_grid._open])
@pytest.mark.parametrize("pad", [0, 8, 300, 1000, 4100, 7991, 16300])
def test_classic_payloads_of_any_length_parse(opener, pad):
    with opener(_classic(pad)) as dset:
        assert float(dset["u"].values[0]) == pytest.approx(0.76)


@pytest.mark.parametrize("opener", [erddap_map._open, erddap_grid._open])
def test_hdf5_payloads_still_parse(opener):
    with opener(_hdf5()) as dset:
        assert float(dset["u"].values[0]) == pytest.approx(0.76)
