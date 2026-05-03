"""Dynamic airport lookup using OurAirports public-domain dataset.

Loads `airports.csv` and `runways.csv` once at import time and provides
station-relative queries: nearby airports, runways for a given airport.

Data files live in `backend/data/`. Refresh by re-downloading from
https://davidmegginson.github.io/ourairports-data/
"""
from __future__ import annotations
import csv
import math
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_AIRPORTS_CSV = _DATA_DIR / "airports.csv"
_RUNWAYS_CSV  = _DATA_DIR / "runways.csv"

_NM_PER_DEG_LAT = 60.0


# Map OurAirports types to our radar "kind"
_KIND_MAP = {
    "large_airport":  "major",
    "medium_airport": "airport",
    "small_airport":  "small",
    "heliport":       None,            # skip — too noisy on the radar
    "seaplane_base":  "seaplane",
    "closed":         None,
    "balloonport":    None,
}


# Type → max-distance (NM) at which to include. Limits clutter when zoomed out.
# At range R, we'll show: large within max(1.5*R, 250); medium within max(1.5*R, 100); small within R.
def _include_radius(kind: str, range_nm: float) -> float:
    if kind == "major":   return max(range_nm * 1.5, 250.0)
    if kind == "airport": return max(range_nm * 1.5, 100.0)
    if kind == "small":   return range_nm
    if kind == "heli":    return min(range_nm, 25.0)
    if kind == "seaplane":return min(range_nm, 50.0)
    return 0.0


def _safe_float(v) -> float | None:
    if v is None or v == "": return None
    try:
        return float(v)
    except ValueError:
        return None


def _load_airports() -> list[dict]:
    if not _AIRPORTS_CSV.exists():
        return []
    out = []
    with _AIRPORTS_CSV.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            kind = _KIND_MAP.get(row.get("type", ""))
            if kind is None:
                continue
            lat = _safe_float(row.get("latitude_deg"))
            lon = _safe_float(row.get("longitude_deg"))
            if lat is None or lon is None:
                continue
            ident = row.get("ident") or ""
            iata  = row.get("iata_code") or ""
            label = (row.get("gps_code") or row.get("local_code") or ident).upper()
            out.append({
                "id":      label,
                "icao":    ident.upper(),
                "iata":    iata.upper(),
                "name":    (row.get("name") or "").upper()[:32],
                "lat":     lat,
                "lon":     lon,
                "kind":    kind,
                "muni":    row.get("municipality") or "",
                "country": row.get("iso_country") or "",
                "elev_ft": _safe_float(row.get("elevation_ft")),
                "_id":     row.get("id"),  # internal: cross-ref with runways.csv
            })
    return out


def _load_runways() -> dict[str, list[dict]]:
    """Return {airport_ident: [runway_dict, ...]}."""
    out: dict[str, list[dict]] = {}
    if not _RUNWAYS_CSV.exists():
        return out
    with _RUNWAYS_CSV.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("closed") == "1":
                continue
            ident = (row.get("airport_ident") or "").upper()
            le_lat = _safe_float(row.get("le_latitude_deg"))
            le_lon = _safe_float(row.get("le_longitude_deg"))
            he_lat = _safe_float(row.get("he_latitude_deg"))
            he_lon = _safe_float(row.get("he_longitude_deg"))
            if None in (le_lat, le_lon, he_lat, he_lon):
                continue
            length = _safe_float(row.get("length_ft")) or 0
            width  = _safe_float(row.get("width_ft")) or 0
            out.setdefault(ident, []).append({
                "le_ident": row.get("le_ident") or "",
                "he_ident": row.get("he_ident") or "",
                "le_lat":   le_lat, "le_lon": le_lon,
                "he_lat":   he_lat, "he_lon": he_lon,
                "length_ft": length,
                "width_ft":  width,
                "surface":  row.get("surface") or "",
            })
    return out


# Loaded once at import time.
_AIRPORTS: list[dict] = _load_airports()
_RUNWAYS:  dict[str, list[dict]] = _load_runways()


def _dist_nm(s_lat: float, s_lon: float, lat: float, lon: float) -> float:
    nm_per_deg_lon = _NM_PER_DEG_LAT * math.cos(math.radians(s_lat))
    dx = (lon - s_lon) * nm_per_deg_lon
    dy = (lat - s_lat) * _NM_PER_DEG_LAT
    return math.hypot(dx, dy)


# Per-kind caps. Kept low so the screen stays readable. "major" is special —
# we always include up to 3 off-screen for the edge-arrow indicator.
_KIND_CAPS = {
    "major":    8,    # in-range + off-screen majors combined
    "airport":  6,
    "small":    8,
    "heli":     3,
    "seaplane": 2,
}
_OFF_SCREEN_MAJORS_CAP = 3


def nearby(s_lat: float, s_lon: float, range_nm: float) -> list[dict]:
    """Return airports near the station with `dist_nm` populated.

    - In-range airports of every type are kept (capped per kind).
    - Off-screen majors: only the closest few are returned for the arrow indicator.
    - Off-screen non-majors are dropped (would never render).
    """
    if not _AIRPORTS:
        return []
    in_range_by_kind: dict[str, list[dict]] = {}
    off_majors: list[dict] = []
    for ap in _AIRPORTS:
        kind = ap["kind"]
        if kind not in _KIND_CAPS:
            continue
        d = _dist_nm(s_lat, s_lon, ap["lat"], ap["lon"])
        rec = {**ap, "dist_nm": round(d, 1)}
        if d <= range_nm:
            in_range_by_kind.setdefault(kind, []).append(rec)
        elif kind == "major" and d <= 250.0:
            off_majors.append(rec)
    result: list[dict] = []
    for kind, items in in_range_by_kind.items():
        items.sort(key=lambda x: x["dist_nm"])
        result.extend(items[:_KIND_CAPS[kind]])
    off_majors.sort(key=lambda x: x["dist_nm"])
    result.extend(off_majors[:_OFF_SCREEN_MAJORS_CAP])
    return result


def runways_for(icao_ident: str) -> list[dict]:
    """Return runway records for a given ICAO ident (e.g. 'KSJN')."""
    return _RUNWAYS.get(icao_ident.upper(), [])
