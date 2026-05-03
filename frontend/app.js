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
    setLat:    $("setLat"),
    setLon:    $("setLon"),
    setRange:  $("setRange"),
    setSource: $("setSource"),
  };

  // --- station info ---
  let station = { tz: "America/Phoenix", source: "---", range_nm: 250 };

  async function loadStation() {
    try {
      const r = await fetch("/api/station");
      if (r.ok) station = await r.json();
      els.src.textContent = `SOURCE: ${station.source.toUpperCase()}`;
      updateStationLabel();
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
    els.setLat.value  = station.lat ?? "";
    els.setLon.value  = station.lon ?? "";
    els.setRange.value = station.range_nm ?? 250;
    els.setSource.value = station.source || "adsblol";
    els.modal.classList.add("open");
  }
  function closeSettings() { els.modal.classList.remove("open"); }
  async function saveSettings() {
    const body = {
      name: els.setName.value.trim() || station.name,
      lat:  parseFloat(els.setLat.value),
      lon:  parseFloat(els.setLon.value),
      range_nm: parseFloat(els.setRange.value),
    };
    if (!isFinite(body.lat) || !isFinite(body.lon) || !isFinite(body.range_nm)) {
      alert("Lat / Lon / Range must be valid numbers.");
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
  function classLabel(k) { return k === "mil" ? "MIL" : "CIV"; }

  // Build a leader-line angle so the datablock sits "ahead-and-up" of the
  // track, like real ATC scopes. If we have a track heading, push the
  // datablock 45 deg off that. Otherwise default up-and-right.
  function leaderAngleDeg(track) {
    if (track === null || track === undefined) return -45;
    // Datablock placed to the right and above the symbol = heading + ~60 deg.
    return ((track + 60) % 360) - 90;
  }

  // Compute the px offset for the datablock based on leader angle.
  // Leader is 26px long; datablock anchors at the leader's far end.
  function datablockOffset(angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    const r = 26;
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    // Adjust further so the text doesn't sit on top of the leader endpoint
    return { dx: dx + (dx < 0 ? -90 : 4), dy: dy + (dy < 0 ? -40 : 4) };
  }

  // --- symbol SVG fragments ---
  const SYM_SQUARE   = '<svg viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const SYM_DIAMOND  = '<svg viewBox="0 0 14 14"><polygon points="7,1 13,7 7,13 1,7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const SYM_TRIANGLE = '<svg viewBox="0 0 14 14"><polygon points="7,2 12,12 2,12" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const SYMBOLS = { square: SYM_SQUARE, diamond: SYM_DIAMOND, triangle: SYM_TRIANGLE };

  // --- render: radar targets ---
  function renderTargets(aircraft) {
    const frag = document.createDocumentFragment();
    for (const a of aircraft) {
      const div = document.createElement("div");
      div.className = `target ${a.phase}` + (a.klass === "mil" ? " mil" : "");
      div.style.top  = `${a.y}%`;
      div.style.left = `${a.x}%`;

      const angle = leaderAngleDeg(a.track);
      const off = datablockOffset(angle);

      // Build line 2: "FL ↕ GS"
      const fl = fmtAlt(a.alt);
      const arr = vrateArrow(a.vrate);
      const gs = fmtSpd(a.gs);

      // L2: type + registration (better aircraft ID than the squawk).
      // Falls back gracefully when fields are missing.
      const type = a.type || "----";
      const reg  = a.reg  || "";
      const idLine = reg ? `${type} · ${reg}` : type;

      div.innerHTML = `
        <div class="sym">${SYMBOLS[a.sym] || SYM_SQUARE}</div>
        <div class="leader" style="transform: rotate(${angle}deg);"></div>
        <div class="db" style="left:${off.dx}px;top:${off.dy}px;">
          <div class="l1">${a.callsign}</div>
          <div class="l2">${idLine}</div>
          <div class="l3">${fl} ${arr} ${gs}</div>
        </div>
      `;
      frag.appendChild(div);
    }
    els.targets.replaceChildren(frag);
  }

  // --- render: track polylines (SVG) ---
  function renderTracks(aircraft) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const frag = document.createDocumentFragment();
    for (const a of aircraft) {
      if (!a.history || a.history.length < 2) continue;
      const pts = a.history.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("points", pts);
      line.setAttribute("class", `tk-${a.phase}`);
      frag.appendChild(line);
    }
    els.tracks.replaceChildren(frag);
  }

  // --- render: departures board ---
  function renderBoard(aircraft) {
    // Sort: military first, then by altitude descending.
    const rows = [...aircraft].sort((a, b) => {
      if (a.klass !== b.klass) return a.klass === "mil" ? -1 : 1;
      const aa = typeof a.alt === "number" ? a.alt : -1;
      const bb = typeof b.alt === "number" ? b.alt : -1;
      return bb - aa;
    });
    const frag = document.createDocumentFragment();
    for (const a of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const trackBearing = a.track !== null && a.track !== undefined
        ? `${Math.round(a.track).toString().padStart(3, "0")}°`
        : "---";
      const opType = a.type ? a.type : "---";
      // Route column: we don't have origin/dest from raw ADS-B yet.
      // Show track bearing as a stand-in until route lookup is wired.
      row.innerHTML = `
        <div class="col-flight">${a.callsign}</div>
        <div class="col-route">HDG<span class="arrow">▶</span>${trackBearing}</div>
        <div class="col-alt">${fmtAltCommas(a.alt)}<span class="u">FT</span></div>
        <div class="col-spd">${fmtSpd(a.gs)}<span class="u">KT</span></div>
        <div class="col-type">${opType} · ${a.reg || "---"}</div>
        <div class="col-class ${a.klass === "mil" ? "mil" : ""}">${classLabel(a.klass)}</div>
        <div class="status ${a.phase}">${phaseLabel(a.phase)}</div>
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

  async function loadLandmarks() {
    const layer = document.getElementById("landmarkLayer");
    if (!layer) return;
    try {
      const r = await fetch("/api/landmarks");
      if (!r.ok) return;
      const data = await r.json();
      const ns = "http://www.w3.org/2000/svg";
      // Convert percentage (0..100) to viewBox units (1000x1000).
      const toVB = (p) => p * 10;
      let svg = "";
      for (const lm of data.landmarks) {
        const x = toVB(lm.x), y = toVB(lm.y);
        if (lm.kind === "airport") {
          // Plus-sign airport tick.
          svg += `<g stroke="var(--green)" stroke-width="1.6" fill="none">`;
          svg += `<line x1="${x-5}" y1="${y}" x2="${x+5}" y2="${y}"/>`;
          svg += `<line x1="${x}" y1="${y-5}" x2="${x}" y2="${y+5}"/>`;
          svg += `</g>`;
          svg += `<text x="${x+8}" y="${y-4}" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700" fill="var(--green-bright)" opacity="0.95">${lm.id}</text>`;
        } else if (lm.kind === "park") {
          svg += `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="var(--green-dim)" stroke-width="1.2"/>`;
          svg += `<text x="${x+6}" y="${y+3}" font-family="JetBrains Mono, monospace" font-size="9" fill="var(--green-dim)" opacity="0.85">${lm.name}</text>`;
        }
      }
      layer.innerHTML = svg;
    } catch (e) { /* offline; no overlay */ }
  }

  loadStation().then(() => {
    loadLandmarks();
    poll();
    setInterval(poll, POLL_MS);
    setInterval(tickClock, CLOCK_MS);
    tickClock();
  });
})();
