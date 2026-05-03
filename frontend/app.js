/**
 * FlightWall renderer.
 *
 * Polls /api/aircraft on a fixed interval and rebuilds the radar overlay
 * (target symbols + leader lines + datablocks + track polylines) plus the
 * departures board. The static pieces of the radar (range rings, sectors,
 * MOAs, airports) are baked into index.html and don't move.
 *
 * The backend computes lat/lon -> radar percentage coordinates, so the
 * frontend just plots {x, y} in 0..100. Trade-off: easier here, fewer
 * places to keep projection math in sync.
 */

(() => {
  "use strict";

  const POLL_MS = 2000;     // matches backend POLL_INTERVAL by default
  const CLOCK_MS = 1000;
  const STALE_MS = 30000;   // banner the connection if no good poll in 30s
  const ALERT_NM = 10;      // proximity alert ring (NM from station)

  // DOM handles
  const $ = (id) => document.getElementById(id);
  const els = {
    targets:  $("targetsLayer"),
    tracks:   $("trackSvg"),
    board:    $("board"),
    clock:    $("clock"),
    src:      $("srcLabel"),
    stTracked: $("stTracked"),
    stMil:     $("stMil"),
    stMaxFl:   $("stMaxFl"),
    stMaxSpd:  $("stMaxSpd"),
    tkTracked: $("tkTracked"),
    tkMil:     $("tkMil"),
    tkUptime:  $("tkUptime"),
    brandStation: $("brandStation"),
    gearBtn:   $("gearBtn"),
    modal:     $("settingsModal"),
    modalClose:$("settingsClose"),
    modalCancel:$("settingsCancel"),
    modalSave: $("settingsSave"),
    setName:   $("setName"),
    setCoords: $("setCoords"),
    setRange:  $("setRange"),
    setSource: $("setSource"),
    zoomIn:    $("zoomIn"),
    zoomOut:   $("zoomOut"),
    zoomReadout: $("zoomReadout"),
    rangeLabel:  $("rangeLabel"),
    radarSection: document.querySelector(".radar-section"),
    alertBanner: $("alertBanner"),
    alertBody:   $("alertBody"),
    alertClose:  $("alertClose"),
    alertToggle: $("alertToggle"),
    dataToggle:  $("dataToggle"),
    trackToggle: $("trackToggle"),
  };

  let tracksEnabled = (localStorage.getItem("fw_tracks") ?? "1") === "1";
  function syncTrackToggleUI() {
    if (!els.trackToggle) return;
    els.trackToggle.classList.toggle("on",  tracksEnabled);
    els.trackToggle.classList.toggle("off", !tracksEnabled);
    els.trackToggle.title = tracksEnabled ? "Tracks: ON (click to hide trails)" : "Tracks: OFF (click to show trails)";
  }

  // Datablock visibility — persisted, plus a single-aircraft selection
  // (visible only when datablocks are otherwise hidden).
  let dataEnabled = (localStorage.getItem("fw_data") ?? "1") === "1";
  let selectedHex = null;
  function syncDataToggleUI() {
    if (!els.dataToggle) return;
    els.dataToggle.classList.toggle("on",  dataEnabled);
    els.dataToggle.classList.toggle("off", !dataEnabled);
    els.dataToggle.title = dataEnabled ? "Datablocks: ON  (click to hide; click an aircraft to isolate)"
                                       : "Datablocks: OFF (click an aircraft to show its data)";
    if (els.targets) els.targets.classList.toggle("data-off", !dataEnabled);
  }

  // Proximity alerts on/off — persisted in localStorage.
  let alertsEnabled = (localStorage.getItem("fw_alerts") ?? "1") === "1";
  function syncAlertToggleUI() {
    if (!els.alertToggle) return;
    els.alertToggle.classList.toggle("on",  alertsEnabled);
    els.alertToggle.classList.toggle("off", !alertsEnabled);
    els.alertToggle.title = alertsEnabled ? "Proximity alerts: ON (click to disable)" : "Proximity alerts: OFF (click to enable)";
  }

  // Tracks which aircraft (by hex) are currently flagged as in-zone
  // so we only banner-alert on first entry.
  const inAlertZone = new Set();
  let alertDismissedHex = null;
  let alertHideTimer = null;

  function showAlert(a) {
    if (!els.alertBanner) return;
    const phase = phaseLabel(a.phase);
    const klass = a.klass === "mil" ? "MILITARY" : "CIVILIAN";
    const fl = fmtAlt(a.alt);
    const gs = fmtSpd(a.gs);
    const idLine = a.reg ? `${a.type || "----"} · ${a.reg}` : (a.type || "----");
    els.alertBody.innerHTML = `
      <div class="ab-row"><span>FLIGHT</span><b>${a.callsign || "——"}</b></div>
      <div class="ab-row"><span>TYPE / REG</span><b>${idLine}</b></div>
      <div class="ab-row"><span>CLASS</span><b>${klass}</b></div>
      <div class="ab-row"><span>FL · GS</span><b>${fl} · ${gs} kt</b></div>
      <div class="ab-row"><span>DIST</span><b>${a.dist_nm != null ? a.dist_nm.toFixed(1) + " NM" : "---"}</b></div>
      <div class="ab-row"><span>PHASE</span><b>${phase}</b></div>
    `;
    els.alertBanner.classList.add("show");
    if (alertHideTimer) clearTimeout(alertHideTimer);
    alertHideTimer = setTimeout(() => els.alertBanner.classList.remove("show"), 12000);
  }

  function hideAlert() {
    if (els.alertBanner) els.alertBanner.classList.remove("show");
  }

  // Zoom presets (NM). Mouse wheel and buttons step through these.
  const ZOOM_STEPS = [2, 5, 10, 25, 50, 100, 150, 250];

  function nearestStep(nm) {
    let best = ZOOM_STEPS[0], dBest = Infinity;
    for (const s of ZOOM_STEPS) {
      const d = Math.abs(s - nm);
      if (d < dBest) { dBest = d; best = s; }
    }
    return ZOOM_STEPS.indexOf(best);
  }

  let zoomBusy = false;
  async function setRangeNm(newRange) {
    if (zoomBusy) return;
    if (newRange === station.range_nm) return;
    zoomBusy = true;
    try {
      const r = await fetch("/api/station", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({range_nm: newRange}),
      });
      if (r.ok) {
        station = await r.json();
        updateRangeUI();
        loadLandmarks();
      }
    } catch (e) { /* offline, ignore */ }
    finally { zoomBusy = false; }
  }
  function updateRangeUI() {
    const nm = Math.round(station.range_nm || 0);
    if (els.zoomReadout) els.zoomReadout.textContent = `${nm} NM`;
    if (els.rangeLabel)  els.rangeLabel.textContent  = nm;
    drawRangeTicks(nm);
    loadRunways();
  }

  // Render scale labels on the 090 (east) bearing line — amber, scaled to current range.
  // Rings sit at 0.2, 0.4, 0.6, 0.8, 1.0 of the outer ring radius (460 in viewBox 1000x1000).
  function drawRangeTicks(rangeNm) {
    const layer = document.getElementById("rangeTicks");
    if (!layer || !rangeNm) return;
    const rings = [0.2, 0.4, 0.6, 0.8, 1.0];
    let svg = "";
    for (const frac of rings) {
      const x = 500 + 460 * frac;
      const y = 492;  // sit just above the 090 line
      const nm = Math.round(rangeNm * frac);
      const label = (frac === 1.0) ? `${nm} NM` : `${nm}`;
      svg += `<text x="${x + 6}" y="${y}">${label}</text>`;
    }
    layer.innerHTML = svg;
  }
  function zoomBy(delta) {
    const idx = nearestStep(station.range_nm || 50);
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + delta));
    setRangeNm(ZOOM_STEPS[next]);
  }

  // --- station info ---
  let station = { tz: "America/Phoenix", source: "---", range_nm: 250 };

  async function loadStation() {
    try {
      const r = await fetch("/api/station");
      if (r.ok) station = await r.json();
      els.src.textContent = `SOURCE: ${station.source.toUpperCase()}`;
      updateStationLabel();
      updateRangeUI();
    } catch (e) {
      els.src.textContent = "SOURCE: OFFLINE";
    }
  }

  function updateStationLabel() {
    if (!els.brandStation) return;
    const lat = station.lat?.toFixed(4) ?? "--";
    const lon = station.lon?.toFixed(4) ?? "--";
    const ns  = (station.lat ?? 0) >= 0 ? "N" : "S";
    const ew  = (station.lon ?? 0) >= 0 ? "E" : "W";
    els.brandStation.textContent = `${station.name} · ${Math.abs(lat)}°${ns} · ${Math.abs(lon)}°${ew}`;
  }

  // --- settings modal ---
  function openSettings() {
    els.setName.value = station.name || "";
    const lat = station.lat ?? "";
    const lon = station.lon ?? "";
    els.setCoords.value = (lat !== "" && lon !== "") ? `${lat}, ${lon}` : "";
    els.setRange.value = station.range_nm ?? 250;
    els.setSource.value = station.source || "adsblol";
    els.modal.classList.add("open");
  }
  function closeSettings() { els.modal.classList.remove("open"); }

  // Parse a Google-Maps style coordinate string: "34.579211, -109.619175"
  // Also tolerates spaces, semicolons, parens, N/S/E/W suffixes.
  function parseCoords(str) {
    if (!str) return null;
    const cleaned = str.replace(/[()°]/g, " ").trim();
    // Split on comma, semicolon, or whitespace
    const parts = cleaned.split(/[,;\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    let lat = parseFloat(parts[0]);
    let lon = parseFloat(parts[1]);
    // Handle hemisphere letters if present (e.g. "34.5 N, 109.6 W")
    const has = (s, c) => parts.includes(c) || parts.some(p => p.toUpperCase().endsWith(c));
    if (has(parts, "S") || /S$/i.test(parts[0])) lat = -Math.abs(lat);
    if (has(parts, "W") || /W$/i.test(parts[1])) lon = -Math.abs(lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  async function saveSettings() {
    const coords = parseCoords(els.setCoords.value);
    if (!coords) {
      alert("Coordinates must be in 'lat, lon' format (e.g. 34.579211, -109.619175).");
      return;
    }
    const body = {
      name: els.setName.value.trim() || station.name,
      lat:  coords.lat,
      lon:  coords.lon,
      range_nm: parseFloat(els.setRange.value),
    };
    if (!isFinite(body.range_nm)) {
      alert("Range must be a valid number.");
      return;
    }
    try {
      const r = await fetch("/api/station", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      station = await r.json();
      updateStationLabel();
      loadLandmarks();
      closeSettings();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
  }

  // --- helpers ---
  function fmtAlt(a) {
    if (a === null || a === undefined) return "---";
    if (a === "ground") return "GND";
    return Math.round(a / 100).toString().padStart(3, "0");  // FL hundreds
  }
  function fmtAltCommas(a) {
    if (a === null || a === undefined) return "---";
    if (a === "ground") return "GROUND";
    return a.toLocaleString();
  }
  function fmtSpd(s) {
    if (s === null || s === undefined) return "---";
    return Math.round(s);
  }
  function vrateArrow(v) {
    if (v === null || v === undefined) return "→";
    if (v >  500) return "↑";
    if (v < -500) return "↓";
    return "→";
  }
  function phaseLabel(p) {
    return ({cruise:"CRUISE", climb:"CLIMB", descent:"DESCENT", local:"LOCAL"}[p] || "---");
  }
  // Phase-based coloring: green climb, yellow descent, blue cruise/level, grey ground.
  function phaseColor(phase) {
    if (phase === "climb")   return "#40ff80";  // green
    if (phase === "descent") return "#ffd840";  // yellow
    if (phase === "cruise")  return "#4aa8ff";  // blue
    if (phase === "local")   return "#cccccc";  // grey-cream
    return "#aaaaaa";
  }
  // Backwards-compat alias used elsewhere in the file.
  function altColor(altOrPhase) {
    // If a phase string slipped in, use it directly.
    if (typeof altOrPhase === "string") return phaseColor(altOrPhase);
    return phaseColor("cruise");
  }
  // Derive a per-segment phase from a pair of altitudes (oldest, newest).
  function segPhase(altOld, altNew) {
    const a0 = typeof altOld === "number" ? altOld : null;
    const a1 = typeof altNew === "number" ? altNew : null;
    if (a0 === null || a1 === null) return "cruise";
    const d = a1 - a0;
    if (d > 100)  return "climb";
    if (d < -100) return "descent";
    return "cruise";
  }

  // Phase icons. SVG so they line up cleanly and inherit phase color via currentColor.
  // Resolves: climb / descent / cruise (level) / ground.
  function phaseIcon(a) {
    // "ground" overrides phase if alt is 0/missing AND speed is low
    const onGround = (a.alt === "ground") || (typeof a.alt === "number" && a.alt < 100 && (a.gs ?? 999) < 50);
    const phase = onGround ? "ground" : a.phase;
    const stroke = "currentColor";
    const sw = 1.8;
    const ICONS = {
      climb:   `<polyline points="2,12 7,4 11,8 15,2" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/><polyline points="11,2 15,2 15,6" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`,
      descent: `<polyline points="2,4 7,12 11,8 15,14" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/><polyline points="11,14 15,14 15,10" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`,
      cruise:  `<line x1="2" y1="8" x2="14" y2="8" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/><polygon points="14,8 11,5 11,11" fill="${stroke}"/>`,
      local:   `<line x1="2" y1="8" x2="14" y2="8" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/><polygon points="14,8 11,5 11,11" fill="${stroke}"/>`,
      ground:  `<rect x="2" y="11" width="12" height="2" fill="${stroke}"/><polygon points="3,9 13,9 11,4 5,4" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`,
    };
    const path = ICONS[phase] || ICONS.cruise;
    return `<svg viewBox="0 0 16 16" width="16" height="16" style="vertical-align:middle">${path}</svg>`;
  }
  function classLabel(k) { return k === "mil" ? "MIL" : "CIV"; }

  // Aircraft symbol = directional triangle.
  // Apex points up at 0deg → rotate by track heading (0=N, 90=E, etc.) to
  // make the apex point in the actual direction of travel.
  // Mil aircraft get a filled triangle so they pop on the scope.
  function aircraftSymbol(klass, trackDeg) {
    const rot = (typeof trackDeg === "number") ? trackDeg : 0;
    const fill = klass === "mil" ? "currentColor" : "none";
    return `<svg viewBox="0 0 14 14" style="transform: rotate(${rot}deg);"><polygon points="7,1 12,12 7,9.5 2,12" fill="${fill}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  }

  // --- render: radar targets ---
  function renderTargets(aircraft) {
    const frag = document.createDocumentFragment();
    const presentInZone = new Set();
    for (const a of aircraft) {
      const div = document.createElement("div");
      const isAlert = alertsEnabled && (typeof a.dist_nm === "number") && a.dist_nm <= ALERT_NM;
      if (isAlert) {
        presentInZone.add(a.hex);
        if (!inAlertZone.has(a.hex) && alertDismissedHex !== a.hex) {
          showAlert(a);
        }
      }
      const isSelected = (a.hex === selectedHex);
      const ac = phaseColor(a.phase);
      div.className = `target ${a.phase}` + (a.klass === "mil" ? " mil" : "") + (isAlert ? " alert" : "") + (isSelected ? " selected" : "");
      div.dataset.hex = a.hex;
      if (!isAlert) {
        div.style.color = ac;
        div.style.setProperty("--ac-color", ac);
      }
      div.style.top  = `${a.y}%`;
      div.style.left = `${a.x}%`;

      // Build line 3: "FL ↕ GS"
      const fl = fmtAlt(a.alt);
      const arr = vrateArrow(a.vrate);
      const gs = fmtSpd(a.gs);

      // L2: type + registration
      const type = a.type || "----";
      const reg  = a.reg  || "";
      const idLine = reg ? `${type} · ${reg}` : type;

      div.innerHTML = `
        <div class="sym">${aircraftSymbol(a.klass, a.track)}</div>
        <div class="db" style="left:14px;top:-32px;">
          <div class="l1">${a.callsign}</div>
          <div class="l2">${idLine}</div>
          <div class="l3">${fl} ${arr} ${gs}</div>
        </div>
      `;
      frag.appendChild(div);
    }
    els.targets.replaceChildren(frag);
    // Sync the alert-zone set: drop hexes that left the zone.
    for (const hex of inAlertZone) {
      if (!presentInZone.has(hex)) inAlertZone.delete(hex);
    }
    for (const hex of presentInZone) inAlertZone.add(hex);
    if (alertDismissedHex && !presentInZone.has(alertDismissedHex)) {
      alertDismissedHex = null;
    }
  }

  // --- render: track polylines (SVG) ---
  // Each segment colored by the altitude the aircraft was at when it was there.
  // History entries are (x_pct, y_pct, alt). Older backends sent (x, y) pairs;
  // we fall back to current-altitude color for those.
  function renderTracks(aircraft) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const frag = document.createDocumentFragment();
    if (!tracksEnabled) { els.tracks.replaceChildren(frag); return; }
    for (const a of aircraft) {
      if (!a.history || a.history.length < 2) continue;
      const h = a.history;
      for (let i = 1; i < h.length; i++) {
        const p0 = h[i - 1], p1 = h[i];
        const altOld = (p0.length >= 3) ? p0[2] : null;
        const altNew = (p1.length >= 3) ? p1[2] : null;
        const phase = segPhase(altOld, altNew);
        const stroke = phaseColor(phase);
        const seg = document.createElementNS(SVG_NS, "line");
        seg.setAttribute("x1", p0[0].toFixed(2));
        seg.setAttribute("y1", p0[1].toFixed(2));
        seg.setAttribute("x2", p1[0].toFixed(2));
        seg.setAttribute("y2", p1[1].toFixed(2));
        seg.setAttribute("stroke", stroke);
        seg.setAttribute("stroke-width", "1.4");
        seg.setAttribute("stroke-linecap", "round");
        seg.setAttribute("vector-effect", "non-scaling-stroke");
        // Older segments fade.
        const ageOpacity = 0.35 + 0.65 * (i / h.length);
        seg.setAttribute("stroke-opacity", ageOpacity.toFixed(2));
        frag.appendChild(seg);
      }
    }
    els.tracks.replaceChildren(frag);
  }

  // --- render: departures board ---
  function renderBoard(aircraft) {
    // Sort: closest to station first. Backend already capped to MAX_AIRCRAFT
    // by distance, but re-sort here defensively in case of out-of-order data.
    const rows = [...aircraft].sort((a, b) => {
      const aa = typeof a.dist_nm === "number" ? a.dist_nm : 99999;
      const bb = typeof b.dist_nm === "number" ? b.dist_nm : 99999;
      return aa - bb;
    });
    const frag = document.createDocumentFragment();
    for (const a of rows) {
      const row = document.createElement("div");
      row.className = "row";
      row.style.color = phaseColor(a.phase);
      const opType = a.type ? a.type : "---";
      const dist   = (typeof a.dist_nm === "number") ? `${a.dist_nm.toFixed(1)}<span class="u"> NM</span>` : "---";
      row.innerHTML = `
        <div class="col-flight">${a.callsign}</div>
        <div class="col-route">${dist}</div>
        <div class="col-alt">${fmtAltCommas(a.alt)}<span class="u">FT</span></div>
        <div class="col-spd">${fmtSpd(a.gs)}<span class="u">KT</span></div>
        <div class="col-type">${opType} · ${a.reg || "---"}</div>
        <div class="col-class ${a.klass === "mil" ? "mil" : ""}">${classLabel(a.klass)}</div>
        <div class="status ${a.phase}"><span class="phase-ico">${phaseIcon(a)}</span>${phaseLabel(a.phase)}</div>
      `;
      frag.appendChild(row);
    }
    els.board.replaceChildren(frag);
  }

  // --- render: stats panel + ticker ---
  function renderStats(payload) {
    const ac = payload.aircraft;
    const n = ac.length;

    let maxFL = 0;
    let maxSpd = 0;
    let mil = 0;
    for (const a of ac) {
      if (typeof a.alt === "number" && a.alt > maxFL) maxFL = a.alt;
      if (typeof a.gs  === "number" && a.gs  > maxSpd) maxSpd = a.gs;
      if (a.klass === "mil") mil++;
    }

    els.stTracked.innerHTML = `${n} <small>active</small>`;
    els.stMil.innerHTML     = `${mil} <small>aircraft</small>`;
    els.stMaxFl.textContent = maxFL ? Math.round(maxFL / 100).toString() : "---";
    els.stMaxSpd.innerHTML  = `${Math.round(maxSpd)} <small>kts</small>`;

    els.tkTracked.textContent = `${n} ACTIVE`;
    els.tkMil.textContent     = `${mil} ACTIVE`;
    els.tkUptime.textContent  = `RECEIVING SINCE ${fmtUptime(payload.uptime)}`;
  }

  function fmtUptime(secs) {
    if (!secs) return "---";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h.toString().padStart(2,"0")}h`;
    if (h > 0) return `${h}h ${m.toString().padStart(2,"0")}m`;
    return `${m}m`;
  }

  // --- clock (station local time) ---
  function tickClock() {
    if (!els.clock) return;
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: station.tz, hour12: false,
        hour: "2-digit", minute: "2-digit",
      });
      const tzAbbr = station.tz.split("/").pop().slice(0, 3).toUpperCase();
      els.clock.textContent = `${fmt.format(now)} ${tzAbbr}`;
    } catch {
      els.clock.textContent = "--:-- ---";
    }
  }

  // --- main poll loop ---
  let lastOk = 0;
  async function poll() {
    try {
      const r = await fetch("/api/aircraft", { cache: "no-store" });
      if (!r.ok) throw new Error(r.statusText);
      const payload = await r.json();
      renderTargets(payload.aircraft);
      renderTracks(payload.aircraft);
      renderBoard(payload.aircraft);
      renderStats(payload);
      lastOk = Date.now();
    } catch (e) {
      console.warn("poll failed:", e);
      const stale = lastOk && (Date.now() - lastOk) > STALE_MS;
      if (stale && els.src) els.src.textContent = "SOURCE: STALE";
    }
  }

  // --- boot ---
  if (els.gearBtn)    els.gearBtn.addEventListener("click", openSettings);
  if (els.modalClose) els.modalClose.addEventListener("click", closeSettings);
  if (els.modalCancel)els.modalCancel.addEventListener("click", closeSettings);
  if (els.modalSave)  els.modalSave.addEventListener("click", saveSettings);
  if (els.modal)      els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.modal.classList.contains("open")) closeSettings();
  });

  // Inline SVG path for the airport icon (streamline-plump:airport-security-solid).
  // Reused for both in-range major airports and small airfields.
  const AIRPORT_ICON_PATH = "M6.313 2.803C9.111 2.185 14.371 1.5 24 1.5s14.889.685 17.687 1.303c2.453.543 3.858 2.603 4.116 4.826c.309 2.657.697 7.024.697 12.171c0 9.996-5.278 19.407-14.246 24.022C29.436 45.272 26.401 46.5 24 46.5s-5.436-1.228-8.254-2.678C6.778 39.207 1.5 29.796 1.5 19.8c0-5.147.388-9.514.697-12.171c.257-2.223 1.663-4.283 4.116-4.826m6.569 24.536A70 70 0 0 1 9.15 20.3c-.323-.715-.116-1.591.543-1.941c.209-.111.505-.287.816-.47c.554-.328 1.154-.683 1.388-.75c.338-.096.69-.017.985.185a45 45 0 0 1 3.872 3.02c1.297-.769 2.678-1.766 4.113-2.8c3.816-2.755 8.01-5.781 11.99-5.528c2.533.161 4.5 2.06 5.716 3.642c.843 1.1.372 2.666-.838 3.234C35.25 20.056 33.022 20.977 30.5 22c-.847 2.75-1.724 4.793-2.312 6.163l-.228.533c-.31.73-.796 1.356-1.46 1.71c-.13.068-.341.195-.597.348c-.733.438-1.825 1.09-2.377 1.218c-.844.194-1.501-.635-1.401-1.566a97 97 0 0 1 .711-5.298c-2.01.742-3.552 1.44-4.82 2.012c-1.061.48-1.93.873-2.723 1.133c-.908.3-1.882-.057-2.411-.914";

  function airportSvg(x, y, size, color) {
    const half = size / 2;
    return `<svg x="${(x-half).toFixed(1)}" y="${(y-half).toFixed(1)}" width="${size}" height="${size}" viewBox="0 0 48 48" overflow="visible">`
         + `<path fill="${color}" fill-rule="evenodd" clip-rule="evenodd" d="${AIRPORT_ICON_PATH}"/>`
         + `</svg>`;
  }

  // Runway overlay — only draws when range ≤ RUNWAY_VISIBLE_NM. Pulls
  // /api/runways/{icao} for each in-range airport (small concurrency).
  const RUNWAY_VISIBLE_NM = 5;
  let _runwayLastFetch = { icaos: "", range: 0 };

  async function loadRunways() {
    const layer = document.getElementById("runwayLayer");
    if (!layer) return;
    const range = station.range_nm || 50;
    if (range > RUNWAY_VISIBLE_NM) {
      layer.innerHTML = "";
      return;
    }
    try {
      const r = await fetch("/api/landmarks");
      if (!r.ok) return;
      const data = await r.json();
      // Only fetch runways for airports actually inside the range.
      const inRange = data.landmarks.filter(l =>
        (l.kind === "small" || l.kind === "airport" || l.kind === "major") &&
        typeof l.dist_nm === "number" && l.dist_nm <= range && l.icao
      );
      const icaos = inRange.map(l => l.icao).join(",");
      // Skip if nothing changed (avoids a flicker per poll).
      if (icaos === _runwayLastFetch.icaos && range === _runwayLastFetch.range) return;
      _runwayLastFetch = { icaos, range };

      const results = await Promise.all(inRange.map(async (lm) => {
        try {
          const rr = await fetch(`/api/runways/${encodeURIComponent(lm.icao)}`);
          if (!rr.ok) return null;
          return { lm, ...(await rr.json()) };
        } catch (e) { return null; }
      }));

      // ft → percent of radar = ft / 6076 NM × (46 / range_NM)
      // Then percent → viewBox units = ×10
      const ftToVB = (ft) => (ft / 6076.0) * (46.0 / range) * 10.0;
      let svg = "";
      for (const res of results) {
        if (!res) continue;
        for (const rw of res.runways) {
          // Endpoints in 0..100 percentages → viewBox 0..1000
          const x1 = rw.le_x * 10, y1 = rw.le_y * 10;
          const x2 = rw.he_x * 10, y2 = rw.he_y * 10;
          const dx = x2 - x1, dy = y2 - y1;
          const len = Math.hypot(dx, dy);
          if (len < 0.5) continue; // skip degenerate
          const wHalf = ftToVB(rw.width_ft || 100) / 2;
          // Perpendicular unit vector
          const px = -dy / len, py = dx / len;
          const c1x = x1 + px * wHalf, c1y = y1 + py * wHalf;
          const c2x = x2 + px * wHalf, c2y = y2 + py * wHalf;
          const c3x = x2 - px * wHalf, c3y = y2 - py * wHalf;
          const c4x = x1 - px * wHalf, c4y = y1 - py * wHalf;
          const fill = (rw.surface || "").toUpperCase().includes("ASPH") ? "#1a1a1a" : "#2a2417";
          svg += `<polygon points="${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${c3x.toFixed(1)},${c3y.toFixed(1)} ${c4x.toFixed(1)},${c4y.toFixed(1)}" fill="${fill}" stroke="var(--green-bright)" stroke-width="0.6" opacity="0.85"/>`;
          // Centerline dashes
          svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--green-bright)" stroke-width="0.4" stroke-dasharray="3 3" opacity="0.7"/>`;
          // Runway end labels
          const lblFs = 6;
          if (rw.le_ident) svg += `<text x="${x1.toFixed(1)}" y="${y1.toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${lblFs}" fill="var(--green-bright)" opacity="0.85">${rw.le_ident}</text>`;
          if (rw.he_ident) svg += `<text x="${x2.toFixed(1)}" y="${y2.toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${lblFs}" fill="var(--green-bright)" opacity="0.85">${rw.he_ident}</text>`;
        }
      }
      layer.innerHTML = svg;
    } catch (e) { /* offline; no runways */ }
  }

  async function loadLandmarks() {
    const layer = document.getElementById("landmarkLayer");
    if (!layer) return;
    try {
      const r = await fetch("/api/landmarks");
      if (!r.ok) return;
      const data = await r.json();
      // Convert percentage (0..100) to viewBox units (1000x1000).
      const toVB = (p) => p * 10;
      const range = data.range_nm || station.range_nm || 50;
      // Pick the 3 closest *off-screen* major airports for edge arrows.
      const offMajors = data.landmarks
        .filter(l => l.kind === "major" && typeof l.dist_nm === "number" && l.dist_nm > range)
        .sort((a, b) => a.dist_nm - b.dist_nm)
        .slice(0, 3);
      let svg = "";

      // Edge arrows for off-screen major airports — 30% opacity to match in-range icons.
      svg += `<g opacity="0.3">`;
      for (const lm of offMajors) {
        // Compute edge point: bearing 0=N, in radar viewBox center=(500,500),
        // outer ring radius 460. Convert bearing to math angle (north=up, east=right).
        const brad = (lm.bearing_deg || 0) * Math.PI / 180;
        const edgeR = 440;            // pull slightly inside outer ring
        const ex = 500 + edgeR * Math.sin(brad);
        const ey = 500 - edgeR * Math.cos(brad);
        const arrowDeg = (lm.bearing_deg || 0) - 90; // SVG default points right
        // Arrow head + label
        svg += `<g transform="translate(${ex.toFixed(1)},${ey.toFixed(1)}) rotate(${arrowDeg.toFixed(1)})">`;
        svg += `<polygon points="14,0 -4,-9 -4,9" fill="var(--amber)" opacity="0.9"/>`;
        svg += `</g>`;
        // Label sits inboard of arrow tip.
        const lblR = edgeR - 60;
        const lx = 500 + lblR * Math.sin(brad);
        const ly = 500 - lblR * Math.cos(brad);
        svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="22" font-weight="700" fill="var(--amber)" letter-spacing="2" opacity="0.95">${lm.id}</text>`;
        svg += `<text x="${lx.toFixed(1)}" y="${(ly+18).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="14" fill="var(--amber)">${Math.round(lm.dist_nm)} NM</text>`;
      }
      svg += `</g>`;

      // In-range airports — single consistent yellow/amber style at 30% opacity
      // so they sit quietly behind aircraft. Size scales by type.
      const SIZE_BY_KIND = { major: 40, airport: 32, small: 22, seaplane: 22 };
      const FONT_BY_KIND = { major: 24, airport: 22, small: 18, seaplane: 16 };
      svg += `<g opacity="0.3">`;
      for (const lm of data.landmarks) {
        const inRange = (typeof lm.dist_nm === "number") ? lm.dist_nm <= range : true;
        if (!inRange) continue; // off-screen handled above (only majors get arrows)
        const x = toVB(lm.x), y = toVB(lm.y);
        const size = SIZE_BY_KIND[lm.kind] || 24;
        const fontSize = FONT_BY_KIND[lm.kind] || 18;
        const half = size / 2;
        svg += airportSvg(x, y, size, "var(--amber)");
        svg += `<text x="${(x+half+4).toFixed(1)}" y="${(y-half+12).toFixed(1)}" font-family="JetBrains Mono, monospace" font-size="${fontSize}" font-weight="700" fill="var(--amber)">${lm.id}</text>`;
      }
      svg += `</g>`;
      layer.innerHTML = svg;
    } catch (e) { /* offline; no overlay */ }
  }

  if (els.trackToggle) {
    syncTrackToggleUI();
    els.trackToggle.addEventListener("click", () => {
      tracksEnabled = !tracksEnabled;
      localStorage.setItem("fw_tracks", tracksEnabled ? "1" : "0");
      syncTrackToggleUI();
      // Clear immediately if turning off; next poll redraws if on.
      if (!tracksEnabled && els.tracks) els.tracks.replaceChildren(document.createDocumentFragment());
    });
  }

  if (els.dataToggle) {
    syncDataToggleUI();
    els.dataToggle.addEventListener("click", () => {
      dataEnabled = !dataEnabled;
      localStorage.setItem("fw_data", dataEnabled ? "1" : "0");
      // Turning data ON clears any single-aircraft isolation.
      if (dataEnabled) selectedHex = null;
      syncDataToggleUI();
    });
  }
  // Click any aircraft to isolate its datablock (works regardless of toggle —
  // when data is on, click toggles the brighter "selected" highlight).
  if (els.targets) {
    els.targets.addEventListener("click", (e) => {
      const t = e.target.closest(".target");
      if (!t) return;
      const hex = t.dataset.hex;
      selectedHex = (selectedHex === hex) ? null : hex;
      // Force a re-render of selection state on the next tick;
      // poll() will rebuild and apply the new .selected class.
      // Update immediately so the user sees feedback without waiting 2s.
      els.targets.querySelectorAll(".target").forEach(el => {
        el.classList.toggle("selected", el.dataset.hex === selectedHex);
      });
    });
  }

  if (els.alertToggle) {
    syncAlertToggleUI();
    els.alertToggle.addEventListener("click", () => {
      alertsEnabled = !alertsEnabled;
      localStorage.setItem("fw_alerts", alertsEnabled ? "1" : "0");
      syncAlertToggleUI();
      if (!alertsEnabled) {
        hideAlert();
        inAlertZone.clear();
        alertDismissedHex = null;
      }
    });
  }

  if (els.alertClose) {
    els.alertClose.addEventListener("click", () => {
      // Remember the most-recent in-zone target so we don't re-show until they leave.
      const last = Array.from(inAlertZone)[0];
      if (last) alertDismissedHex = last;
      hideAlert();
    });
  }

  // Zoom: scroll wheel on radar + buttons + keyboard
  if (els.zoomIn)  els.zoomIn.addEventListener("click", () => zoomBy(-1));   // smaller range
  if (els.zoomOut) els.zoomOut.addEventListener("click", () => zoomBy(+1));  // larger range
  if (els.radarSection) {
    els.radarSection.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? +1 : -1);
    }, { passive: false });
  }
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "+" || e.key === "=") zoomBy(-1);
    if (e.key === "-" || e.key === "_") zoomBy(+1);
  });

  loadStation().then(() => {
    loadLandmarks();
    loadRunways();
    poll();
    setInterval(poll, POLL_MS);
    setInterval(tickClock, CLOCK_MS);
    tickClock();
  });
})();
