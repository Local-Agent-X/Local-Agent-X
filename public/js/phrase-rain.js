// ── Phrase rain (vertical "digital rain") ─────────────────────────────────
// Classic Matrix-style falling columns, but the glyphs are the LETTERS of the
// agent's own covert-ops phrases (thinking-phrases.js) streamed downward — so
// each column spells our words vertically as it falls, in the CURRENT accent
// color (palette-aware). Not readable across; readable (barely) down. Global
// toggle in Appearance, off by default. Perf-safe: rAF with per-column timing,
// pauses when hidden, skips reduced-motion + narrow/mobile.
(function () {
  var STORE_KEY = 'lax_rain';
  var FONT = "'Cascadia Code','Fira Code','Consolas',monospace";
  var CELL = 15;                          // css px per glyph cell / column width
  var canvas = null, ctx = null, raf = 0, cols = [], last = 0;
  var accent = '#40f0f0', bgFade = 'rgba(10,10,15,0.08)', dpr = 1, running = false;

  function phraseChars() {
    var list = (window.THINKING_PHRASES && window.THINKING_PHRASES.length)
      ? window.THINKING_PHRASES
      : ['DECRYPTING', 'EYES ONLY', 'GOING DARK', 'THIS MESSAGE WILL SELF-DESTRUCT'];
    // Add a trailing space so consecutive phrases in a column get a gap.
    return (list[(Math.random() * list.length) | 0] + ' ').toUpperCase();
  }
  function reducedMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function tooSmall() { return window.innerWidth < 768; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    var a = cs.getPropertyValue('--accent').trim();
    if (a) accent = a;
    var bg = cs.getPropertyValue('--bg').trim();
    var rgb = hexToRgb(bg);
    if (rgb) bgFade = 'rgba(' + rgb + ',0.085)';   // per-frame veil → trailing fade
  }
  function hexToRgb(h) {
    if (!h) return null;
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length < 6) return null;
    var n = parseInt(h.slice(0, 6), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  function makeCanvas() {
    canvas = document.createElement('canvas');
    canvas.id = 'phrase-rain-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }
  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    seed();
  }
  function seed() {
    var n = Math.ceil(window.innerWidth / CELL);
    cols = [];
    for (var i = 0; i < n; i++) {
      cols.push({
        x: i * CELL,
        y: rnd(-window.innerHeight, 0),     // stagger start heights
        speed: rnd(45, 115),                // ms per glyph step (lower = faster)
        acc: 0,
        phrase: phraseChars(),
        idx: 0
      });
    }
  }

  function frame(t) {
    if (!running) return;
    if (!last) last = t;
    var dt = Math.min(t - last, 60);
    last = t;
    var H = window.innerHeight;
    ctx.save();
    ctx.scale(dpr, dpr);
    // Translucent veil in the theme bg → previous glyphs fade into a trail.
    ctx.fillStyle = bgFade;
    ctx.fillRect(0, 0, window.innerWidth, H);
    ctx.font = '600 ' + CELL + 'px ' + FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = accent;
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      c.acc += dt;
      while (c.acc >= c.speed) {
        c.acc -= c.speed;
        var ch = c.phrase.charAt(c.idx);
        if (ch !== ' ') ctx.fillText(ch, c.x, c.y);
        c.idx++;
        c.y += CELL;
        if (c.idx >= c.phrase.length) { c.phrase = phraseChars(); c.idx = 0; }
        if (c.y > H && Math.random() > 0.975) { c.y = rnd(-40, 0); }
      }
    }
    ctx.restore();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reducedMotion() || tooSmall()) return;
    if (!canvas) makeCanvas();
    readColors();
    resize();
    running = true; last = 0;
    canvas.style.display = 'block';
    document.body.classList.add('rain-on'); // lets panels go translucent so rain shows through them too
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    document.body.classList.remove('rain-on');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (canvas) { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
  }

  function isOn() { try { return localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; } }
  function enable(persist) { if (persist !== false) { try { localStorage.setItem(STORE_KEY, '1'); } catch (e) {} } start(); }
  function disable(persist) { if (persist !== false) { try { localStorage.setItem(STORE_KEY, ''); } catch (e) {} } stop(); }

  window.addEventListener('resize', function () {
    if (running) resize();
    if (isOn() && !running && !reducedMotion() && !tooSmall()) start();
    if (running && tooSmall()) stop();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else if (isOn()) start();
  });
  try {
    new MutationObserver(readColors).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-palette', 'data-theme']
    });
  } catch (e) {}

  window.phraseRain = { enable: enable, disable: disable, isOn: isOn, refresh: readColors };
  window.toggleRain = function (el) {
    var on = el ? el.classList.toggle('on') : !isOn();
    if (on) enable(); else disable();
  };

  function init() { if (isOn()) start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
