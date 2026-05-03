"""Central configuration. All knobs live here.

Override any value via env vars: FW_STATION_LAT=34.5 etc.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FW_", env_file=".env")

    # --- station ---
    STATION_LAT: float = 34.579211        # Concho, AZ
    STATION_LON: float = -109.619175
    STATION_NAME: str = "KP13"
    STATION_TZ: str = "America/Phoenix"

    # --- radar ---
    RANGE_NM: float = 250.0               # outer ring + clipping radius

    # --- data source ---
    # "adsblol"  -> public adsb.lol API (default, no key)
    # "local"    -> a local readsb/tar1090 aircraft.json
    SOURCE: str = "adsblol"
    LOCAL_URL: str = "http://localhost:8754/data/aircraft.json"
    POLL_INTERVAL: float = 2.0            # seconds between source polls

    # --- tracking ---
    TRACK_HISTORY: int = 60               # max position points kept per aircraft
    AIRCRAFT_TIMEOUT: float = 60.0        # drop aircraft not heard from in this many sec
    MAX_AIRCRAFT: int = 75                # render at most this many (closest to station)

    # --- server ---
    HOST: str = "0.0.0.0"
    PORT: int = 8080


settings = Settings()
