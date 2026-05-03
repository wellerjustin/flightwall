"""Lat/lon → radar percentage coordinates.

The radar pane uses a 0..100 percent coordinate system in both axes,
with the station at (50, 50). Distance is scaled so that the outer
range ring (RANGE_NM) sits at radius 46 percent — matching the
SVG geometry in the frontend.

We use an equirectangular projection centered on the station. At 250 NM
range and the latitudes we care about (mid-North America), the error
versus a proper great-circle / azimuthal-equidistant projection is well
under a pixel — fine for a wall display.
"""
from __future__ import annotations
import math
from ..config import settings

# Outer ring sits at 46% radius in the SVG (see flightwall-final.html).
# Anything beyond RANGE_NM gets clipped to the ring edge.
_RING_PCT = 46.0

# Nautical miles per degree of latitude (constant) and per degree of
# longitude (varies with cos(lat)).
_NM_PER_DEG_LAT = 60.0


def project(lat: float, lon: float) -> tuple[float, float] | None:
    """Return (x_pct, y_pct) in 0..100, or None if missing inputs."""
    if lat is None or lon is None:
        return None

    s_lat = settings.STATION_LAT
    s_lon = settings.STATION_LON
    nm_per_deg_lon = _NM_PER_DEG_LAT * math.cos(math.radians(s_lat))

    dx_nm = (lon - s_lon) * nm_per_deg_lon          # +east
    dy_nm = (lat - s_lat) * _NM_PER_DEG_LAT          # +north

    # Scale so RANGE_NM == _RING_PCT
    scale = _RING_PCT / settings.RANGE_NM
    x_pct = 50.0 + dx_nm * scale
    y_pct = 50.0 - dy_nm * scale  # invert: SVG y grows downward

    # Clip to a slightly-inside-the-ring circle so labels still fit.
    dx, dy = x_pct - 50.0, y_pct - 50.0
    r = math.hypot(dx, dy)
    max_r = _RING_PCT - 1.0
    if r > max_r:
        scale_clip = max_r / r
        x_pct = 50.0 + dx * scale_clip
        y_pct = 50.0 + dy * scale_clip

    return (x_pct, y_pct)


def distance_nm(lat: float, lon: float) -> float | None:
    """Great-circle-ish distance from station to (lat, lon) in NM.
    Same equirectangular approximation used for projection."""
    if lat is None or lon is None:
        return None
    s_lat = settings.STATION_LAT
    s_lon = settings.STATION_LON
    nm_per_deg_lon = _NM_PER_DEG_LAT * math.cos(math.radians(s_lat))
    dx_nm = (lon - s_lon) * nm_per_deg_lon
    dy_nm = (lat - s_lat) * _NM_PER_DEG_LAT
    return math.hypot(dx_nm, dy_nm)


def project_history(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Project a list of (lat, lon) points; drop any that fail."""
    out: list[tuple[float, float]] = []
    for lat, lon in points:
        p = project(lat, lon)
        if p is not None:
            out.append(p)
    return out
