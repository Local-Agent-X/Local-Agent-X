// Per-frame animation tick for the voice sphere. Reads audio amplitude,
// applies in-flight particle morphs, runs the breath/pulse + rotation
// updates, and renders the scene.

import { state } from './state.js';
import { readAmplitude } from './audio.js';

export function tick() {
  if (!state.visible) { state.raf = null; return; }
  state.raf = requestAnimationFrame(tick);
  const t = (performance.now() - state.startTime) / 1000;
  state.smoothedAmp = updateAmplitude(t);

  state.haloMat.uniforms.uAmplitude.value = state.smoothedAmp;
  state.dotMat.uniforms.uAmplitude.value = state.smoothedAmp;
  state.dotMat.uniforms.uTime.value = t;

  stepMorph();
  applyBreath(t);
  rotateRings();
  rotateShells();
  applyMaterializeIn();

  state.renderer.render(state.scene, state.camera);
}

function updateAmplitude(t) {
  let targetAmp;
  if (state.state === 'listening') {
    targetAmp = readAmplitude(state.micAnalyser, state.micBuf);
  } else if (state.state === 'speaking') {
    // Always pulse a baseline (so user sees motion even if the analyser
    // tap is reading zero for some reason), plus add the actual TTS
    // amplitude on top. With both, the sphere visibly reacts to the
    // agent's voice without ever appearing frozen.
    const live = readAmplitude(state.ttsAnalyser, state.ttsBuf);
    const baseline = 0.32 + 0.18 * Math.sin(t * 6.5);
    targetAmp = Math.max(baseline, live);
  } else if (state.state === 'thinking') {
    targetAmp = 0.25 + 0.15 * Math.sin(t * 4);
  } else {
    targetAmp = 0.10 + 0.05 * Math.sin(t * 1.2);
  }
  return state.smoothedAmp + (targetAmp - state.smoothedAmp) * 0.18;
}

// ── Particle morph step ─────────────────────────────────────────────
// If a morph is in flight, lerp every inner-shell particle's position
// from morphFrom toward morphTarget by progress fraction. The shader
// drift + amplitude pulse run on top of these lerped positions, so the
// shape always feels alive, not statically posed.
function stepMorph() {
  if (!(state.morphTarget && state.morphStart > 0 && state.particles && state.particles.geometry)) return;
  const elapsed = performance.now() - state.morphStart;
  const tt = Math.min(1, elapsed / state.morphDuration);
  // easeInOutCubic for a softer morph
  const e = tt < 0.5 ? 4 * tt * tt * tt : 1 - Math.pow(-2 * tt + 2, 3) / 2;
  const arr = state.particles.geometry.attributes.position.array;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = state.morphFrom[i] + (state.morphTarget[i] - state.morphFrom[i]) * e;
  }
  state.particles.geometry.attributes.position.needsUpdate = true;
  if (tt >= 1) {
    // Snap to target, clear in-flight markers; the shader drift takes
    // over the per-frame "alive" motion at the new home.
    state.morphFrom = null;
    state.morphStart = 0;
  }
}

// Pulsating breath when agent talks. Drives:
//   - whole composition scale (rings + dot shells expand/contract)
//   - dot size + brightness (via shader uPulse uniform)
//   - ring opacity boost
// A sin pulse synced with the smoothed audio amplitude keeps it rhythmic.
function applyBreath(t) {
  if (state.materializeT < 1) return;
  let breath, ringAlphaBoost, pulse;
  if (state.state === 'speaking') {
    pulse = 0.5 + 0.5 * Math.sin(t * 7);          // 0..1, ~1.1Hz
    breath = 1.0 + (0.04 + state.smoothedAmp * 0.05) * pulse;
    ringAlphaBoost = (0.20 + state.smoothedAmp * 0.30) * pulse;
  } else if (state.state === 'listening' || state.state === 'thinking') {
    pulse = 0;
    breath = 1.0 + state.smoothedAmp * 0.03;
    ringAlphaBoost = 0;
  } else {
    // Idle: subtle mic-driven breath if a mic analyser is attached
    // (smoothedAmp will be 0 when no analyser is attached, so no
    // change in that case). Keeps the cloud-form dust visibly alive
    // when the user is in voice mode but the state hasn't switched
    // to listening yet (or the picker keeps it in idle for the
    // looser cloud aesthetic). Was hardcoded breath=1.0 — the dust
    // looked frozen even though mic data was flowing.
    pulse = 0;
    breath = 1.0 + state.smoothedAmp * 0.025;
    ringAlphaBoost = 0;
  }
  state.dotMat.uniforms.uPulse.value = pulse;
  state.halo.scale.setScalar(breath * 1.4);
  state.particles.scale.setScalar(breath);
  state.particles2.scale.setScalar(breath);
  state.rings.forEach((r) => {
    r.scale.setScalar(breath);
    const baseOp = r.userData.baseOp ?? (r.userData.baseOp = r.material.opacity);
    r.material.opacity = Math.min(1, baseOp + ringAlphaBoost);
  });
}

// Each ring rotates around different axes at different rates and
// directions so the rings visibly tumble through 3D, not just spin
// on one plane. Per-ring axis tuples below give the "armillary sphere"
// motion — the outer rings are biggest, so they read the strongest.
const RING_AXIS_RATES = [
  [ 0.0090,  0.0020,  0.0040],   // ring 0 — fastest, primary
  [-0.0070,  0.0050, -0.0025],
  [ 0.0035, -0.0080,  0.0030],
  [-0.0030,  0.0045, -0.0070],
];

function rotateRings() {
  const ringSpeed = state.state === 'thinking' ? 1.6 : (state.state === 'speaking' ? 1.0 : 0.65);
  state.rings.forEach((r, i) => {
    const ax = RING_AXIS_RATES[i] || [0.005, 0.002, 0.001];
    r.rotation.x += ax[0] * ringSpeed;
    r.rotation.y += ax[1] * ringSpeed;
    r.rotation.z += ax[2] * ringSpeed;
  });
  // Wireframes spin subtly around their own axes. Only the lat/long
  // sphere remains after the ico+octa removal — drive it via the array
  // index (was wires[2], now wires[0]) and skip the missing entries
  // instead of indexing past the end (which threw TypeErrors at .rotation).
  if (state.wires[0]) {
    state.wires[0].rotation.y += 0.0006; // lat/long stays nearly still
  }
}

// Particle shells rotate at different speeds for parallax depth.
// Inner shell rotation is SUSPENDED while a directive is active —
// 2D shapes (emoji, text) live in a plane at z=0 and would smear if
// we let them tumble. Outer scatter keeps drifting as ambient.
function rotateShells() {
  if (!state.activeDirective) {
    state.particles.rotation.y  += 0.0012;
    state.particles.rotation.x  += 0.0003;
  }
  state.particles2.rotation.y -= 0.0008;
  state.particles2.rotation.z += 0.0004;
}

// Materialize-in animation (first ~600ms): scale up from a dot
function applyMaterializeIn() {
  if (state.materializeT >= 1) return;
  state.materializeT = Math.min(1, state.materializeT + 0.025);
  const s = easeOutBack(state.materializeT);
  state.halo.scale.setScalar(s);
  state.rings.forEach(r => r.scale.setScalar(s));
  state.wires.forEach(w => w.scale.setScalar(s));
  state.particles.scale.setScalar(s);
  state.particles2.scale.setScalar(s);
}

function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
