// show / hide / mode / state lifecycle for the voice sphere. Orchestrates the
// other modules: ensure DOM exists, build the scene, allocate audio buffers,
// flip CSS classes for view modes, kick off morphs on state transitions.

import { state } from './state.js';
import {
  ensureDOM,
  restoreFloatingPosition,
  clearFloatingPositionInline,
  applyGateVisual,
} from './dom.js';
import { initThree, resize } from './scene.js';
import { ensureBuffers, playStartupChime } from './audio.js';
import { tick } from './animation.js';
import { morphTo, baseSphereCopy, genCloud } from './morph.js';

export function show(mode) {
  ensureDOM({ onCycle: cycleMode, onBack: onBackClick });
  if (mode) state.viewMode = mode;
  setMode(state.viewMode);
  initThree();
  ensureBuffers();
  state.root.classList.remove('vs-hidden');
  state.visible = true;
  state.materializeT = 0;
  state.startTime = performance.now();
  resize();
  applyGateVisual();
  if (!state.raf) tick();
  playStartupChime();
}

export function hide() {
  if (!state.root) return;
  state.root.classList.add('vs-hidden');
  state.visible = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
  state.micAnalyser = null;
  state.ttsAnalyser = null;
}

export function setMode(mode) {
  if (!state.root) return;
  state.viewMode = mode;
  state.root.classList.remove('vs-mode-fullscreen', 'vs-mode-split', 'vs-mode-floating');
  state.root.classList.add('vs-mode-' + mode);
  try { localStorage.setItem('lax_voice_view_mode', mode); } catch {}
  // When entering floating mode, restore the user's saved drag position.
  // Leaving floating mode, drop the inline overrides so split/fullscreen
  // CSS owns the layout cleanly.
  if (mode === 'floating') restoreFloatingPosition();
  else clearFloatingPositionInline();
  setTimeout(resize, 60);
}

export function cycleMode() {
  const order = ['split', 'fullscreen', 'floating'];
  const i = order.indexOf(state.viewMode);
  setMode(order[(i + 1) % order.length]);
}

export function setState(s) {
  if (!['idle', 'listening', 'thinking', 'speaking'].includes(s)) return;
  const prev = state.state;
  state.state = s;
  // State transitions move particles between cloud (idle) and sphere
  // (listening/thinking/speaking) homes — visual cue that the agent is
  // engaged vs ambient. Skipped while a directive is morphing.
  if (!state.activeDirective && prev !== s) {
    if (s === 'idle') morphTo(genCloud(), 800);
    else if (prev === 'idle') morphTo(baseSphereCopy(), 600);
  }
}

function onBackClick() {
  if (typeof window.stopVoiceMode === 'function') window.stopVoiceMode();
  else hide();
}
