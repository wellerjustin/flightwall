"""FastAPI entrypoint.

- Spawns a background poller that pulls from the configured AircraftSource
  every POLL_INTERVAL seconds and feeds the Tracker.
- Serves /api/aircraft for the frontend.
- Serves /api/station (GET) for radar geometry constants.
- Serves /api/station (POST) to mutate station name/lat/lon/range at runtime.
- Mounts the frontend at /.
"""
from __future__ import annotations
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import settings
from .sources import make_source
from .services.tracker import Tracker
from .services.enricher import enrich
from .services.projector import project, project_history, distance_nm, bearing_deg
from .services import airports as airports_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("flightwall")

# Module-level state.
TRACKER = Tracker()
START_TIME = time.time()
LAST_POLL_OK: float | None = None
LAST_POLL_ERR: str | None = None

# Holds the live source + its background task so settings changes can swap them.
_source_state: dict = {"source": None, "task": None}
_source_lock = asyncio.Lock()


async def _poller(source) -> None:
    global LAST_POLL_OK, LAST_POLL_ERR
    log.info("poller starting; source=%s interval=%.1fs", settings.SOURCE, settings.POLL_INTERVAL)
    while True:
        try:
            records = await source.fetch()
            TRACKER.ingest(records)
            LAST_POLL_OK = time.time()
            LAST_POLL_ERR = None
            log.debug("poll: %d aircraft, %d tracked", len(records), len(TRACKER))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LAST_POLL_ERR = str(exc)
            log.exception("poller error: %s", exc)
        await asyncio.sleep(settings.POLL_INTERVAL)


async def _start_source() -> None:
    """Build a source from current settings and start its poller task."""
    src = make_source()
    task = asyncio.create_task(_poller(src))
    _source_state["source"] = src
    _source_state["task"] = task


async def _stop_source() -> None:
    """Cancel current poller and close source. Safe to call repeatedly."""
    task = _source_state.get("task")
    src = _source_state.get("source")
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    if src:
        await src.close()
    _source_state["source"] = None
    _source_state["task"] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _start_source()
    try:
        yield
    finally:
        await _stop_source()
        log.info("poller stopped")


app = FastAPI(title="FlightWall", lifespan=lifespan)


class StationUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=8)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    range_nm: float | None = Field(default=None, gt=0, le=250)


def _station_dict() -> dict:
    return {
        "name": settings.STATION_NAME,
        "lat": settings.STATION_LAT,
        "lon": settings.STATION_LON,
        "tz": settings.STATION_TZ,
        "range_nm": settings.RANGE_NM,
        "source": settings.SOURCE,
    }


@app.get("/api/station")
async def station() -> dict:
    """Static radar/station info for the frontend to render labels."""
    return _station_dict()


@app.post("/api/station")
async def update_station(update: StationUpdate) -> dict:
    """Mutate station settings and restart the data source.

    Persists in memory only — restarting the backend reverts to env / config defaults.
    """
    async with _source_lock:
        if update.name is not None:
            settings.STATION_NAME = update.name
        if update.lat is not None:
            settings.STATION_LAT = update.lat
        if update.lon is not None:
            settings.STATION_LON = update.lon
        if update.range_nm is not None:
            settings.RANGE_NM = update.range_nm
        # Restart source so the new lat/lon/range take effect on next poll.
        await _stop_source()
        # Wipe tracker — old aircraft positions were projected against the old origin.
        global TRACKER
        TRACKER = Tracker()
        await _start_source()
        log.info("station updated: %s", _station_dict())
    return _station_dict()


@app.get("/api/landmarks")
async def landmarks() -> dict:
    """Airports near the current station, dynamically queried from
    the OurAirports dataset. Re-fetched by the frontend whenever the
    station/range changes."""
    nearby = airports_db.nearby(
        settings.STATION_LAT, settings.STATION_LON, settings.RANGE_NM
    )
    out = []
    for ap in nearby:
        pos = project(ap["lat"], ap["lon"])
        if pos is None:
            continue
        b = bearing_deg(ap["lat"], ap["lon"])
        out.append({
            **ap,
            "x": pos[0], "y": pos[1],
            "bearing_deg": round(b, 1) if b is not None else None,
        })
    return {"landmarks": out, "range_nm": settings.RANGE_NM}


@app.get("/api/runways/{icao}")
async def runways(icao: str) -> dict:
    """Runway endpoints + width for a given airport, projected to radar coords."""
    out = []
    for rw in airports_db.runways_for(icao):
        le = project(rw["le_lat"], rw["le_lon"])
        he = project(rw["he_lat"], rw["he_lon"])
        if le is None or he is None:
            continue
        out.append({
            **rw,
            "le_x": le[0], "le_y": le[1],
            "he_x": he[0], "he_y": he[1],
        })
    return {"icao": icao.upper(), "runways": out}


@app.get("/api/aircraft")
async def aircraft() -> JSONResponse:
    """Live aircraft snapshot. The single endpoint the frontend calls."""
    snap = TRACKER.snapshot()
    out: list[dict] = []
    for entry in snap:
        rec = enrich(entry["record"])
        pos = project(rec.get("lat"), rec.get("lon"))
        if pos is None:
            continue  # no usable position yet — skip rendering this turn
        dist = distance_nm(rec.get("lat"), rec.get("lon"))
        out.append({
            "hex":      rec["hex"],
            "callsign": rec["callsign"],
            "type":     rec.get("t"),
            "reg":      rec.get("r"),
            "alt":      rec.get("alt_baro"),
            "gs":       rec.get("gs"),
            "track":    rec.get("track"),
            "vrate":    rec.get("baro_rate"),
            "squawk":   rec.get("squawk"),
            "klass":    rec["klass"],
            "phase":    rec["phase"],
            "sym":      rec["sym"],
            "x":        pos[0],
            "y":        pos[1],
            "dist_nm":  round(dist, 1) if dist is not None else None,
            "history":  project_history(entry["history"]),
            "first_seen":  entry["first_seen"],
            "last_update": entry["last_update"],
        })

    # Limit to closest N aircraft (sorted by squared distance from radar center).
    total_in_range = len(out)
    if total_in_range > settings.MAX_AIRCRAFT:
        out.sort(key=lambda a: (a["x"] - 50.0) ** 2 + (a["y"] - 50.0) ** 2)
        out = out[: settings.MAX_AIRCRAFT]

    return JSONResponse({
        "now": time.time(),
        "uptime": time.time() - START_TIME,
        "tracked": len(out),
        "in_range": total_in_range,
        "last_poll_ok":  LAST_POLL_OK,
        "last_poll_err": LAST_POLL_ERR,
        "aircraft": out,
    })


# Static frontend at /.
_frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if _frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
