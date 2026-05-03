from __future__ import annotations
from ..config import settings
from .base import AircraftSource
from .adsblol import AdsbLolSource
from .local import LocalReadsbSource
from .demo import DemoSource


def make_source() -> AircraftSource:
    """Pick the source based on config.SOURCE."""
    if settings.SOURCE == "local":
        return LocalReadsbSource(url=settings.LOCAL_URL)
    if settings.SOURCE == "adsblol":
        return AdsbLolSource(
            lat=settings.STATION_LAT,
            lon=settings.STATION_LON,
            range_nm=settings.RANGE_NM,
        )
    if settings.SOURCE == "demo":
        return DemoSource(
            station_lat=settings.STATION_LAT,
            station_lon=settings.STATION_LON,
        )
    raise ValueError(f"Unknown SOURCE: {settings.SOURCE!r} (use 'adsblol', 'local', or 'demo')")
