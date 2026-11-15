// Settings → General → Calendars: the user's connected calendars (an iCal
// link or CalDAV), listed with a Disconnect each, and a form to connect one
// (POST /api/calendars/connect checks the calendar answers before saving).
// Another tab's change repaints through loadConnectedCalendars.
(function () {
  function esc2(s) { return typeof esc === 'function' ? esc(s) : String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function renderList(calendars) {
    var el = document.getElementById('cal-list');
    if (!el) return;
    if (!calendars.length) { el.textContent = 'No calendars connected yet. LAX still keeps its own calendar.'; return; }
    el.innerHTML = calendars.map(function (c) {
      var kind = c.kind === 'ics' ? 'iCal link' : 'CalDAV' + (c.host ? ' · ' + esc2(c.host) : '') + (c.username ? ' · ' + esc2(c.username) : '');
      return '<div class="cal-row" style="display:flex;align-items:center;gap:8px;margin-top:4px">'
        + '<span><strong>' + esc2(c.label) + '</strong> <span style="color:var(--muted)">(' + kind + ')</span></span>'
        + '<button type="button" class="notif-btn" data-cal-disconnect="' + esc2(c.id) + '">Disconnect</button></div>';
    }).join('');
  }

  async function loadConnectedCalendars() {
    try {
      var data = await apiJson('/api/calendars');
      renderList(Array.isArray(data.calendars) ? data.calendars : []);
    } catch (e) {
      var el = document.getElementById('cal-list');
      if (el) el.textContent = "Couldn't load your calendars.";
    }
  }

  function status(text) {
    var el = document.getElementById('cal-status');
    if (el) el.textContent = text;
  }

  async function connect() {
    var kind = document.getElementById('cal-kind').value;
    var body = {
      kind: kind,
      label: document.getElementById('cal-label').value,
      url: document.getElementById('cal-url').value,
    };
    if (kind === 'caldav') {
      body.username = document.getElementById('cal-user').value;
      body.password = document.getElementById('cal-pass').value;
    }
    var btn = document.getElementById('cal-connect');
    btn.disabled = true;
    status('Checking the calendar…');
    try {
      var result = await apiPost('/api/calendars/connect', body);
      if (!result.ok) throw new Error(result.error || 'Unable to connect');
      status('Connected "' + result.calendar.label + '": ' + result.events + ' events in the next 30 days.');
      ['cal-label', 'cal-url', 'cal-user', 'cal-pass'].forEach(function (id) { var i = document.getElementById(id); if (i) i.value = ''; });
      loadConnectedCalendars();
    } catch (e) {
      status(e && e.message ? e.message : 'Unable to connect');
    } finally {
      btn.disabled = false;
    }
  }

  async function disconnect(id) {
    try {
      var result = await apiPost('/api/calendars/disconnect', { id: id });
      if (!result.ok) throw new Error(result.error || 'Unable to disconnect');
    } catch (e) {
      status(e && e.message ? e.message : 'Unable to disconnect');
    }
    loadConnectedCalendars();
  }

  function wire() {
    var kind = document.getElementById('cal-kind');
    if (!kind) return;
    kind.addEventListener('change', function () {
      document.getElementById('cal-caldav-fields').style.display = kind.value === 'caldav' ? '' : 'none';
    });
    document.getElementById('cal-connect').addEventListener('click', connect);
    document.getElementById('cal-list').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-cal-disconnect]');
      if (btn) disconnect(btn.getAttribute('data-cal-disconnect'));
    });
    loadConnectedCalendars();
  }

  window.loadConnectedCalendars = loadConnectedCalendars;
  document.addEventListener('DOMContentLoaded', wire);
}());
