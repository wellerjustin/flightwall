"""In-memory aircraft state + rolling track history.

Holds the current snapshot of every aircraft in range, plus the last N
positions for each so the frontend can draw track polylines.

Stale aircraft (no update for AIRCRAFT_TIMEOUT seconds) are evicted on
the next ingest pass.
"""
from __future__ import annotations
import time
from collections import deque
from typing import Deque
from ..config import settings


class _Track:
    """One aircraft's most recent record + a deque of (lat, lon, alt) points.

    Altitude is preserved per point so the frontend can color each segment
    of the trail by the altitude the aircraft was at when it was there.
    """
    __slots__ = ("record", "history", "first_seen", "last_update")

    def __init__(self, record: dict, now: float) -> None:
        self.record = record
        self.history: Deque[tuple[float, float, float | None]] = deque(maxlen=settings.TRACK_HISTORY)
        self.first_seen = now
        self.last_update = now
        if record.get("lat") is not None and record.get("lon") is not None:
            self.history.append((record["lat"], record["lon"], record.get("alt_baro")))

    def update(self, record: dict, now: float) -> None:
        self.record = record
        self.last_update = now
        lat, lon = record.get("lat"), record.get("lon")
        if lat is None or lon is None:
            return
        # Don't append if the position hasn't actually moved (cuts noise).
        if self.history and (self.history[-1][0], self.history[-1][1]) == (lat, lon):
            return
        self.history.append((lat, lon, record.get("alt_baro")))


class Tracker:
    def __init__(self) -> None:
        self._aircraft: dict[str, _Track] = {}

    def ingest(self, records: list[dict]) -> None:
        now = time.time()
        seen_hexes: set[str] = set()
        for rec in records:
            hx = rec.get("hex")
            if not hx:
                continue
            seen_hexes.add(hx)
            track = self._aircraft.get(hx)
            if track is None:
                self._aircraft[hx] = _Track(rec, now)
            else:
                track.update(rec, now)
        self._evict_stale(now)

    def _evict_stale(self, now: float) -> None:
        timeout = settings.AIRCRAFT_TIMEOUT
        stale = [hx for hx, t in self._aircraft.items()
                 if now - t.last_update > timeout]
        for hx in stale:
            del self._aircraft[hx]

    def snapshot(self) -> list[dict]:
        """Return a list of current aircraft, each with its track history."""
        out: list[dict] = []
        for t in self._aircraft.values():
            out.append({
                "record": t.record,
                "history": list(t.history),
                "first_seen": t.first_seen,
                "last_update": t.last_update,
            })
        return out

    def __len__(self) -> int:
        return len(self._aircraft)
