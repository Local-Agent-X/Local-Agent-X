// Render loop: slow Y spin + gentle X nod so the silhouette reads as a 3D
// object, dot twinkle via uTime, and a smooth dolly toward the wheel-driven
// zoom target.

import { state } from './state.js';
import { updateClusterLabels } from './labels.js';
import { updateLod } from './lod.js';
import { updateFocus, updateDrillUi } from './focus.js';

export function tick() {
  state.raf = requestAnimationFrame(tick);
  const t = (performance.now() - state.startTime) / 1000;
  if (state.mat) state.mat.uniforms.uTime.value = t;
  if (state.points) {
    state.spinFactor += (state.spinTarget - state.spinFactor) * 0.06;
    // While focused on a region the rotation is held fixed so the camera's
    // captured pan target stays valid — otherwise the cluster would drift away.
    if (!state.focused) {
      state.points.rotation.y += 0.0016 * state.spinFactor;
      state.points.rotation.x = Math.sin(t * 0.15) * 0.12;
    }
  }
  if (state.camera) {
    state.camera.position.z += (state.zoomTarget - state.camera.position.z) * 0.08;
  }
  updateFocus();
  updateDrillUi();
  updateLod();
  state.renderer.render(state.scene, state.camera);
  updateClusterLabels();
}

export function start() {
  if (state.raf) return;
  if (!state.startTime) state.startTime = performance.now();
  tick();
}

export function pause() {
  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = null;
  }
}

export function resume() {
  if (!state.raf && state.points) tick();
}
