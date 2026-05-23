// Particle morph engine + target generators (emoji glyphs, text, shapes,
// moods). morphTo() kicks off a lerp; the animation tick applies it. Target
// generators each return a Float32Array of length basePositions.length.

import * as THREE from 'three';
import { state } from './state.js';

// morphTo(targets, ms): kick off a lerp from current particle positions
// to `targets` (Float32Array of len=2200*3) over ms milliseconds. The
// tick() loop applies the lerp each frame. Animation, drift, and
// amplitude pulse keep running on top of the morph.
export function morphTo(targets, durationMs) {
  if (!state.particles || !targets || targets.length !== state.basePositions.length) return;
  const cur = state.particles.geometry.attributes.position.array;
  state.morphFrom = new Float32Array(cur.length);
  for (let i = 0; i < cur.length; i++) state.morphFrom[i] = cur[i];
  state.morphTarget = targets;
  state.morphStart = performance.now();
  state.morphDuration = Math.max(60, durationMs | 0);
}

export function baseSphereCopy() {
  // Return a fresh copy of the saved sphere positions so morphTo can
  // safely reference morphTarget without aliasing the canonical buffer.
  const out = new Float32Array(state.basePositions.length);
  out.set(state.basePositions);
  return out;
}

// Drifting cloud: looser radial spread, particles sparser through the
// volume. Same shape as the initial idle render. Re-randomized each
// call so consecutive idle returns don't snap to the same dot pattern.
export function genCloud() {
  const n = state.basePositions.length / 3;
  const out = new Float32Array(state.basePositions.length);
  for (let i = 0; i < n; i++) {
    const r = 1.6 + Math.pow(Math.random(), 2.0) * 0.9;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    out[i * 3]     = r * Math.sin(p) * Math.cos(t);
    out[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    out[i * 3 + 2] = r * Math.cos(p);
  }
  return out;
}

// Render any string (emoji or short text) to a small offscreen canvas,
// sample dark/colored pixels, and project them to a 2D plane in 3D
// space. Particles map onto the silhouette. Camera looks down -Z so
// setting z=0 means the shape faces the camera; the suspended rotation
// (see tick()) keeps it that way through the directive's lifetime.
function genGlyph(text, fontSize) {
  const N = state.basePositions.length / 3;
  const out = new Float32Array(state.basePositions.length);
  // Generous canvas + margin so emoji glyphs (which often render outside
  // their nominal em-box, esp. Segoe UI Emoji on Windows) don't clip at
  // the edges. Iterations:
  //   SIZE=96, fontSize=80   → clipped ❤️ at bottom (original bug)
  //   SIZE=192, fontSize=160 → still clipped ❤️ bottom + clipped "loves" text
  //   SIZE=384, fontSize=160 → ample margin (60% headroom per side); even
  //     Segoe UI Emoji's variation-selector glyphs fit, and 5-char text
  //     at 112px stays well within bounds.
  // The bbox detector below only sees pixels *inside* the canvas — anything
  // that renders outside is silently dropped, which means the resulting
  // particle silhouette has a flat edge with no obvious "broken" symptom.
  // So oversize the canvas, don't undersize it.
  const SIZE = 384;
  const cv = document.createElement('canvas');
  cv.width = SIZE; cv.height = SIZE;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';
  cx.font = `${fontSize}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif`;
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText(text, SIZE / 2, SIZE / 2);
  const data = cx.getImageData(0, 0, SIZE, SIZE).data;
  const points = [];
  let minX = SIZE, minY = SIZE, maxX = 0, maxY = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = data[(y * SIZE + x) * 4 + 3];
      if (a > 80) {
        points.push([x, y]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (points.length === 0) {
    // Fallback to base sphere if the glyph rendered nothing
    out.set(state.basePositions);
    return out;
  }
  // Center on the actual rendered-pixel bbox (NOT canvas center).
  // Browsers don't position color-emoji glyphs symmetrically around the
  // canvas midpoint with textBaseline='middle' — vertical bias varies by
  // font/glyph, so we re-center by measuring what actually got drawn.
  const cxPx = (minX + maxX) / 2;
  const cyPx = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  // Map the bbox's longest side to a world-space size of 2.4 so the shape
  // fits comfortably inside the orb's particle volume regardless of glyph.
  const SCALE = 2.4 / extent;
  const jitterScale = SCALE;
  // Distribute particles UNIFORMLY across the pixel set instead of walking
  // points[i % points.length]. The pixel-scan above is row-major top-to-
  // bottom, so when an emoji renders more pixels than we have particles
  // (N=2048; 💰 at fontSize=160 produces ~6-9k pixels), the modulo wrap
  // only covers points 0..N-1 — the FIRST N pixels found, which are all
  // in the top rows of the canvas. Result: the bottom half of tall/square
  // emoji never received a particle. Hearts/shapes were unaffected because
  // they're parametric, not pixel-sampled.
  //
  // The fix is one line: stride through the full points array so every
  // particle picks a roughly evenly-spaced sample. With N=2048 and
  // ~7000 points, stride=~3.4, hitting the entire silhouette uniformly.
  const stride = points.length / N;
  for (let i = 0; i < N; i++) {
    const p = points[Math.floor(i * stride) % points.length];
    // Tiny jitter so multiple particles per pixel don't stack invisibly.
    const jx = (Math.random() - 0.5) * jitterScale * 0.6;
    const jy = (Math.random() - 0.5) * jitterScale * 0.6;
    const jz = (Math.random() - 0.5) * 0.05;
    out[i * 3]     = (p[0] - cxPx) * SCALE + jx;
    out[i * 3 + 1] = -(p[1] - cyPx) * SCALE + jy;  // canvas Y is flipped
    out[i * 3 + 2] = jz;
  }
  return out;
}

// Font sizes are tuned for the canvas in genGlyph. Bigger fonts =
// more rendered pixels = smoother particle silhouette. Final on-screen
// size is determined by bbox auto-fit, not font size, so we can render
// generously without worrying about overflow.
function genEmoji(char) { return genGlyph(char, 160); }
function genText(text)  { return genGlyph(text, Math.max(40, Math.min(112, Math.floor(1280 / Math.max(2, text.length))))); }

// Procedural geometric shapes — heart, lightning, ring, spiral, line.
// Each returns N target positions sampled along/within the shape.
function genShape(name) {
  const N = state.basePositions.length / 3;
  const out = new Float32Array(state.basePositions.length);
  const jitter = (s) => (Math.random() - 0.5) * s;
  if (name === 'heart') {
    // Parametric heart: x = 16 sin³(t), y = 13 cos t - 5 cos 2t - 2 cos 3t - cos 4t
    for (let i = 0; i < N; i++) {
      const t = Math.random() * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      out[i * 3]     = x * 0.07 + jitter(0.04);
      out[i * 3 + 1] = y * 0.07 + jitter(0.04);
      out[i * 3 + 2] = jitter(0.06);
    }
  } else if (name === 'ring') {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + jitter(0.05);
      const r = 1.1 + jitter(0.06);
      out[i * 3]     = r * Math.cos(a);
      out[i * 3 + 1] = r * Math.sin(a);
      out[i * 3 + 2] = jitter(0.06);
    }
  } else if (name === 'spiral') {
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const a = u * Math.PI * 8;
      const r = 0.15 + u * 1.0;
      out[i * 3]     = r * Math.cos(a) + jitter(0.03);
      out[i * 3 + 1] = r * Math.sin(a) + jitter(0.03);
      out[i * 3 + 2] = jitter(0.06);
    }
  } else if (name === 'line') {
    for (let i = 0; i < N; i++) {
      const u = (i / N) * 2 - 1;
      out[i * 3]     = u * 1.3 + jitter(0.04);
      out[i * 3 + 1] = jitter(0.08);
      out[i * 3 + 2] = jitter(0.04);
    }
  } else {  // 'lightning' bolt
    // Zig-zag path with random offsets, particles distributed along it.
    const segs = [[0, 1.2], [-0.4, 0.4], [0.3, 0.0], [-0.2, -0.5], [0.1, -1.2]];
    for (let i = 0; i < N; i++) {
      const u = (i / N) * (segs.length - 1);
      const k = Math.floor(u);
      const f = u - k;
      const a = segs[k];
      const b = segs[Math.min(segs.length - 1, k + 1)];
      out[i * 3]     = a[0] + (b[0] - a[0]) * f + jitter(0.10);
      out[i * 3 + 1] = a[1] + (b[1] - a[1]) * f + jitter(0.05);
      out[i * 3 + 2] = jitter(0.06);
    }
  }
  return out;
}

// Mood presets — for v1 each maps to an emoji glyph (smiley/etc) so we
// get expressive faces without hand-authoring vertex compositions.
function genMood(value) {
  const map = {
    happy: '🙂', sad: '🙁', thinking: '🤔',
    confused: '😕', excited: '🤩', error: '⚠️',
  };
  const ch = map[value] || '🙂';
  return genGlyph(ch, 152);
}

// Multiply every position by the mesh's current rotation matrix and write
// it back. Used by directive entry to avoid the teleport that happens when
// we zero the mesh rotation: morphFrom holds mesh-local positions, but the
// pixels on screen were being rendered through the rotation. After baking,
// mesh-local == world (modulo translation) and zeroing the rotation has no
// visual effect at t=0 of the morph.
function bakeRotationIntoPositions(mesh) {
  const m = new THREE.Matrix4().makeRotationFromEuler(mesh.rotation);
  const arr = mesh.geometry.attributes.position.array;
  const v = new THREE.Vector3();
  for (let i = 0; i < arr.length; i += 3) {
    v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(m);
    arr[i] = v.x; arr[i + 1] = v.y; arr[i + 2] = v.z;
  }
  mesh.geometry.attributes.position.needsUpdate = true;
}

export function handleDirective(msg) {
  if (!state.particles || !state.basePositions) return;
  const kind = msg && msg.kind;
  const value = msg && msg.value;
  // Hold time = durationMs - 600ms morph-in. Default 3600ms gives ~3s of
  // fully-formed shape on screen, which is what reads as "I saw it" for the
  // viewer. Ceiling at 6s so a long tool-call value can still get clamped.
  const durationMs = Math.max(1000, Math.min(6000, (msg && msg.durationMs) | 0 || 3600));
  let target = null;
  if (kind === 'emoji' && value) target = genEmoji(value);
  else if (kind === 'text' && value) target = genText(value);
  else if (kind === 'shape' && value) target = genShape(value);
  else if (kind === 'mood' && value) target = genMood(value);
  if (!target) return;
  // Suspend rotation so 2D shapes face the camera, snapshot current rot.
  if (state.directiveReturnTimer) clearTimeout(state.directiveReturnTimer);
  state.activeDirective = { kind, value };
  if (!state.suspendedRotation && state.particles) {
    state.suspendedRotation = {
      x: state.particles.rotation.x,
      y: state.particles.rotation.y,
      z: state.particles.rotation.z,
    };
    // Bake current rotation into the source positions BEFORE zeroing the
    // mesh rotation. Otherwise the dust teleports the instant rotation
    // snaps to identity (because morphFrom is mesh-local but world-space
    // was being computed through the rotated matrix). Pre-baking keeps
    // the visible starting frame identical, so the morph reads as a
    // smooth lerp from where the dust IS to the glyph silhouette.
    bakeRotationIntoPositions(state.particles);
    state.particles.rotation.set(0, 0, 0);
  }
  morphTo(target, 600);
  // After hold, return to whichever home the current state implies.
  state.directiveReturnTimer = setTimeout(() => {
    state.activeDirective = null;
    if (state.suspendedRotation) state.suspendedRotation = null;  // free, world-rotation will resume
    const home = state.state === 'idle' ? genCloud() : baseSphereCopy();
    morphTo(home, 600);
  }, durationMs);
}
