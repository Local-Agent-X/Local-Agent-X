// ── Phrase rain (vertical "digital rain") ─────────────────────────────────
// Classic Matrix-style falling columns, but the glyphs are the LETTERS of the
// agent's own covert-ops phrases (thinking-phrases.js) streamed downward — so
// each column spells our words vertically as it falls, in the CURRENT accent
// color (palette-aware). Not readable across; readable (barely) down.
//
// One of the moving layers on the shared canvas (skin-effects.js owns the
// canvas, the loop, pausing when hidden and the reduced-motion and narrow
// window rules). Until the effect list existed this file owned all of that
// itself, behind its own switch in Appearance.
(function () {
  var fx = window.laxEffects;
  if (!fx) return;
  var FONT = "'Cascadia Code','Fira Code','Consolas',monospace";
  var BASE_CELL = 15;                     // css px per glyph cell / column width, at size 1
  var TRAIL = 16;                         // glyphs kept lit behind each head, fading upward — bounds what's on screen
  var GAP = 4;                            // blank cells between phrases so each falls as a distinct, readable group

  function rnd(a, b) { return a + Math.random() * (b - a); }
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
  function seed(s, cell) {
    var n = Math.ceil(s.w / cell), rows = Math.ceil(s.h / cell), cols = [];
    for (var i = 0; i < n; i++) {
      // Below density 1 some lanes stay empty.
      if (Math.random() > s.density) continue;
      cols.push({
        x: i * cell,
        headPx: rnd(-TRAIL, rows) * cell,   // stagger heads across (and above) the screen
        step: rnd(45, 115),                 // ms per glyph step (lower = faster)
        acc: 0,
        stream: buildStream(),
        pos: (Math.random() * 40 | 0)       // stagger which glyph each head is on
      });
    }
    return cols;
  }
  /** Step one column down by the time passed; re-enter from the top once its
   *  whole trail has fallen past the bottom. */
  function advance(c, ms, cell, offBottom) {
    c.acc += ms;
    while (c.acc >= c.step) {
      c.acc -= c.step;
      c.pos++;
      c.headPx += cell;
      if (c.headPx > offBottom) {
        c.stream = buildStream();
        c.pos = 0;
        c.headPx = rnd(-TRAIL, -1) * cell;
        c.acc = 0;
        return;
      }
    }
  }

  fx.register('phrases', 'Phrase rain', function () {
    var cols = [], seeded = '';
    return function (ctx, s, dt) {
      var cell = Math.round(BASE_CELL * s.size);
      var key = s.w + 'x' + s.h + '@' + cell + '/' + s.density;
      if (key !== seeded) { seeded = key; cols = seed(s, cell); }
      ctx.font = '600 ' + cell + 'px ' + FONT;
      ctx.textBaseline = 'top';
      ctx.fillStyle = s.accent;
      var offBottom = s.h + TRAIL * cell;
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        advance(c, dt * 1000 * s.speed, cell, offBottom);
        // Trail: brightest glyph at the head, fading upward over TRAIL cells.
        for (var k = 0; k < TRAIL; k++) {
          var si = c.pos - k;
          if (si < 0) continue;
          var ch = c.stream[si % c.stream.length];
          if (!ch) continue;                    // blank gap cell
          var gy = c.headPx - k * cell;
          if (gy < -cell || gy > s.h) continue;
          ctx.globalAlpha = 1 - k / TRAIL;
          ctx.fillText(ch, c.x, gy);
        }
      }
    };
  });
})();
