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
  var TRAIL = 16;                         // glyphs kept lit behind each head, fading upward — bounds what's on screen
  var GAP = 4;                            // blank cells between phrases so each falls as a distinct, readable group
  var canvas = null, ctx = null, raf = 0, cols = [], last = 0;
  var accent = '#40f0f0', dpr = 1, running = false;

  function pickPhrase() {
    var list = (window.THINKING_PHRASES && window.THINKING_PHRASES.length)
      ? window.THINKING_PHRASES
      : ['DECRYPTING', 'EYES ONLY', 'GOING DARK', 'THIS MESSAGE WILL SELF-DESTRUCT'];
    return list[(Math.random() * list.length) | 0].toUpperCase();
  }
  // A column's content: several phrases as a flat array of glyph cells, each
  // separated by GAP blank cells so consecutive phrases read as distinct groups
  // as they fall. '' marks a blank cell (drawn as nothing). Long enough to span
  // a full fall without obvious repetition.
  function buildStream() {
    var chars = [], count = 6 + (Math.random() * 4 | 0);
    for (var p = 0; p < count; p++) {
      var ph = pickPhrase();
      for (var j = 0; j < ph.length; j++) chars.push(ph.charAt(j));
      for (var g = 0; g < GAP; g++) chars.push('');
    }
    return chars;
  }
  function reducedMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function tooSmall() { return window.innerWidth < 768; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function readColors() {
    var a = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (a) accent = a;
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
    var rows = Math.ceil(window.innerHeight / CELL);
    cols = [];
    for (var i = 0; i < n; i++) {
      cols.push({
        x: i * CELL,
        headPx: rnd(-TRAIL, rows) * CELL,   // stagger heads across (and above) the screen
        speed: rnd(45, 115),                // ms per glyph step (lower = faster)
        acc: 0,
        stream: buildStream(),
        pos: (Math.random() * 40 | 0)       // stagger which glyph each head is on
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
    // Full clear every frame — nothing persists across frames, so glyphs can
    // never accumulate into an unreadable haze. Each column redraws only its
    // bounded trail below, relative to the live head position.
    ctx.clearRect(0, 0, window.innerWidth, H);
    ctx.font = '600 ' + CELL + 'px ' + FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = accent;
    var offBottom = H + TRAIL * CELL;
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      c.acc += dt;
      while (c.acc >= c.speed) {
        c.acc -= c.speed;
        c.pos++;
        c.headPx += CELL;
        if (c.headPx > offBottom) {
          // The whole trail has fallen past the bottom — re-enter from just
          // above the top with fresh content. Clean because the frame is fully
          // cleared each pass, so no old glyphs linger in this lane.
          c.stream = buildStream();
          c.pos = 0;
          c.headPx = rnd(-TRAIL, -1) * CELL;
          c.acc = 0;
          break;
        }
      }
      // Trail: brightest glyph at the head, fading upward over TRAIL cells.
      for (var k = 0; k < TRAIL; k++) {
        var si = c.pos - k;
        if (si < 0) continue;
        var ch = c.stream[si % c.stream.length];
        if (!ch) continue;                    // blank gap cell
        var gy = c.headPx - k * CELL;
        if (gy < -CELL || gy > H) continue;
        ctx.globalAlpha = 1 - k / TRAIL;
        ctx.fillText(ch, c.x, gy);
      }
    }
    ctx.globalAlpha = 1;
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
