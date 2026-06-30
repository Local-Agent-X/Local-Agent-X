// Reusable schedule picker for the Missions (cron) forms — used by both the
// New Mission modal and the detail-pane edit form. One implementation, mounted
// into a container element.
//
// Four modes:
//   • Daily    — a time → "M H * * *"
//   • Weekly   — day toggles + a time → "M H * * d,d"
//   • Interval — "every N minutes/hours/days" → "Nm" / "Nh" / "Nd"
//   • Type it  — one smart box accepting a cron expression OR plain words
//                ("every weekday at 9am"). Resolved by the server: valid
//                crons short-circuit (no model); natural language is
//                LLM-translated and VALIDATED before it comes back.
//
// The picker modes produce guaranteed-valid schedules locally; the live
// "next run" preview and the Type-it resolution both go through the single
// /api/cron/parse-schedule endpoint, so there's no client-side cron parser to
// drift from the server's.
//
// API:
//   SchedulePicker.mount(el, { schedule, tz })  — build UI, prefill
//   await SchedulePicker.resolve(el)            — { ok, schedule, tz, error? }
(function () {
  const DOW = [
    { n: 0, label: "S", name: "Sun" }, { n: 1, label: "M", name: "Mon" },
    { n: 2, label: "T", name: "Tue" }, { n: 3, label: "W", name: "Wed" },
    { n: 4, label: "T", name: "Thu" }, { n: 5, label: "F", name: "Fri" },
    { n: 6, label: "S", name: "Sat" },
  ];
  const states = new Map(); // mountEl -> state

  function detectedZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } }
  function zoneList() {
    let z = [];
    try { z = Intl.supportedValuesOf("timeZone"); } catch { z = []; }
    if (!z.length) z = [detectedZone(), "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo"].filter(Boolean);
    return z;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmtTime(h, m) {
    const h12 = ((h + 11) % 12) + 1; const ap = h < 12 ? "AM" : "PM";
    return `${h12}:${pad(m)} ${ap}`;
  }
  function unitWord(n, u) {
    const w = u === "m" ? "minute" : u === "h" ? "hour" : "day";
    return n === 1 ? w : w + "s";
  }
  function expandDow(field) {
    // "1-5" | "0,6" | "*" | "3" -> Set of ints, or null if not parseable simply.
    if (field === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
    const out = new Set();
    for (const part of field.split(",")) {
      if (/^\d+$/.test(part)) out.add(+part % 7);
      else if (/^(\d+)-(\d+)$/.test(part)) {
        const [, a, b] = part.match(/^(\d+)-(\d+)$/);
        for (let i = +a; i <= +b; i++) out.add(i % 7);
      } else return null;
    }
    return out;
  }

  function defaultState() {
    return {
      mode: "daily",
      time: "09:00",
      days: new Set([1, 2, 3, 4, 5]),
      intervalN: 1, intervalUnit: "h",
      typeText: "",
      tz: detectedZone(),
      desc: "",
    };
  }

  // Reverse-map an existing schedule string into picker state so editing a job
  // (or interpreting a phrase) shows the right mode pre-filled. Anything we
  // can't represent visually falls back to "Type it" with the raw string.
  function scheduleToState(schedule, tz) {
    const s = defaultState();
    s.tz = tz || detectedZone();
    const sched = (schedule || "").trim();
    if (!sched) return s;
    const iv = sched.match(/^(\d+)(m|h|d)$/);
    if (iv) { s.mode = "interval"; s.intervalN = +iv[1]; s.intervalUnit = iv[2]; return s; }
    const parts = sched.split(/\s+/);
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === "*" && parts[3] === "*") {
      s.time = `${pad(+parts[1])}:${pad(+parts[0])}`;
      if (parts[4] === "*") { s.mode = "daily"; return s; }
      const dows = expandDow(parts[4]);
      if (dows && dows.size) { s.mode = "weekly"; s.days = dows; return s; }
    }
    s.mode = "type"; s.typeText = sched; return s;
  }

  // Forward: state -> schedule string (deterministic for daily/weekly/interval).
  function stateToSchedule(s) {
    if (s.mode === "interval") return `${Math.max(1, s.intervalN | 0)}${s.intervalUnit}`;
    if (s.mode === "type") return (s.typeText || "").trim();
    const [h, m] = (s.time || "09:00").split(":").map(Number);
    if (s.mode === "daily") return `${m} ${h} * * *`;
    const days = [...s.days].sort((a, b) => a - b);
    const dow = days.length ? days.join(",") : "*";
    return `${m} ${h} * * ${dow}`;
  }

  function describe(s) {
    if (s.mode === "interval") return `Every ${s.intervalN} ${unitWord(s.intervalN, s.intervalUnit)}`;
    if (s.mode === "type") return s.desc || "";
    const [h, m] = (s.time || "09:00").split(":").map(Number);
    if (s.mode === "daily") return `Every day at ${fmtTime(h, m)}`;
    const days = [...s.days].sort((a, b) => a - b);
    let when;
    if (days.length === 7) when = "day";
    else if (days.join() === "1,2,3,4,5") when = "weekday";
    else if (days.join() === "0,6") when = "weekend day";
    else when = days.map(d => DOW[d].name).join(", ");
    return `Every ${when} at ${fmtTime(h, m)}`;
  }

  function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

  function render(el) {
    const s = states.get(el);
    const modeBtn = (m, label) =>
      `<button type="button" class="sched-mode${s.mode === m ? " active" : ""}" data-mode="${m}">${label}</button>`;
    const dayBtns = DOW.map(d =>
      `<button type="button" class="sched-day${s.days.has(d.n) ? " active" : ""}" data-day="${d.n}" title="${d.name}">${d.label}</button>`).join("");
    const tzOpts = ['<option value="">Server local time</option>']
      .concat(zoneList().map(z => `<option value="${esc(z)}"${z === s.tz ? " selected" : ""}>${esc(z)}</option>`)).join("");

    el.innerHTML = `
      <div class="sched-modes">
        ${modeBtn("daily", "Daily")}${modeBtn("weekly", "Weekly")}${modeBtn("interval", "Interval")}${modeBtn("type", "Type it")}
      </div>
      <div class="sched-pane" data-pane="daily" style="display:${s.mode === "daily" ? "block" : "none"}">
        <label class="sched-lbl">At</label> <input type="time" class="sched-input sched-time" value="${esc(s.time)}"/>
      </div>
      <div class="sched-pane" data-pane="weekly" style="display:${s.mode === "weekly" ? "block" : "none"}">
        <div class="sched-days">${dayBtns}</div>
        <label class="sched-lbl">At</label> <input type="time" class="sched-input sched-time" value="${esc(s.time)}"/>
      </div>
      <div class="sched-pane" data-pane="interval" style="display:${s.mode === "interval" ? "block" : "none"}">
        <label class="sched-lbl">Every</label>
        <input type="number" min="1" class="sched-input sched-n" style="width:80px" value="${s.intervalN}"/>
        <select class="sched-input sched-unit">
          <option value="m"${s.intervalUnit === "m" ? " selected" : ""}>minutes</option>
          <option value="h"${s.intervalUnit === "h" ? " selected" : ""}>hours</option>
          <option value="d"${s.intervalUnit === "d" ? " selected" : ""}>days</option>
        </select>
      </div>
      <div class="sched-pane" data-pane="type" style="display:${s.mode === "type" ? "block" : "none"}">
        <input type="text" class="sched-input sched-type" style="width:100%" placeholder="0 9 * * 1-5  —or just say—  every weekday at 9am" value="${esc(s.typeText)}"/>
        <button type="button" class="sched-interpret">✨ Interpret</button>
        <span class="sched-type-msg" style="color:var(--muted);font-size:.72rem"></span>
      </div>
      <div class="sched-tz-row">
        <label class="sched-lbl">Timezone</label>
        <select class="sched-input sched-tz" style="flex:1">${tzOpts}</select>
      </div>
      <div class="sched-preview"></div>
    `;
    wire(el);
    refreshPreview(el);
  }

  function wire(el) {
    const s = states.get(el);
    el.querySelectorAll(".sched-mode").forEach(b => b.onclick = () => { s.mode = b.dataset.mode; render(el); });
    el.querySelectorAll(".sched-day").forEach(b => b.onclick = () => {
      const n = +b.dataset.day; if (s.days.has(n)) s.days.delete(n); else s.days.add(n);
      b.classList.toggle("active"); refreshPreview(el);
    });
    const time = el.querySelector(".sched-time"); if (time) time.oninput = () => { s.time = time.value || "09:00"; refreshPreview(el); };
    const n = el.querySelector(".sched-n"); if (n) n.oninput = () => { s.intervalN = Math.max(1, parseInt(n.value) || 1); refreshPreview(el); };
    const unit = el.querySelector(".sched-unit"); if (unit) unit.onchange = () => { s.intervalUnit = unit.value; refreshPreview(el); };
    const type = el.querySelector(".sched-type"); if (type) type.oninput = () => { s.typeText = type.value; s.desc = ""; };
    const interpret = el.querySelector(".sched-interpret"); if (interpret) interpret.onclick = () => doInterpret(el);
    const tz = el.querySelector(".sched-tz"); if (tz) tz.onchange = () => { s.tz = tz.value; refreshPreview(el); };
  }

  // Call the server resolver. Valid crons short-circuit (no model); natural
  // language is translated and validated. Returns { ok, schedule, description,
  // nextRunAt } or { ok:false }.
  async function resolveText(text, tz) {
    try {
      const r = await fetch(API + "/api/cron/parse-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + AUTH_TOKEN },
        body: JSON.stringify({ text, tz: tz || "" }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  async function doInterpret(el) {
    const s = states.get(el);
    const msg = el.querySelector(".sched-type-msg");
    const text = (s.typeText || "").trim();
    if (!text) { if (msg) msg.textContent = "Type a schedule first."; return; }
    if (msg) msg.textContent = "Reading…";
    const res = await resolveText(text, s.tz);
    if (res && res.ok) {
      // Re-home into the visual picker when the result is a shape we can show
      // (daily/weekly/interval); otherwise keep Type-it with the resolved cron.
      const mapped = scheduleToState(res.schedule, s.tz);
      mapped.desc = res.description || "";
      mapped.tz = s.tz;
      if (mapped.mode === "type") mapped.typeText = res.schedule;
      states.set(el, mapped);
      render(el);
      setPreview(el, res.description, res.nextRunAt);
    } else if (msg) {
      msg.textContent = "Couldn't read that — try the picker, or rephrase (e.g. \"every weekday at 9am\").";
    }
  }

  let previewTimers = new Map();
  function refreshPreview(el) {
    const s = states.get(el);
    // Instant local description for the structured modes; Type-it waits for Interpret.
    if (s.mode !== "type") setPreview(el, describe(s), null);
    else if (!s.desc) { setPreview(el, "", null); }
    // Debounced authoritative next-run from the server (short-circuits for the
    // already-valid schedules the picker generates — no model call).
    const schedule = stateToSchedule(s);
    if (!schedule || s.mode === "type") return;
    clearTimeout(previewTimers.get(el));
    previewTimers.set(el, setTimeout(async () => {
      const res = await resolveText(schedule, s.tz);
      if (res && res.ok) setPreview(el, describe(s), res.nextRunAt);
    }, 280));
  }

  function setPreview(el, desc, nextRunAt) {
    const box = el.querySelector(".sched-preview"); if (!box) return;
    if (!desc) { box.textContent = ""; return; }
    let next = "";
    if (nextRunAt) {
      try {
        const d = new Date(nextRunAt);
        next = " · next " + d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      } catch { /* ignore */ }
    }
    const s = states.get(el);
    const zoneNote = s && s.tz ? ` (${s.tz})` : "";
    box.innerHTML = `<span class="sched-check">✓</span> ${esc(desc)}${esc(zoneNote)}${esc(next)}`;
  }

  const SchedulePicker = {
    mount(el, opts) {
      if (!el) return;
      states.set(el, scheduleToState(opts && opts.schedule, opts && opts.tz));
      render(el);
    },
    // Resolve to a concrete { schedule, tz }. Structured modes are deterministic;
    // Type-it defers to the server (cron short-circuit or LLM translation).
    async resolve(el) {
      const s = states.get(el);
      if (!s) return { ok: false, error: "picker not mounted" };
      if (s.mode !== "type") return { ok: true, schedule: stateToSchedule(s), tz: s.tz };
      const text = (s.typeText || "").trim();
      if (!text) return { ok: false, error: "Enter a schedule, or use the Daily/Weekly/Interval picker." };
      const res = await resolveText(text, s.tz);
      if (res && res.ok) return { ok: true, schedule: res.schedule, tz: s.tz };
      return { ok: false, error: "Couldn't understand that schedule. Try the picker or rephrase it." };
    },
  };
  window.SchedulePicker = SchedulePicker;
})();
