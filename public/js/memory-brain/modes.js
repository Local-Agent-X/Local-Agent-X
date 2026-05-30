// Swaps the point cloud between the 'brain' (silhouette-warped) and 'map' (raw
// PCA islands) layouts in place — same geometry, just new positions + rebuilt
// cluster blobs/labels. Toggle button reflects the current mode.

import { state } from './state.js';
import { buildBlobs } from './lod.js';

export function applyMode(mode) {
  state.layoutMode = mode;
  const xyz = mode === 'brain' && state.brainXyz ? state.brainXyz : state.rawXyz;
  if (state.points && xyz) {
    const attr = state.points.geometry.getAttribute('position');
    attr.array.set(xyz);
    attr.needsUpdate = true;
    state.points.geometry.computeBoundingSphere();
  }

  const centroids = state.clusters.map((c) => {
    const p = mode === 'brain' && state.brainWarp ? state.brainWarp(c.cx, c.cy, c.cz) : [c.cx, c.cy, c.cz];
    c._x = p[0]; c._y = p[1]; c._z = p[2];
    return {
      x: p[0], y: p[1], z: p[2],
      size: Math.sqrt(c.count),
      color: [c.color[0] / 255, c.color[1] / 255, c.color[2] / 255],
    };
  });
  if (state.clusters.length) buildBlobs(centroids);

  const btn = document.getElementById('mb-toggle');
  if (btn) btn.textContent = mode === 'brain' ? 'Brain' : 'Map';
}

export function wireModeToggle() {
  const btn = document.getElementById('mb-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    applyMode(state.layoutMode === 'brain' ? 'map' : 'brain');
  });
}
