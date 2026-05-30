// Floating topic labels for the largest clusters. Each label is a DOM element
// positioned every frame by projecting its cluster centroid (which rotates with
// the point cloud) to screen space — so labels ride along with their islands.

import * as THREE from 'three';
import { state } from './state.js';
import { openInspector } from './inspector.js';

const v = new THREE.Vector3();
let layer = null;
const els = [];

export function setupClusterLabels(clusters) {
  layer = document.getElementById('mb-labels');
  if (!layer) return;
  layer.innerHTML = '';
  els.length = 0;
  const top = [...clusters].sort((a, b) => b.count - a.count).slice(0, 12);
  for (const c of top) {
    const el = document.createElement('div');
    el.className = 'mb-cluster-label';
    el.textContent = c.label;
    el.style.color = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
    el.onclick = () => openInspector(c);
    layer.appendChild(el);
    els.push({ el, c });
  }
}

export function clearClusterLabels() {
  if (layer) layer.innerHTML = '';
  els.length = 0;
}

export function updateClusterLabels() {
  if (!layer || !state.points || !els.length) return;
  const rect = state.canvas.getBoundingClientRect();
  for (const { el, c } of els) {
    // _x/_y/_z are the centroid in the active layout (set by applyMode); fall
    // back to the raw projection centroid before the first mode is applied.
    const x = c._x ?? c.cx, y = c._y ?? c.cy, z = c._z ?? c.cz;
    v.set(x, y, z).applyMatrix4(state.points.matrixWorld).project(state.camera);
    if (v.z > 1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = (v.x * 0.5 + 0.5) * rect.width + 'px';
    el.style.top = (-v.y * 0.5 + 0.5) * rect.height + 'px';
  }
}
