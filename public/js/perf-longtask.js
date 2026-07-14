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
  // POST per 5s window), capped per session, and silent on any failure: the
  // probe must never become a source of work itself.
  var REPORT_CAP = 40;
  var reported = 0;
  var pending = [];
  var flushTimer = 0;
  function flushReports() {
    flushTimer = 0;
    var batch = pending.splice(0, 10);
    if (!batch.length) return;
    try {
      var tok = (typeof AUTH_TOKEN === "string" && AUTH_TOKEN) ? AUTH_TOKEN : "";
      if (!tok) return;
      fetch("/api/health/client-freeze", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ entries: batch }),
      }).catch(function () {});
    } catch (e) { /* never throw from the probe */ }
  }
  function record(entry) {
    LOG.push(entry);
    if (LOG.length > 100) LOG.shift();
    if (reported < REPORT_CAP) {
      reported++;
      pending.push(entry);
      if (!flushTimer) flushTimer = setTimeout(flushReports, 5000);
    }
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
  try {
    var TICK = 1000;
    var THRESHOLD = 800; // only report blocks the user would actually feel
    var last = performance.now();
    setInterval(function () {
      var now = performance.now();
      var drift = now - last - TICK;
      last = now;
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
