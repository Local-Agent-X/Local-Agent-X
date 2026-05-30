// Floating topic labels — the map legend AND the navigation. Each label rides
// its cluster centroid (projected to screen every frame). Two rules keep them
// readable on 30k points:
//   1. Zoom tiers: fewer labels when zoomed out (continents), more as you dive,
//      none when zoomed in close (the dots take over).
//   2. Collision avoidance: bigger clusters place first; any label that would
//      overlap an already-placed one is hidden, so the legend never garbles.
// Single-click a label to fly into that region; double-click opens its memory
// list in the inspector.

import * as THREE from 'three';
import { state } from './state.js';
import { openInspector } from './inspector.js';
import { flyToCluster } from './focus.js';

const v = new THREE.Vector3();
let layer = null;
const els = [];

export function setupClusterLabels(clusters) {
  layer = document.getElementById('mb-labels');
  if (!layer) return;
  layer.innerHTML = '';
  layer.style.opacity = '1';
  els.length = 0;
  const top = [...clusters].sort((a, b) => b.count - a.count).slice(0, 16);
  for (const c of top) {
    const el = document.createElement('div');
    el.className = 'mb-cluster-label';
    el.textContent = c.label;
    el.style.color = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
    el.addEventListener('click', () => flyToCluster(c));
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); openInspector(c); });
    layer.appendChild(el);
    els.push({ el, c, w: el.offsetWidth, h: el.offsetHeight });
  }
}

export function clearClusterLabels() {
  if (layer) layer.innerHTML = '';
  els.length = 0;
}

export function updateClusterLabels() {
  if (!layer || !state.points || !els.length) return;
  const z = state.camera.position.z;
  // Zoomed in close — individual dots own the view, labels would just clutter.
  if (z < 2.4) { for (const e of els) e.el.style.display = 'none'; return; }
  const maxLabels = z > 3.6 ? 6 : z > 2.8 ? 10 : 14;
  const rect = state.canvas.getBoundingClientRect();
  const placed = [];
  let shown = 0;
  for (const e of els) {
    const { el, c } = e;
    const x = c._x ?? c.cx, y = c._y ?? c.cy, zc = c._z ?? c.cz;
    v.set(x, y, zc).applyMatrix4(state.points.matrixWorld).project(state.camera);
    if (v.z > 1 || shown >= maxLabels) { el.style.display = 'none'; continue; }
    const sx = (v.x * 0.5 + 0.5) * rect.width;
    const sy = (-v.y * 0.5 + 0.5) * rect.height;
    const w = e.w || (e.w = el.offsetWidth), h = e.h || (e.h = el.offsetHeight);
    const box = { l: sx - w / 2 - 4, t: sy - h / 2 - 4, r: sx + w / 2 + 4, b: sy + h / 2 + 4 };
    if (placed.some(p => !(box.r < p.l || box.l > p.r || box.b < p.t || box.t > p.b))) {
      el.style.display = 'none';
      continue;
    }
    placed.push(box);
    shown++;
    el.style.display = '';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
  }
}
