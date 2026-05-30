// Orchestrates the memory brain: lazy one-time init when the Memory settings
// tab is first opened, pause/resume as the user moves between tabs (so we
// don't burn a render loop behind a hidden pane), and the load → render swap.

import { state } from './state.js';
import { initThree, buildPoints, resize } from './scene.js';
import { sampleBrain } from './brain-shape.js';
import { wireInteraction } from './interaction.js';
import { wirePicking } from './picking.js';
import { start, pause, resume } from './animation.js';
import { loadAtlas } from './data.js';
import { setupClusterLabels, clearClusterLabels } from './labels.js';
import { buildBrainWarp } from './brain-warp.js';
import { applyMode, wireModeToggle } from './modes.js';

const EMPTY_DOTS = 600;

let inited = false;

export async function ensure() {
  const container = document.getElementById('mem-brain');
  if (!container) return;
  if (inited) {
    resume();
    resize();
    return;
  }
  inited = true;
  state.container = container;
  state.canvas = document.getElementById('mb-canvas');

  initThree();
  wireInteraction();
  wirePicking();
  wireModeToggle();
  window.addEventListener('resize', resize);
  resize();

  const hud = document.getElementById('mb-hud');
  const empty = document.getElementById('mb-empty');
  const loading = document.getElementById('mb-loading');

  if (loading) loading.style.display = '';
  const { total, items, clusters } = await loadAtlas();
  if (loading) loading.style.display = 'none';

  state.count = total;
  state.items = items;
  state.clusters = clusters;

  const toggle = document.getElementById('mb-toggle');

  if (!items.length) {
    // Ghost brain: dim the dust and show the onboarding prompt.
    const data = sampleBrain(EMPTY_DOTS);
    for (let i = 0; i < data.size.length; i++) data.size[i] *= 0.55;
    if (empty) empty.style.display = '';
    if (hud) hud.textContent = '';
    if (toggle) toggle.style.display = 'none';
    clearClusterLabels();
    buildPoints(data);
  } else {
    if (empty) empty.style.display = 'none';
    if (hud) hud.innerHTML = '<b>' + total.toLocaleString() + '</b> memories';
    const cloud = buildCloud(items, clusters);
    buildPoints(cloud);

    const hasLayout = items[0].x !== undefined;
    if (hasLayout && clusters.length) {
      state.rawXyz = cloud.pos;
      const { xyz, warp } = buildBrainWarp(cloud.pos, items.length);
      state.brainXyz = xyz;
      state.brainWarp = warp;
      if (toggle) toggle.style.display = '';
      setupClusterLabels(clusters);
      applyMode(state.layoutMode);
    } else {
      // No projection (e.g. layout pending) — Phase-1 scatter, no toggle.
      if (toggle) toggle.style.display = 'none';
      clearClusterLabels();
    }
  }

  start();
}

// Build the point-cloud buffers from atlas items. When the layout has computed,
// dots sit at their projection coordinates and take their cluster color; until
// then (no embeddings / layout pending) we fall back to a brain-shaped scatter.
function buildCloud(items, clusters) {
  const n = items.length;
  const hasLayout = items[0].x !== undefined;
  if (!hasLayout) return sampleBrain(n);

  const colorById = new Map(clusters.map((c) => [c.id, c.color]));
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const seed = new Float32Array(n);
  const color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    pos[i * 3] = it.x;
    pos[i * 3 + 1] = it.y;
    pos[i * 3 + 2] = it.z;
    const rgb = colorById.get(it.cluster) || [140, 217, 255];
    color[i * 3] = rgb[0] / 255;
    color[i * 3 + 1] = rgb[1] / 255;
    color[i * 3 + 2] = rgb[2] / 255;
    size[i] = 0.5 + Math.random() * 0.6;
    seed[i] = Math.random();
  }
  return { pos, size, seed, color };
}

export { pause, resume };
