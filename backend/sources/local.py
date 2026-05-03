"""Local readsb / tar1090 / dump1090-fa source.

Placeholder for the future RTL-SDR receiver. readsb exposes
aircraft.json over a local HTTP port (typically 8754 for tar1090,
or 8080 if you go bare dump1090-fa). The schema is identical to
adsb.lol because adsb.lol IS readsb under the hood — so the
normalizer is the same with one extra field (rssi).

To activate:
    1. Install readsb on the Pi:
         curl -L https://adsb.lol/feed.sh | sudo bash
    2. Verify aircraft.json is reachable:
         curl http://localhost:8754/data/aircraft.json
    3. In config.py set:  SOURCE = "local"
    4. Restart the FastAPI service.
"""
from __future__ import annotations
import logging
import httpx
from .base import AircraftSource

log = logging.getLogger(__name__)


class LocalReadsbSource(AircraftSource):
    def __init__(self, url: str) -> None:
        self.url = url
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(3.0))

    async def fetch(self) -> list[dict]:
        try:
            r = await self._client.get(self.url)
            r.raise_for_status()
            payload = r.json()
        except httpx.HTTPError as exc:
            log.warning("local readsb fetch failed: %s", exc)
            return []
        except ValueError as exc:
            log.warning("local readsb returned non-json: %s", exc)
            return []

        raw = payload.get("aircraft") or payload.get("ac") or []
        return [self._normalize(rec) for rec in raw if rec.get("hex")]

    @staticmethod
    def _normalize(rec: dict) -> dict:
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
            "rssi":      rec.get("rssi"),  # local-only signal strength
        }

    async def close(self) -> None:
        await self._client.aclose()
