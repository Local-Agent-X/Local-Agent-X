// ── The moving layers shipped with the app: snow, rain, stars, embers ────
// Each is a draw function on the shared canvas (skin-effects.js explains the
// contract and the state object `s`). The list of ids is also held by the
// server (src/skins/skin-store.ts SKIN_BUILTIN_EFFECTS), which checks a
// skin's effect against it; src/skins/skin-effects.test.ts keeps them equal.
(function () {
  var fx = window.laxEffects;
  if (!fx) return;
  var TAU = Math.PI * 2;
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /** Particles kept at a count that follows the window's area and the
   *  density setting: `per` of them for every 100,000 px² at density 1. */
  function field(per, spawn) {
    var parts = [];
    return function (s) {
      var want = Math.min(900, Math.round(s.w * s.h / 100000 * per * s.density));
      while (parts.length < want) parts.push(spawn(s));
      if (parts.length > want) parts.length = want;
      return parts;
    };
  }

  fx.register('snow', 'Snow', function () {
    var flakes = field(9, function (s) {
      return { x: rnd(0, s.w), y: rnd(0, s.h), r: rnd(1, 3.2), v: rnd(22, 70), sway: rnd(0, TAU), drift: rnd(-8, 8) };
    });
    return function (ctx, s, dt) {
      var ps = flakes(s);
      // White snow vanishes on a light window, so it takes the accent there.
      ctx.fillStyle = s.mode === 'light' ? s.accent : '#ffffff';
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i], r = p.r * s.size;
        p.sway += dt;
        p.y += p.v * s.speed * dt * (0.6 + p.r / 3);
        p.x += (Math.sin(p.sway) * 12 + p.drift) * dt;
        if (p.y - r > s.h) { p.y = -r; p.x = rnd(0, s.w); }
        if (p.x < -r) p.x = s.w + r; else if (p.x > s.w + r) p.x = -r;
        ctx.globalAlpha = 0.3 + 0.18 * p.r;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      }
    };
  });

  fx.register('rain', 'Rain', function () {
    var drops = field(7, function (s) {
      return { x: rnd(0, s.w * 1.2), y: rnd(-s.h, s.h), len: rnd(10, 22), v: rnd(520, 900) };
    });
    return function (ctx, s, dt) {
      var ps = drops(s);
      ctx.strokeStyle = s.accent;
      ctx.lineWidth = Math.max(1, s.size);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i], len = p.len * s.size;
        p.y += p.v * s.speed * dt;
        p.x -= p.v * s.speed * dt * 0.18;
        if (p.y - len > s.h) { p.y = -len; p.x = rnd(0, s.w * 1.2); }
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + len * 0.18, p.y - len);
      }
      ctx.stroke();
    };
  });

  fx.register('stars', 'Stars', function () {
    var stars = field(6, function () {
      return { fx: Math.random(), fy: Math.random(), r: rnd(0.5, 1.8), ph: rnd(0, TAU), tw: rnd(0.4, 1.6) };
    });
    return function (ctx, s) {
      var ps = stars(s);
      // They twinkle faster while the agent is working.
      var rate = s.speed * (s.busy ? 2.5 : 1);
      ctx.fillStyle = s.mode === 'light' ? s.accent : '#ffffff';
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        ctx.globalAlpha = 0.2 + 0.65 * (0.5 + 0.5 * Math.sin(p.ph + s.t * p.tw * rate));
        ctx.beginPath(); ctx.arc(p.fx * s.w, p.fy * s.h, p.r * s.size, 0, TAU); ctx.fill();
      }
    };
  });

  fx.register('embers', 'Embers', function () {
    var embers = field(5, function (s) {
      return { x: rnd(0, s.w), y: rnd(0, s.h), r: rnd(1, 2.6), v: rnd(18, 60), sway: rnd(0, TAU), hue: rnd(14, 44) };
    });
    return function (ctx, s, dt) {
      var ps = embers(s);
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i], r = p.r * s.size;
        p.sway += dt * 1.6;
        p.y -= p.v * s.speed * dt;
        p.x += Math.sin(p.sway) * 14 * dt;
        if (p.y + r < 0) { p.y = s.h + r; p.x = rnd(0, s.w); }
        // Bright near the bottom, burning out as they rise.
        ctx.globalAlpha = Math.max(0, Math.min(1, p.y / s.h)) * 0.75;
        ctx.fillStyle = 'hsl(' + p.hue + ',100%,' + (s.mode === 'light' ? 45 : 62) + '%)';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      }
    };
  });
})();
