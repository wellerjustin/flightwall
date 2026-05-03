"""Abstract data source.

Both the online (adsb.lol) and future local (readsb) adapters return the
same normalized record shape. Everything downstream — tracker, enricher,
projector, frontend — knows nothing about which source is feeding it.

A normalized record is a dict with these keys (all optional except hex):

    hex      str   ICAO 24-bit hex identifier, lowercase  (REQUIRED)
    flight   str   callsign, e.g. "UAL2456"   (stripped, may be None)
    lat      float decimal degrees
    lon      float decimal degrees
    alt_baro int   barometric altitude in feet, or "ground"
    gs       float groundspeed in knots
    track    float ground track in degrees true
    baro_rate int  vertical rate ft/min (positive = climbing)
    squawk   str   4-digit transponder code
    category str   ADS-B emitter category (e.g. "A3")
    t        str   aircraft ICAO type designator (e.g. "B738")
    r        str   registration (e.g. "N12345")
    seen     float seconds since last message
    rssi     float signal strength dBFS (local source only)
"""
from __future__ import annotations
from abc import ABC, abstractmethod


class AircraftSource(ABC):
    """Pull aircraft within range of the station."""

    @abstractmethod
    async def fetch(self) -> list[dict]:
        """Return a list of normalized aircraft records."""
        ...

    async def close(self) -> None:
        """Release any held resources (HTTP client, file handles)."""
        return None
