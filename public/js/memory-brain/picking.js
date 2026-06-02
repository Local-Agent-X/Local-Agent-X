// Hover-to-read: raycast the point cloud on pointer move (throttled), and show
// the hit memory's snippet in a floating tooltip. Clicking a dot pins the
// tooltip so it survives the next move; clicking empty space unpins. While the
// pointer is over the brain, auto-spin eases to a stop so dots hold still.

import * as THREE from 'three';
import { state } from './state.js';
import { clearFocus } from './focus.js';

// Only raycast individual dots once zoomed in past this distance — from the
// overview every dot overlaps its neighbours, so a click would hit a random
// one. Out there, labels handle navigation; in here, dots are pickable.
const PICK_ZOOM = 2.6;

const ray = new THREE.Raycaster();
ray.params.Points.threshold = 0.04;
const ndc = new THREE.Vector2();

let tip = null;
let pinned = false;
let lastMove = 0;

export function wirePicking() {
  tip = document.getElementById('mb-tip');
  const el = state.canvas;

  el.addEventListener('pointerenter', () => { state.spinTarget = 0; });
  el.addEventListener('pointerleave', () => {
    state.spinTarget = 1;
    if (!pinned) hideTip();
  });

  el.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastMove < 45) return; // throttle raycast against ~30k points
    lastMove = now;
    if (pinned) return;
    const hit = pick(e);
    if (hit) showTip(e, hit);
    else hideTip();
  });

  el.addEventListener('click', (e) => {
    const hit = pick(e);
    if (hit) { pinned = true; showTip(e, hit); }
    else { pinned = false; hideTip(); clearFocus(); }
  });
}

function pick(e) {
  if (!state.points || !state.items.length) return null;
  // Out at the overview, dots overlap and a click would hit a random one, so
  // labels handle navigation there. Once a cluster is isolated (drilled in),
  // only its dots are lit — picking is unambiguous at any zoom.
  if (!state.focused && state.camera.position.z > PICK_ZOOM) return null;
  const rect = state.canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ndc, state.camera);
  const hits = ray.intersectObject(state.points);
  for (const h of hits) {
    const rec = state.items[h.index];
    if (!rec) continue;
    // While a cluster is isolated, the other clusters are still drawn as faint
    // ghosts — ignore hits on them so a pick matches what's actually lit.
    if (state.focused && state.focusCluster >= 0 && rec.cluster !== state.focusCluster) continue;
    return rec;
  }
  return null;
}

function showTip(e, rec) {
  if (!tip) return;
  const rect = state.canvas.getBoundingClientRect();
  const meta = [rec.source, rec.date].filter(Boolean).join(' · ');
  tip.innerHTML = '<div class="mb-tip-text"></div>' + (meta ? '<div class="mb-tip-meta"></div>' : '');
  tip.querySelector('.mb-tip-text').textContent = rec.snippet || '(empty)';
  if (meta) tip.querySelector('.mb-tip-meta').textContent = meta;
  tip.style.display = '';
  // Keep the tooltip inside the panel; flip to the left of the cursor near the
  // right edge.
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const flip = x > rect.width - 280;
  tip.style.left = flip ? '' : x + 14 + 'px';
  tip.style.right = flip ? (rect.width - x + 14) + 'px' : '';
  tip.style.top = Math.min(y + 14, rect.height - 90) + 'px';
  tip.classList.toggle('pinned', pinned);
}

function hideTip() {
  if (tip) tip.style.display = 'none';
}
