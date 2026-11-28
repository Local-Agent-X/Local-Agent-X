// ── A skin's own moving layer, in a sandbox ───────────────────────────────
// The effect code a skin carries was written by the agent (or came with a
// skin synced from another machine), so it never runs in the app's window,
// where it could read the login token and call every API. It runs in a frame
// that has:
//   • sandbox="allow-scripts" and no allow-same-origin: no origin, so no
//     cookies, no storage, and no way to reach this page;
//   • a policy of default-src 'none': no network at all;
//   • pointer-events none, behind the UI: it cannot be clicked or cover text.
// It can draw on its own canvas and read the state this page posts to it
// (skin-effects.js builds that state), and nothing else. If its code throws,
// the frame reports once and is removed; the app carries on without it.
//
// The contract the code is written to, as the `skin` tool describes it:
// define draw(ctx, s, dt), and optionally init(s).
(function () {
  var frame = null, timer = 0, getState = null;
  var lastError = '';

  /** Runs inside the frame, before the skin's code. Serialized with toString,
   *  so it may use nothing from this file. */
  function boot() {
    var c = document.getElementById('c'), ctx = c.getContext('2d');
    var s = { w: 0, h: 0, t: 0 }, dpr = 1, last = 0, started = false, dead = false;
    function fit() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      s.w = window.innerWidth; s.h = window.innerHeight;
      c.width = Math.floor(s.w * dpr); c.height = Math.floor(s.h * dpr);
      c.style.width = s.w + 'px'; c.style.height = s.h + 'px';
    }
    function fail(e) {
      if (dead) return;
      dead = true;
      parent.postMessage({ laxFx: 'error', message: String((e && e.message) || e).slice(0, 300) }, '*');
    }
    function tick(t) {
      if (dead) return;
      var dt = last ? Math.min((t - last) / 1000, 0.06) : 0;
      last = t; s.t = t / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, s.w, s.h);
      try { draw(ctx, s, dt); } catch (e) { fail(e); return; }
      requestAnimationFrame(tick);
    }
    window.addEventListener('resize', fit);
    window.addEventListener('error', function (e) { fail(e.message); });
    window.addEventListener('message', function (e) {
      if (e.source !== parent || !e.data || e.data.laxFx !== 'state') return;
      for (var k in e.data.state) s[k] = e.data.state[k];
      if (started) return;
      started = true;
      fit();
      try { if (typeof init === 'function') init(s); } catch (err) { fail(err); return; }
      requestAnimationFrame(tick);
    });
    parent.postMessage({ laxFx: 'ready' }, '*');
  }

  function documentFor(code) {
    return '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:">' +
      '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style>' +
      '<canvas id="c"></canvas>' +
      '<script>(' + boot.toString() + ')()</' + 'script>' +
      // The code cannot close its own script element early.
      '<script>' + String(code).replace(/<\/script/gi, '<\\/script') + '</' + 'script>';
  }

  function post() {
    if (frame && frame.contentWindow && getState) frame.contentWindow.postMessage({ laxFx: 'state', state: getState() }, '*');
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = 0; }
    if (frame) { frame.remove(); frame = null; }
    getState = null;
  }
  function start(code, stateOf) {
    stop();
    lastError = '';
    getState = stateOf;
    frame = document.createElement('iframe');
    frame.id = 'fx-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.srcdoc = documentFor(code);
    document.body.appendChild(frame);
    timer = setInterval(post, 250);
  }

  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow || !e.data) return;
    if (e.data.laxFx === 'ready') post();
    else if (e.data.laxFx === 'error') {
      lastError = String(e.data.message || 'The effect stopped.');
      console.warn('[effects] custom effect stopped:', lastError);
      stop();
      document.dispatchEvent(new CustomEvent('lax-effect-error', { detail: lastError }));
    }
  });

  window.laxEffectFrame = { start: start, stop: stop, lastError: function () { return lastError; } };
})();
