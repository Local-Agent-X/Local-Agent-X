// DOM + drag handling + push-to-talk gate visual for the voice sphere.
// Owns the #voice-sphere-root element, its mode-toggle/back buttons, and the
// drag-to-reposition behavior that's only active in floating mode.

import { state } from './state.js';

// `cycleMode` and `onBack` are passed by the entrypoint so this module doesn't
// have to reach back into lifecycle (one-way dependency: dom → state only).
export function ensureDOM({ onCycle, onBack }) {
  if (state.root) return;
  const root = document.createElement('div');
  root.id = 'voice-sphere-root';
  root.className = 'vs-hidden vs-mode-split';
  root.innerHTML = `
    <div class="vs-canvas-wrap"><canvas id="vs-canvas"></canvas></div>
    <button class="vs-mode-toggle" title="Cycle view mode">⇄</button>
    <button class="vs-back-btn" title="Back to chat">←</button>
  `;
  document.body.appendChild(root);
  state.root = root;
  state.container = root.querySelector('.vs-canvas-wrap');
  root.querySelector('.vs-mode-toggle').addEventListener('click', onCycle);
  root.querySelector('.vs-back-btn').addEventListener('click', onBack);
  attachDrag();
  restoreFloatingPosition();
}

// ── Drag-to-reposition (floating mode only) ──
// The user wants the sphere to feel independent of the chat layout — in
// floating mode they can grab it and drop it anywhere on the screen. Only
// active while vs-mode-floating is on; in split/fullscreen the sphere fills
// a fixed area and dragging would fight the layout.
let dragState = null;
function attachDrag() {
  const root = state.root;
  if (!root) return;
  const onPointerDown = (e) => {
    if (state.viewMode !== 'floating') return;
    // Don't start a drag when the user clicks one of the sphere's buttons.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'BUTTON' || (e.target && e.target.closest('button'))) return;
    const rect = root.getBoundingClientRect();
    dragState = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
    root.classList.add('vs-dragging');
    try { root.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!dragState) return;
    const left = Math.max(0, Math.min(window.innerWidth - dragState.w, e.clientX - dragState.offX));
    const top = Math.max(0, Math.min(window.innerHeight - dragState.h, e.clientY - dragState.offY));
    // Inline style overrides the default top/right anchor in CSS so the
    // sphere can sit anywhere. We clear `right` to avoid conflicting with
    // the explicit left we're setting now.
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = 'auto';
  };
  const onPointerUp = (e) => {
    if (!dragState) return;
    dragState = null;
    root.classList.remove('vs-dragging');
    try { root.releasePointerCapture(e.pointerId); } catch {}
    // Persist the position so it survives reloads / sessions.
    try {
      localStorage.setItem('lax_voice_sphere_pos', JSON.stringify({
        left: parseInt(root.style.left, 10) || null,
        top: parseInt(root.style.top, 10) || null,
      }));
    } catch {}
  };
  root.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

export function restoreFloatingPosition() {
  try {
    const raw = localStorage.getItem('lax_voice_sphere_pos');
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.left === 'number' && typeof p.top === 'number') {
      // Only apply when in floating mode — split/fullscreen own positioning.
      if (state.viewMode === 'floating') {
        state.root.style.left = p.left + 'px';
        state.root.style.top = p.top + 'px';
        state.root.style.right = 'auto';
      }
    }
  } catch {}
}

export function clearFloatingPositionInline() {
  // When leaving floating mode, drop the inline drag overrides so the
  // class-based positioning (split/fullscreen) takes effect cleanly.
  if (!state.root) return;
  state.root.style.left = '';
  state.root.style.top = '';
  state.root.style.right = '';
}

// Push-to-talk visual states. The sphere already has rich state
// visuals (idle/listening/thinking/speaking) so we layer this on as a
// canvas-level dim/brighten effect — muted = 0.45 opacity + slight
// desaturation, hot = full opacity. Pure CSS, no shader changes
// required, and stacks gracefully with the existing state visuals.
export function setGateState(s) {
  state.gateState = (s === 'open' || s === 'closed') ? s : null;
  applyGateVisual();
}

export function applyGateVisual() {
  const root = state.root;
  if (!root) return;
  const wrap = root.querySelector('.vs-canvas-wrap');
  if (!wrap) return;
  if (state.gateState === 'closed') {
    wrap.style.opacity = '0.42';
    wrap.style.filter = 'saturate(0.55)';
    wrap.style.transition = 'opacity .25s ease, filter .25s ease';
  } else if (state.gateState === 'open') {
    wrap.style.opacity = '1';
    wrap.style.filter = 'saturate(1.15) brightness(1.05)';
    wrap.style.transition = 'opacity .15s ease, filter .15s ease';
  } else {
    // gateState null — push-to-talk is off, render normally
    wrap.style.opacity = '';
    wrap.style.filter = '';
  }
}
