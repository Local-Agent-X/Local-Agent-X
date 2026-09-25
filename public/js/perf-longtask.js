// Renderer freeze diagnostics. Self-contained, defensive: never throws at boot.
// Two independent probes, because they catch different things:
//   1. longtask PerformanceObserver — attributes a >1s task to the chat page
//      vs. a pinned-app iframe (containerType), and gives a rough source.
//   2. event-loop drift watchdog — measures the EXACT freeze duration even
//      when longtask attribution is empty (layout/GC blocks, cross-origin).
// Both write to window.__laxFreezeLog (ring buffer) so a freeze that happens
// while DevTools is closed is still inspectable after the fact.
(function () {
  "use strict";
  if (window.__laxFreezeProbeInstalled) return;
  window.__laxFreezeProbeInstalled = true;

  var LOG = (window.__laxFreezeLog = window.__laxFreezeLog || []);

  // Ship each recorded stall to the server so it lands in server.log next to
  // the backend's own restart/OTA lines — the in-memory ring buffer dies with
  // the window, which kept intermittent freezes unattributable. Batched (one
  // POST per 5s window) and silent on any failure: the probe must never become
  // a source of work itself.
  //
  // The cap is a ROLLING WINDOW, not a session total. A flat per-session cap of
  // 40 went permanently silent once spent: report counts in server.log landed on
  // exact multiples of it (40/80/120 per day), so every freeze after the first
  // ~40 of a window's life went unrecorded — including the ones the user was
  // reporting. A window-scoped cap still bounds the traffic but always has
  // budget for a freeze happening now.
  var REPORT_WINDOW_MS = 10 * 60 * 1000;
  var REPORT_CAP_PER_WINDOW = 20;
  // Bound on entries held while the server is unreachable. A wedged server is
  // exactly when freezes get recorded, so the queue must survive a failed POST
  // without growing without limit.
  var MAX_PENDING = 50;
  var sentAt = [];
  var pending = [];
  var flushTimer = 0;
  function armFlush(delayMs) {
    if (flushTimer) return;
    flushTimer = setTimeout(flushReports, delayMs);
  }
  function flushReports() {
    flushTimer = 0;
    var batch = pending.splice(0, 10);
    if (!batch.length) return;
    try {
      var tok = (typeof AUTH_TOKEN === "string" && AUTH_TOKEN) ? AUTH_TOKEN : "";
      // No token yet (pre-auth boot): keep the entries rather than burning them.
      if (!tok) { requeue(batch); return; }
      fetch("/api/health/client-freeze", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ entries: batch }),
      }).then(function (res) {
        // A 5xx from a server that is only just coming back is retryable; a 4xx
        // means this batch will never be accepted, so drop it.
        if (!res || (res.status >= 500 && res.status < 600)) requeue(batch);
      }).catch(function () { requeue(batch); });
    } catch (e) {
      requeue(batch); // never throw from the probe
    }
  }
  // Put a failed batch back at the FRONT — oldest entries stay oldest — and try
  // again later. Previously the batch was spliced out before the POST and the
  // failure path was empty, so reports were dropped precisely when the server
  // was wedged: the one case the probe exists to capture.
  function requeue(batch) {
    if (!batch || !batch.length) return;
    pending = batch.concat(pending).slice(0, MAX_PENDING);
    armFlush(30000);
  }
  function admitted() {
    var cutoff = Date.now() - REPORT_WINDOW_MS;
    while (sentAt.length && sentAt[0] < cutoff) sentAt.shift();
    if (sentAt.length >= REPORT_CAP_PER_WINDOW) return false;
    sentAt.push(Date.now());
    return true;
  }
  function record(entry) {
    LOG.push(entry);
    if (LOG.length > 100) LOG.shift();
    if (!admitted()) return;
    pending.push(entry);
    if (pending.length > MAX_PENDING) pending.shift();
    armFlush(5000);
  }
  function stamp() {
    try {
      return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    } catch (e) {
      return "?";
    }
  }

  // --- Probe 1: longtask observer (attribution: chat page vs. iframe) -------
  try {
    if (typeof PerformanceObserver === "function") {
      var obs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.duration < 1000) continue;
          var attr = (e.attribution && e.attribution[0]) || {};
          var where = attr.containerType || "window";
          var src = attr.containerSrc || attr.containerName || "";
          var ms = Math.round(e.duration);
          record({ t: stamp(), kind: "longtask", ms: ms, where: where, src: src });
          console.warn(
            "[LONGTASK] " + ms + "ms  in:" + where + (src ? "  src:" + src : "") +
              "  @" + stamp()
          );
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } else {
      console.info("[freeze-probe] longtask API unavailable; watchdog only");
    }
  } catch (e) {
    console.info("[freeze-probe] longtask observer failed to install:", e && e.message);
  }

  // --- Probe 2: event-loop drift watchdog (exact freeze duration) -----------
  // A timer scheduled every 1000ms that can't fire on time means the main
  // thread was blocked for the overshoot. Reports total block incl. layout/GC,
  // which longtask sometimes under-reports.
  //
  // Only while the window is VISIBLE. A backgrounded window has its timers
  // clamped to roughly one firing per minute, which this loop cannot tell apart
  // from a 59-second freeze — and it read them as exactly that: 320 of 401
  // recorded "freezes" in server.log were the ~59000ms clamp signature, i.e.
  // the watchdog reporting its own throttling and spending the report budget on
  // it. A tick that spans any hidden time carries no information about blocking,
  // so it is measured and discarded.
  try {
    var TICK = 1000;
    var THRESHOLD = 800; // only report blocks the user would actually feel
    var last = performance.now();
    var hidden = typeof document !== "undefined" && !!document.hidden;
    // A tick straddling an unhide is throttled for part of its span, so latch
    // hidden-ness between ticks rather than only sampling at tick time.
    var sawHidden = hidden;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) sawHidden = true;
      });
    }
    setInterval(function () {
      var now = performance.now();
      var drift = now - last - TICK;
      last = now;
      var throttled = sawHidden || (typeof document !== "undefined" && !!document.hidden);
      sawHidden = typeof document !== "undefined" && !!document.hidden;
      if (throttled) return;
      if (drift > THRESHOLD) {
        var ms = Math.round(drift);
        record({ t: stamp(), kind: "freeze", ms: ms });
        console.warn("[FREEZE] main thread blocked ~" + ms + "ms  @" + stamp());
      }
    }, TICK);
  } catch (e) {
    console.info("[freeze-probe] watchdog failed to install:", e && e.message);
  }

  console.info("[freeze-probe] installed — inspect with window.__laxFreezeLog");
})();
