================================================================================
  FLIGHTWALL
  A live ATC-style flight tracking display for Concho, AZ.
================================================================================

Pulls ADS-B aircraft data from a configurable source (default: adsb.lol —
free, no API key) and renders it as a green ATC radar with full FAA-style
3-line datablocks, color-coded track polylines, and a brutalist
flip-board departures list.

Designed to run on a Raspberry Pi 4 in Chromium kiosk mode against an
HDMI display, but works anywhere with Python 3.10+ and a browser.

Provisioned for a future RTL-SDR receiver upgrade — swap one config
value and the entire stack runs against a local readsb feed instead of
the public API. No frontend changes needed.


================================================================================
  QUICK START (Pop!_OS / Linux dev box)
================================================================================

1. Unzip the project somewhere convenient:

       unzip flightwall.zip
       cd flightwall

2. Create a virtualenv and install dependencies:

       python3 -m venv backend/.venv
       source backend/.venv/bin/activate
       pip install -r backend/requirements.txt

3. Run in DEMO mode first (no network needed — synthetic moving aircraft):

       FW_SOURCE=demo uvicorn backend.app:app --host 0.0.0.0 --port 8080

   Then open http://localhost:8080 in any browser.
   You should see 8 demo aircraft moving across the radar.

4. Switch to LIVE data when ready:

       FW_SOURCE=adsblol uvicorn backend.app:app --host 0.0.0.0 --port 8080

   Same URL. Real aircraft within 250 NM of Concho will appear.


================================================================================
  CONFIGURATION
================================================================================

All settings live in backend/config.py and can be overridden with env
vars prefixed FW_*.

  FW_SOURCE          adsblol | local | demo            (default: adsblol)
  FW_STATION_LAT     decimal degrees                   (default: 34.4612)
  FW_STATION_LON     decimal degrees                   (default: -109.6052)
  FW_STATION_NAME    short name shown at radar center  (default: KP13)
  FW_STATION_TZ      IANA tz for the clock             (default: America/Phoenix)
  FW_RANGE_NM        outer radar ring                  (default: 250)
  FW_LOCAL_URL       readsb aircraft.json URL          (default: localhost:8754)
  FW_POLL_INTERVAL   seconds between source polls      (default: 2.0)
  FW_TRACK_HISTORY   max points kept per aircraft      (default: 60)
  FW_AIRCRAFT_TIMEOUT seconds before evicting stale ac (default: 60)
  FW_HOST            bind address                      (default: 0.0.0.0)
  FW_PORT            bind port                         (default: 8080)

The settings gear (top right of the UI) lets you change Station Name,
Lat, Lon, and Range at runtime. Changes are kept in memory only —
restarting the backend reverts to env / config.py defaults. To make
changes permanent, set the FW_* env vars in your service file.


================================================================================
  PROJECT LAYOUT
================================================================================

  flightwall/
    README.txt                  -- this file
    backend/
      app.py                    -- FastAPI: poller + /api endpoints + static
      config.py                 -- Settings (env-overridable)
      requirements.txt
      sources/
        base.py                 -- AircraftSource abstract base
        adsblol.py              -- adsb.lol online source (default)
        local.py                -- local readsb / SDR source (future use)
        demo.py                 -- synthetic moving aircraft (offline dev)
      services/
        tracker.py              -- in-memory aircraft + track history
        enricher.py             -- phase + civ/mil + radar symbol type
        projector.py            -- lat/lon -> 0..100% radar coords
    frontend/
      index.html                -- locked UI design with render hooks
      app.js                    -- polls /api/aircraft, rebuilds the UI
    scripts/
      dev_seed.py               -- one-shot adsb.lol pull to a JSON sample
    deploy/
      flightwall.service        -- systemd unit for the backend


================================================================================
  RASPBERRY PI DEPLOYMENT
================================================================================

Tested on Raspberry Pi OS 64-bit (Bookworm) on a Pi 4 with HDMI display.

1. Copy the project to the Pi:

       scp -r flightwall pi@<pi-ip>:/home/pi/

2. SSH in, install dependencies:

       ssh pi@<pi-ip>
       cd /home/pi/flightwall
       python3 -m venv backend/.venv
       source backend/.venv/bin/activate
       pip install -r backend/requirements.txt
       deactivate

3. Install the backend systemd unit:

       sudo cp deploy/flightwall.service /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl enable --now flightwall.service

