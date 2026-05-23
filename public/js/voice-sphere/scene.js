// Three.js scene assembly for the voice sphere. Builds the renderer, camera,
// halo, rings, wireframe shell, inner particle shell, and outer drift cloud.
// All meshes/materials are stashed on `state` so the animation tick + morph
// engine can read them without re-querying the scene graph.

import * as THREE from 'three';
import { state } from './state.js';
import {
  HALO_VERTEX,
  HALO_FRAGMENT,
  DOT_VERTEX,
  DOT_FRAGMENT,
} from './shaders.js';

export function initThree() {
  if (state.scene) return;
  const canvas = state.root.querySelector('#vs-canvas');
  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  // Pulled back so the sphere reads as a self-contained object inside the
  // viewport instead of bleeding off the edges on big monitors.
  state.camera.position.z = 4.6;
  state.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  buildHalo();
  buildWireframes();
  buildRings();
  buildInnerShell();
  buildOuterCloud();

  window.addEventListener('resize', resize);
  resize();
}

// ── Bright hot core (small, additive) — the energy point at the center
function buildHalo() {
  state.haloMat = new THREE.ShaderMaterial({
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    uniforms: { uAmplitude: { value: 0 } },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  state.halo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 3), state.haloMat);
  state.scene.add(state.halo);
}

// ── Internal wireframe architecture (icosa + octa + lat/long sphere)
function buildWireframes() {
  // Inner icosa + octa removed — they were blocking the active particle
  // shape (heart, text glyphs) at the center. The big translucent
  // lat/long sphere below stays as the outer dome cue.
  // Subtle lat/long sphere wireframe — sparser segs so it reads as a faint
  // dome shell, not a fishnet.
  const latLong = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(1.35, 12, 8)),
    new THREE.LineBasicMaterial({ color: 0x3a8fcf, transparent: true, opacity: 0.07, depthWrite: false }),
  );
  state.scene.add(latLong);
  state.wires.push(latLong);
}

// ── Multiple orbital rings at varied tilts/radii
// Radii shrunk ~20% (1.55-1.85 → 1.25-1.50) so the rings stop clipping
// the top and bottom of the canvas at common viewport heights. The
// particle shell still sits comfortably inside the smallest ring.
function buildRings() {
  // Ring opacities dropped ~60% so the rings read as a faint armillary
  // cage instead of competing with the dust particles. Emoji/text morphs
  // need the dust to be the loudest element on screen; bright rings made
  // glyph silhouettes hard to pick out against the moving torus lines.
  const ringDef = [
    { r: 1.25, tube: 0.006, opacity: 0.32, rot: [Math.PI / 2.4, 0, 0] },
    { r: 1.32, tube: 0.005, opacity: 0.25, rot: [Math.PI / 3.2, Math.PI / 2, 0] },
    { r: 1.42, tube: 0.005, opacity: 0.20, rot: [Math.PI / 1.8, Math.PI / 5, 0] },
    { r: 1.50, tube: 0.004, opacity: 0.16, rot: [Math.PI / 2.8, Math.PI / 7, Math.PI / 3] },
  ];
  for (const def of ringDef) {
    const m = new THREE.MeshBasicMaterial({
      color: 0x6dd6ff, transparent: true, opacity: def.opacity, depthWrite: false,
    });
    const r = new THREE.Mesh(new THREE.TorusGeometry(def.r, def.tube, 4, 256), m);
    r.rotation.set(def.rot[0], def.rot[1], def.rot[2]);
    state.scene.add(r);
    state.rings.push(r);
  }
}

// ── Inner shell — the active "canvas" the voice_visual tool morphs.
// Initialize with cloud positions (idle baseline). The sphere positions
// are generated alongside and saved for state-driven morphs.
function buildInnerShell() {
  const pCount = 2200;
  const pPos = new Float32Array(pCount * 3);
  const pSize = new Float32Array(pCount);
  // The dyson-sphere "active" home — used by listening/thinking/speaking
  // states. Saved into state.basePositions for morphTo to lerp back to.
  state.basePositions = new Float32Array(pCount * 3);
  for (let i = 0; i < pCount; i++) {
    // Tight dyson shell at r in [1.45, 1.55].
    const rs = 1.45 + Math.random() * 0.10;
    const ts = Math.random() * Math.PI * 2;
    const ps = Math.acos(2 * Math.random() - 1);
    state.basePositions[i * 3]     = rs * Math.sin(ps) * Math.cos(ts);
    state.basePositions[i * 3 + 1] = rs * Math.sin(ps) * Math.sin(ts);
    state.basePositions[i * 3 + 2] = rs * Math.cos(ps);
  }
  // Drifting cloud for idle: looser radial spread, particles sparser
  // throughout the volume rather than a tight shell. Initial render
  // uses these positions so the user's first impression is the calmer
  // cloud, not the energetic sphere.
  for (let i = 0; i < pCount; i++) {
    const r = 1.6 + Math.pow(Math.random(), 2.0) * 0.9;  // most near 1.6, a few out to 2.5
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pPos[i * 3]     = r * Math.sin(p) * Math.cos(t);
    pPos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    pPos[i * 3 + 2] = r * Math.cos(p);
    pSize[i] = 0.4 + Math.random() * 0.5;
  }
  const pGeom = new THREE.BufferGeometry();
  pGeom.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeom.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
  // Custom shader to render crisp circular dots (default Three.js Points
  // are flat squares). Discard outside unit circle, soft anti-aliased edge.
  state.dotMat = new THREE.ShaderMaterial({
    uniforms: {
      uPxScale: { value: 1.0 },
      uAmplitude: { value: 0 },
      uTime: { value: 0 },
      uPulse: { value: 0 },   // 0..1, set externally during 'speaking'
    },
    vertexShader: DOT_VERTEX,
    fragmentShader: DOT_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  state.particles = new THREE.Points(pGeom, state.dotMat);
  state.scene.add(state.particles);
}

// Wider drift cloud for depth — bumped 600 → 2400 for more "dust"
// density per user request. Wider radial range too (1.4 → 2.6) so the
// dust extends past the rings instead of all bunching at one shell.
function buildOuterCloud() {
  const p2Count = 2400;
  const p2Pos = new Float32Array(p2Count * 3);
  const p2Size = new Float32Array(p2Count);
  for (let i = 0; i < p2Count; i++) {
    const r = 1.4 + Math.pow(Math.random(), 1.6) * 1.2;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    p2Pos[i * 3]     = r * Math.sin(p) * Math.cos(t);
    p2Pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    p2Pos[i * 3 + 2] = r * Math.cos(p);
    p2Size[i] = 0.25 + Math.random() * 0.45;
  }
  const p2Geom = new THREE.BufferGeometry();
  p2Geom.setAttribute('position', new THREE.BufferAttribute(p2Pos, 3));
  p2Geom.setAttribute('aSize', new THREE.BufferAttribute(p2Size, 1));
  state.particles2 = new THREE.Points(p2Geom, state.dotMat);
  state.scene.add(state.particles2);
}

export function resize() {
  if (!state.renderer || !state.container) return;
  const r = state.container.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
}
