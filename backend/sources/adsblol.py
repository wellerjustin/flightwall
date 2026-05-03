"""adsb.lol online source.

Free, public, no API key required. Compatible with the ADSBexchange v2
field schema, which is itself derived from readsb/dump1090's aircraft.json.
This is convenient: when we swap to a local SDR, the field names mostly
match and the normalization layer is thin.

Endpoint:
    GET https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}

Returns:
    {"now": <unix>, "ac": [ {hex, flight, lat, lon, alt_baro, gs, ...}, ... ]}

Reference: https://github.com/adsblol/api  (ODbL 1.0 licensed data)
"""
from __future__ import annotations
import logging
import httpx
from .base import AircraftSource

log = logging.getLogger(__name__)

# adsb.lol caps single-query distance at 250 NM, which matches our radar range.
_API = "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{dist}"


class AdsbLolSource(AircraftSource):
    def __init__(self, lat: float, lon: float, range_nm: float) -> None:
        self.lat = lat
        self.lon = lon
        self.range_nm = min(range_nm, 250.0)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(8.0),
            headers={"User-Agent": "FlightWall/1.0 (+https://github.com/wellerjustin)"},
        )

    async def fetch(self) -> list[dict]:
        url = _API.format(lat=self.lat, lon=self.lon, dist=int(self.range_nm))
        try:
            r = await self._client.get(url)
            r.raise_for_status()
            payload = r.json()
        except httpx.HTTPError as exc:
            log.warning("adsb.lol fetch failed: %s", exc)
            return []
        except ValueError as exc:
            log.warning("adsb.lol returned non-json: %s", exc)
            return []

        raw = payload.get("ac") or []
        return [self._normalize(rec) for rec in raw if rec.get("hex")]

    @staticmethod
    def _normalize(rec: dict) -> dict:
        """Trim to fields we care about. Strip whitespace from flight."""
        flight = rec.get("flight")
        if isinstance(flight, str):
            flight = flight.strip() or None

        return {
            "hex":       rec.get("hex", "").lower(),
            "flight":    flight,
            "lat":       rec.get("lat"),
            "lon":       rec.get("lon"),
            "alt_baro":  rec.get("alt_baro"),
            "gs":        rec.get("gs"),
            "track":     rec.get("track"),
            "baro_rate": rec.get("baro_rate"),
            "squawk":    rec.get("squawk"),
            "category":  rec.get("category"),
            "t":         rec.get("t"),
            "r":         rec.get("r"),
            "seen":      rec.get("seen"),
        }

    async def close(self) -> None:
        await self._client.aclose()
