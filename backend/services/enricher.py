"""Enrichment: derive frontend-friendly fields from raw ADS-B records.

Adds:
    phase   "cruise" | "climb" | "descent" | "local"
    klass   "civ" | "mil"
    sym     "square" | "triangle" | "diamond"   (radar position symbol)
    callsign normalized (stripped, ICAO-style preserved)

Rules are intentionally simple. The ADS-B record's `t` field (ICAO type
designator, e.g. "B738") and `r` field (registration) carry most of what
we need. Mil detection uses two signals: known mil ICAO type prefixes
and registration patterns.
"""
from __future__ import annotations

# Common military aircraft ICAO type designators we want to flag.
# Far from exhaustive — extend as new ones turn up in the field.
_MIL_TYPES = {
    # USAF / USN transport & tanker
    "C5", "C5M", "C17", "C130", "C130J", "C135", "K35R", "KC10", "KC30",
    "KC46", "C40", "C20", "C21", "C32", "C37", "C38", "E3", "E3CF", "E3TF",
    "E4", "E6", "E8", "E2", "E2D", "P3", "P8", "VC25",
    # Fighters / attack
    "F15", "F16", "F18", "F22", "F35", "F35A", "F35B", "F35C",
    "A10", "AV8B", "EA18", "B1", "B2", "B52",
    # Helicopters
    "H60", "H64", "H47", "H53", "V22", "MV22", "CV22",
    # Trainers
    "T6", "T38", "T45", "T1",
}

# Mil callsign prefixes are reliable; reg-number patterns mostly are not
# (most US mil aircraft don't broadcast an N-number anyway). Leaving this
# empty by default and letting type+callsign do the work.
_MIL_REG_PREFIXES: tuple[str, ...] = ()


def enrich(record: dict) -> dict:
    """Return record with phase/klass/sym/callsign added (does not mutate input)."""
    out = dict(record)

    out["callsign"] = _callsign(record)
    out["klass"]    = _klass(record)
    out["phase"]    = _phase(record)
    out["sym"]      = _sym(record, out["klass"])

    return out


def _callsign(rec: dict) -> str:
    cs = rec.get("flight")
    if cs:
        return cs.upper()
    # Fallback to registration, then hex.
    return (rec.get("r") or rec.get("hex") or "").upper()


def _klass(rec: dict) -> str:
    t = (rec.get("t") or "").upper()
    if t in _MIL_TYPES:
        return "mil"
    cs = (rec.get("flight") or "").upper()
    # Common US mil callsign prefixes.
    if any(cs.startswith(p) for p in (
        "RCH", "REACH", "SAM", "AF1", "AF2", "PAT", "EVAC",
        "SNAKE", "VIPER", "EAGLE", "RAPTOR", "MAKO", "GUNNY",
        "BLUE", "ARMY", "NAVY", "MARINE", "COAST",
    )):
        return "mil"
    reg = (rec.get("r") or "").upper()
    if any(reg.startswith(p) for p in _MIL_REG_PREFIXES):
        return "mil"
    return "civ"


def _phase(rec: dict) -> str:
    """cruise / climb / descent / local.

    Local = below 10,000 ft AND under 250 kts groundspeed (rough proxy
    for aircraft operating in/near the local area, not airline traffic
    overflying at altitude).
    """
    alt = rec.get("alt_baro")
    gs  = rec.get("gs") or 0.0
    rate = rec.get("baro_rate") or 0

    # On-ground or unknown alt — treat as local.
    if alt == "ground" or alt is None:
        return "local"

    if alt < 10000 and gs < 250:
        return "local"

    if rate > 500:
        return "climb"
    if rate < -500:
        return "descent"
    return "cruise"


def _sym(rec: dict, klass: str) -> str:
    """Radar position symbol shape."""
    if klass == "mil":
        return "triangle"
    # No callsign + no type often means primary-only / VFR.
    if not rec.get("flight") and not rec.get("t"):
        return "diamond"
    return "square"
