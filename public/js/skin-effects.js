// ── The moving layer behind the app ──────────────────────────────────────
// One canvas behind the UI, one animation loop, and a list of effects that
// draw on it (snow, rain, stars and embers in skin-effects-builtin.js; the
// phrase rain in phrase-rain.js). Before this each animated background would
// have owned its own canvas and loop; now an effect is only a draw function.
//
// What plays is the active skin's effect when it has one (skin.js calls
// setSkinEffect), otherwise the user's standing choice in Settings →
// Appearance → Animated background (kept per browser, in localStorage). A
// skin's own code never runs here: it goes to the sandboxed frame in
// skin-effect-frame.js, which gets the same state object.
//
// An effect is registered as  register(id, label, make)  where make() returns
// draw(ctx, s, dt). Every frame the canvas is cleared and draw is called with
// dt in seconds and  s = { w, h, t, context, busy, mode, accent, text, bg,
// density, speed, size, reactive }.  context is how full the chat's context
// is (0–1); with reactive on, size already grows with it.
//
// Perf-safe: pauses when the window is hidden, off under reduced-motion and on
// narrow (phone) windows, device pixel ratio capped at 2.
(function () {
  var STORE_KEY = 'lax_effect';
  var LEGACY_RAIN_KEY = 'lax_rain';      // the phrase-rain switch this list replaced
  var effects = {};                      // id → { label, make }
  var order = [];
  var canvas = null, ctx = null, raf = 0, last = 0, dpr = 1, draw = null;
  var playing = '';                      // what is on screen: an effect id, 'custom', or ''
  var playingCode = '';                  // the custom code in the frame, so the same code is not restarted
  var failedCode = '';                   // custom code that threw: not started again until it changes
  var skinFx = null;                     // the active skin's effect, or null
  var slow = { context: 0, busy: false, mode: 'dark', accent: '#40f0f0', text: '#c8d0e0', bg: '#0a0a0f' };
  var slowAt = 0;

  function reducedMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function tooSmall() { return window.innerWidth < 768; }

  function choice() {
    try {
      var id = localStorage.getItem(STORE_KEY);
      if (id === null && localStorage.getItem(LEGACY_RAIN_KEY) === '1') { id = 'phrases'; localStorage.setItem(STORE_KEY, id); }
      return id || '';
    } catch (e) { return ''; }
  }
  /** What should play now: the skin's effect, else the standing choice. */
  function wanted() {
    if (skinFx) return skinFx;
    var id = choice();
    return id ? { kind: id, density: 1, speed: 1, size: 1, reactive: false } : null;
  }

  function readSlow() {
    var cs = getComputedStyle(document.documentElement);
    var status = window.lastContextStatus;
    slow.context = status && status.percentage > 0 ? Math.min(1, status.percentage / 100) : 0;
    slow.busy = !!document.querySelector('.streaming');
    slow.mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    slow.accent = cs.getPropertyValue('--accent').trim() || slow.accent;
    slow.text = cs.getPropertyValue('--text').trim() || slow.text;
    slow.bg = cs.getPropertyValue('--bg').trim() || slow.bg;
  }
  /** The state every effect draws from; the sandboxed frame gets it without w, h and t. */
  function state(t) {
    if (t - slowAt > 250 || !slowAt) { slowAt = t || 1; readSlow(); }
    var fx = wanted() || { density: 1, speed: 1, size: 1, reactive: false };
    return {
      w: window.innerWidth, h: window.innerHeight, t: t / 1000,
      context: slow.context, busy: slow.busy, mode: slow.mode, accent: slow.accent, text: slow.text, bg: slow.bg,
      density: fx.density, speed: fx.speed, reactive: !!fx.reactive,
      size: fx.size * (fx.reactive ? 1 + 2 * slow.context : 1)
    };
  }

  function fit() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  function frame(t) {
    if (!draw) return;
    var dt = last ? Math.min((t - last) / 1000, 0.06) : 0;
    last = t;
    var s = state(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.w, s.h);
    try { draw(ctx, s, dt); }
    catch (e) { console.warn('[effects] ' + playing + ' stopped:', e); stop(); return; }
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    draw = null; playing = ''; playingCode = '';
    if (canvas) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
    if (window.laxEffectFrame) window.laxEffectFrame.stop();
    document.body.classList.remove('fx-on');
  }
  function playBuiltin(id) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'fx-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(canvas);
      ctx = canvas.getContext('2d');
    }
    fit();
    canvas.style.display = 'block';
    draw = effects[id].make();
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  /** Bring what is on screen in line with what should play. */
  function sync() {
    if (!document.body) return;
    var fx = wanted();
    var want = !fx || reducedMotion() || tooSmall() || document.hidden ? ''
      : fx.kind === 'custom' ? (fx.code && fx.code !== failedCode && window.laxEffectFrame ? 'custom' : '')
      : effects[fx.kind] ? fx.kind : '';
    if (want === playing && (want !== 'custom' || fx.code === playingCode)) return;
    stop();
    if (!want) return;
    playing = want;
    document.body.classList.add('fx-on'); // lets the panels go see-through (app.css)
    if (want === 'custom') playingCode = fx.code;
    if (want === 'custom') window.laxEffectFrame.start(fx.code, function () { var s = state(performance.now()); delete s.w; delete s.h; delete s.t; return s; });
    else playBuiltin(want);
  }

  window.addEventListener('resize', function () { fit(); sync(); });
  document.addEventListener('visibilitychange', sync);
  // The sandboxed frame reported that its code threw (skin-effect-frame.js).
  document.addEventListener('lax-effect-error', function () { failedCode = playingCode; stop(); });

  window.laxEffects = {
    register: function (id, label, make) { if (!effects[id]) order.push(id); effects[id] = { label: label, make: make }; },
    list: function () { return order.map(function (id) { return { id: id, label: effects[id].label }; }); },
    /** The standing choice ('' is off), and setting it from Settings. */
    choice: choice,
    choose: function (id) {
      try { localStorage.setItem(STORE_KEY, effects[id] ? id : ''); localStorage.removeItem(LEGACY_RAIN_KEY); } catch (e) {}
      sync();
    },
    /** The active skin's effect ({ kind, density, speed, size, reactive, code? }), or null when it has none. */
    setSkinEffect: function (fx) { skinFx = fx || null; slowAt = 0; sync(); },
    playing: function () { return playing; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else setTimeout(sync, 0); // after the effect files below have registered
})();