4. Set up the kiosk autostart (labwc / Wayland on Bookworm desktop):

       sudo tee /etc/xdg/labwc/autostart >/dev/null <<'EOF'
       (
         until curl -sf http://localhost:8080/api/station >/dev/null; do sleep 1; done
         chromium-browser --kiosk --noerrdialogs --disable-infobars \
           --disable-translate --disable-features=TranslateUI \
           --check-for-update-interval=31536000 \
           --app=http://localhost:8080
       ) &
       EOF

   For X11 / LXDE-pi sessions, the same command goes in
   /etc/xdg/lxsession/LXDE-pi/autostart prefixed with `@`.

5. Edit station coordinates / range / cap if needed:

       sudo systemctl edit flightwall.service
       # or directly edit /etc/systemd/system/flightwall.service

   To check it's working:

       systemctl status flightwall
       journalctl -u flightwall -f


================================================================================
  UPGRADING TO A LOCAL ADS-B RECEIVER (RTL-SDR)
================================================================================

When you get a dongle (NooElec NESDR Smart v5 ~$35) and a 1090 MHz
antenna (FlightAware band-pass + outdoor blade ~$50):

1. Plug the SDR into the Pi.

2. Install readsb (the modern fork of dump1090) plus the adsb.lol feed
   client, which sets up readsb and the 1090 MHz decoder for you:

       curl -L -o /tmp/lol-feed.sh https://adsb.lol/feed.sh
       sudo bash /tmp/lol-feed.sh

   You'll be prompted for your station's lat / lon / elevation. While
   you're at it, you'll also be feeding adsb.lol — no obligation, but
   they're the API you've been using, so it's a fair trade.

3. Verify the local feed is up:

       curl http://localhost:8754/data/aircraft.json | head

   You should see JSON with an "aircraft" array.

4. Switch FlightWall to the local source:

       sudo systemctl edit flightwall.service
       # add or change:
       #   Environment="FW_SOURCE=local"
       sudo systemctl restart flightwall.service

   The frontend doesn't need to change. The radar will now show
   aircraft your dongle is hearing directly, with sub-second latency
   instead of polling a remote API.


================================================================================
  WHAT THE RADAR SHOWS
================================================================================

  Position symbols:
    SQUARE     ADS-B equipped commercial / GA aircraft
    TRIANGLE   Military aircraft
    DIAMOND    Primary-only / VFR (no callsign + no type)

  Datablock (3 lines):
    Line 1   Callsign            e.g. "UAL2456", "RCH471"
    Line 2   TYPE · REG          e.g. "B738 · N12345"
    Line 3   FL ALT ARROW GS     e.g. "360 ↑ 478"  (FL360, climbing, 478 kt)

  Phase colors (radar + flight list):
    TEAL     cruise   (level flight at altitude)
    AMBER    climb    (vertical rate > 500 fpm up)
    RUST     descent  (vertical rate > 500 fpm down)
    CREAM    local    (below 10,000 ft AND under 250 kt)

  Track lines: thin colored polylines showing each aircraft's recent
  history, color-matched to phase. The endpoint of each line is the
  aircraft's current position.

  Sector boundaries: dashed lines split the radar into ARTCC sectors
  (Albuquerque ZAB, Denver ZDV, LA ZLA — the centers covering northern
  Arizona). MOAs (Reserve, Sells) shown as red hatched polygons.


================================================================================
  TROUBLESHOOTING
================================================================================

* "Source: OFFLINE" in the corner
  --> Backend is unreachable. Check `systemctl status flightwall`.

* No aircraft appear
  --> Check the backend log (`journalctl -u flightwall -f`). If you're
      on the adsblol source and seeing 4xx errors, you may be rate
      limited; raise FW_POLL_INTERVAL to 5 or 10.

* Settings save fails
  --> Most likely an invalid lat/lon. Both must be valid decimal
      degrees within bounds (-90..90 / -180..180).

* Kiosk doesn't auto-launch on the Pi
  --> Verify the graphical target is reached before the kiosk service
      starts. Check `systemctl status flightwall-kiosk` — if it's
      restarting in a loop, the backend probably isn't up yet. The
      kiosk unit waits up to ~30 sec for /api/station before launching;
      if your boot is slower, edit the ExecStartPre line.

* Wrong font / display issues
  --> First load needs internet for Google Fonts (Bebas Neue,
      JetBrains Mono). If the Pi has no internet on first boot,
      Chromium will fall back to system fonts. Consider downloading
      the font files and serving them locally for full offline use.


================================================================================
  LICENSE / CREDITS
================================================================================

Aircraft data via adsb.lol (ODbL 1.0). adsb.lol is community-funded by
volunteer feeders — if you end up running an SDR, point it at them.

Built with FastAPI, httpx, Pydantic. No frontend framework — vanilla
HTML/CSS/JS.
