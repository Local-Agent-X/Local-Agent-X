// Mouse-wheel zoom. Adjusts the camera dolly target; the tick lerps to it so
// the zoom feels weighted rather than snapping.

import { state } from './state.js';

export function wireInteraction() {
  state.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoomTarget = Math.min(8, Math.max(2.2, state.zoomTarget + e.deltaY * 0.0022));
  }, { passive: false });
}
