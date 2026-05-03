"""Demo source — synthetic moving aircraft, no network required.

Use when developing the frontend offline or when adsb.lol is unreachable.
Activate with FW_SOURCE=demo.

Aircraft fly in straight lines; each poll advances them along their
heading at their groundspeed for the elapsed time. They wrap when they
fly outside a generous bounding box around the station.
"""
from __future__ import annotations
import math
import time
from .base import AircraftSource


# Seed flights — chosen to cover all phase/class permutations the
# frontend cares about: cruise/climb/descent/local x civ/mil.
_SEED = [
    # callsign      type   reg       lat0    lon0    alt    gs   trk  vrate squawk
    ("UAL2456",    "B738", "N12345", 34.95, -108.40, 36000, 478,  92,    0, "4621"),
    ("SWA1102",    "B38M", "N8888SW", 33.80, -110.50, 34025, 462,  28, 1200, "3275"),
    ("N847MM",     "C208", "N847MM", 34.70, -109.90,  8500, 168, 285, -200, "1200"),
    ("DAL88",      "A321", "N301DN", 35.20, -110.80, 39000, 503, 271,    0, "5511"),
    ("AAL3204",    "B738", "N912AA", 34.05, -108.20, 37000, 488, 258, -1100, "6334"),
    ("FDX441",     "B763", "N762FD", 34.35, -111.10, 35000, 472, 263,    0, "2247"),
    ("RCH471",     "C17",  None,     34.30, -109.00, 28000, 410,  50, -100, "4677"),
    ("SNAKE21",    "F16",  None,     34.55, -108.20, 22500, 385, 265, -1500, "7400"),
]


class DemoSource(AircraftSource):
    def __init__(self, station_lat: float, station_lon: float) -> None:
        self.station_lat = station_lat
        self.station_lon = station_lon
        self._fleet = []
        for hex_idx, row in enumerate(_SEED):
            cs, t, r, lat, lon, alt, gs, trk, vrate, sq = row
            self._fleet.append({
                "hex":  f"a0{hex_idx:04x}",
                "flight": cs,
                "t":    t,
                "r":    r,
                "lat":  lat,
                "lon":  lon,
                "alt_baro":  alt,
                "gs":        gs,
                "track":     trk,
                "baro_rate": vrate,
                "squawk":    sq,
            })
        self._last_t = time.time()

    async def fetch(self) -> list[dict]:
        now = time.time()
        dt = now - self._last_t
        self._last_t = now

        out = []
        for ac in self._fleet:
            # Advance position based on track + gs (knots = NM/hr).
            # 1 deg lat ~= 60 NM; 1 deg lon ~= 60 * cos(lat) NM.
            nm_traveled = (ac["gs"] / 3600.0) * dt  # NM
            theta = math.radians(ac["track"])
            d_lat = (nm_traveled * math.cos(theta)) / 60.0
            d_lon = (nm_traveled * math.sin(theta)) / (60.0 * math.cos(math.radians(ac["lat"])))
            ac["lat"] += d_lat
            ac["lon"] += d_lon

            # Bounce / wrap if it flies more than ~3 deg from station.
            if abs(ac["lat"] - self.station_lat) > 3.0 or abs(ac["lon"] - self.station_lon) > 3.5:
                ac["track"] = (ac["track"] + 180) % 360

            # Drift altitude when climbing/descending.
            if ac["baro_rate"]:
                ac["alt_baro"] = max(0, ac["alt_baro"] + int((ac["baro_rate"] / 60.0) * dt))

            out.append({
                "hex":       ac["hex"],
                "flight":    ac["flight"],
                "lat":       round(ac["lat"], 5),
                "lon":       round(ac["lon"], 5),
                "alt_baro":  ac["alt_baro"],
                "gs":        ac["gs"],
                "track":     ac["track"],
                "baro_rate": ac["baro_rate"],
                "squawk":    ac["squawk"],
                "t":         ac["t"],
                "r":         ac["r"],
                "seen":      0.5,
            })
        return out
