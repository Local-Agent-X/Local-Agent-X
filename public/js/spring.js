// ── Spring Physics Animation Engine ──
// Extracted from react-motion (MIT) — physics-based spring animations
// Gives UI elements natural momentum, overshoot, and smooth interruption handling

const Spring = (() => {
  // Presets: tuned spring configs for different feels
  const presets = {
    noWobble: { stiffness: 170, damping: 26 },
    gentle:   { stiffness: 120, damping: 14 },
    wobbly:   { stiffness: 180, damping: 12 },
    stiff:    { stiffness: 210, damping: 20 },
    snappy:   { stiffness: 300, damping: 25 },
    molasses: { stiffness: 100, damping: 30 },
  };

  const FRAME_RATE = 1 / 60;
  const PRECISION = 0.01;

  // Core stepper: one frame of spring physics (Hooke's law + damping)
  function step(x, v, destX, stiffness, damping) {
    const Fspring = -stiffness * (x - destX);
    const Fdamp = -damping * v;
    const a = Fspring + Fdamp;
    const newV = v + a * FRAME_RATE;
    const newX = x + newV * FRAME_RATE;
    if (Math.abs(newV) < PRECISION && Math.abs(newX - destX) < PRECISION) {
      return { x: destX, v: 0, done: true };
    }
    return { x: newX, v: newV, done: false };
  }

  // Active animations keyed by element+property
  const _active = new Map();

  function animKey(el, prop) {
    if (!el._springId) el._springId = 's' + (++_idCounter);
    return el._springId + ':' + prop;
  }
  let _idCounter = 0;

  // Animate a single numeric property on an element
  // el: DOM element
  // prop: CSS property name (or special: 'opacity', 'scale', 'x', 'y')
  // target: target numeric value
  // opts: { preset, stiffness, damping, unit, onUpdate, onDone }
  function animate(el, prop, target, opts) {
    opts = opts || {};
    const key = animKey(el, prop);
    const preset = presets[opts.preset] || presets.noWobble;
    const stiffness = opts.stiffness || preset.stiffness;
    const damping = opts.damping || preset.damping;
    const unit = opts.unit || '';

    // If already animating this prop, carry current velocity (smooth interruption)
    const existing = _active.get(key);
    let currentX, currentV;
    if (existing) {
      currentX = existing.x;
      currentV = existing.v;
      cancelAnimationFrame(existing.raf);
    } else {
      currentX = opts.from !== undefined ? opts.from : _readProp(el, prop, unit);
      currentV = 0;
    }

    // Already at target
    if (Math.abs(currentX - target) < PRECISION && Math.abs(currentV) < PRECISION) {
      _active.delete(key);
      _applyProp(el, prop, target, unit);
      if (opts.onDone) opts.onDone();
      return;
    }

    const state = { x: currentX, v: currentV, raf: 0 };
    _active.set(key, state);

    function tick() {
      const result = step(state.x, state.v, target, stiffness, damping);
      state.x = result.x;
      state.v = result.v;
      _applyProp(el, prop, result.x, unit);
      if (opts.onUpdate) opts.onUpdate(result.x);

      if (result.done) {
        _active.delete(key);
        if (opts.onDone) opts.onDone();
      } else {
        state.raf = requestAnimationFrame(tick);
      }
    }
    state.raf = requestAnimationFrame(tick);
  }

  // Animate multiple properties at once
  function animateMulti(el, props, opts) {
    opts = opts || {};
    const keys = Object.keys(props);
    let remaining = keys.length;
    const originalDone = opts.onDone;

    keys.forEach(prop => {
      animate(el, prop, props[prop], {
        ...opts,
        onDone: () => {
          remaining--;
          if (remaining <= 0 && originalDone) originalDone();
        }
      });
    });
  }

  // Stop all animations on an element
  function stop(el) {
    if (!el._springId) return;
    const prefix = el._springId + ':';
    for (const [key, state] of _active) {
      if (key.startsWith(prefix)) {
        cancelAnimationFrame(state.raf);
        _active.delete(key);
      }
    }
  }

  // Read current value of a property from the element
  function _readProp(el, prop, unit) {
    if (prop === 'opacity') return parseFloat(getComputedStyle(el).opacity) || 0;
    if (prop === 'scale') {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = t.match(/matrix\(([^,]+)/);
        if (m) return parseFloat(m[1]) || 1;
      }
      return 1;
    }
    if (prop === 'x' || prop === 'translateX') {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = t.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+)/);
        if (m) return parseFloat(m[1]) || 0;
      }
      return 0;
    }
    if (prop === 'y' || prop === 'translateY') {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = t.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)/);
        if (m) return parseFloat(m[1]) || 0;
      }
      return 0;
    }
    if (prop === 'width' || prop === 'height' || prop === 'minWidth' || prop === 'minHeight') {
      return parseFloat(getComputedStyle(el)[prop]) || 0;
    }
    const val = getComputedStyle(el)[prop];
    return parseFloat(val) || 0;
  }

  // Apply a value to an element's style
  // Batches transform properties together
  function _applyProp(el, prop, value, unit) {
    if (prop === 'opacity') {
      el.style.opacity = value;
      return;
    }
    if (prop === 'scale' || prop === 'x' || prop === 'y' ||
        prop === 'translateX' || prop === 'translateY') {
      // Read existing transform parts and update
      if (!el._springTransform) el._springTransform = {};
      el._springTransform[prop] = value;
      const t = el._springTransform;
      const parts = [];
      if (t.x !== undefined || t.translateX !== undefined)
        parts.push('translateX(' + (t.x || t.translateX || 0) + (unit || 'px') + ')');
      if (t.y !== undefined || t.translateY !== undefined)
        parts.push('translateY(' + (t.y || t.translateY || 0) + (unit || 'px') + ')');
      if (t.scale !== undefined) parts.push('scale(' + t.scale + ')');
      el.style.transform = parts.join(' ');
      return;
    }
    // Generic property
    el.style[prop] = value + (unit || '');
  }

  // Convenience: spring-animated show/hide
  function fadeIn(el, opts) {
    opts = opts || {};
    el.style.display = opts.display || '';
    animate(el, 'opacity', 1, { from: 0, preset: opts.preset || 'stiff', ...opts });
    if (opts.slide) {
      animate(el, 'y', 0, { from: opts.slideFrom || 10, preset: opts.preset || 'stiff', unit: 'px' });
    }
    if (opts.scale) {
      animate(el, 'scale', 1, { from: opts.scaleFrom || 0.95, preset: opts.preset || 'stiff' });
    }
  }

  function fadeOut(el, opts) {
    opts = opts || {};
    animate(el, 'opacity', 0, {
      preset: opts.preset || 'stiff',
      ...opts,
      onDone: () => {
        el.style.display = 'none';
        stop(el);
        if (el._springTransform) el._springTransform = {};
        el.style.transform = '';
        if (opts.onDone) opts.onDone();
      }
    });
    if (opts.slide) {
      animate(el, 'y', opts.slideTo || -10, { preset: opts.preset || 'stiff', unit: 'px' });
    }
    if (opts.scale) {
      animate(el, 'scale', opts.scaleTo || 0.95, { preset: opts.preset || 'stiff' });
    }
  }

  // Staggered entrance: animate a list of elements with delay between each
  function staggerIn(elements, opts) {
    opts = opts || {};
    const delay = opts.delay || 30;
    const preset = opts.preset || 'stiff';
    elements.forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => {
        animate(el, 'opacity', 1, { from: 0, preset });
        animate(el, 'y', 0, { from: 8, preset, unit: 'px' });
      }, i * delay);
    });
  }

  // Respects prefers-reduced-motion
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Wrapped versions that skip animation when reduced motion is preferred
  function safeAnimate(el, prop, target, opts) {
    if (reducedMotion) {
      _applyProp(el, prop, target, (opts && opts.unit) || '');
      if (opts && opts.onDone) opts.onDone();
      return;
    }
    animate(el, prop, target, opts);
  }

  function safeFadeIn(el, opts) {
    if (reducedMotion) {
      el.style.display = (opts && opts.display) || '';
      el.style.opacity = '1';
      el.style.transform = '';
      return;
    }
    fadeIn(el, opts);
  }

  function safeFadeOut(el, opts) {
    if (reducedMotion) {
      el.style.display = 'none';
      if (opts && opts.onDone) opts.onDone();
      return;
    }
    fadeOut(el, opts);
  }

  function safeStaggerIn(elements, opts) {
    if (reducedMotion) {
      elements.forEach(el => { el.style.opacity = '1'; el.style.transform = ''; });
      return;
    }
    staggerIn(elements, opts);
  }

  return {
    presets, animate: safeAnimate, animateMulti, stop, fadeIn: safeFadeIn,
    fadeOut: safeFadeOut, staggerIn: safeStaggerIn,
    // Expose raw versions for cases where you want to bypass reduced-motion check
    _raw: { animate, fadeIn, fadeOut, staggerIn }
  };
})();
