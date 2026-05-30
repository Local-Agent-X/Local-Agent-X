// Three.js scene + crisp circular dot material for the memory brain. The dot
// shader is adapted from the voice sphere's DOT shader (the audio-reactive
// uniforms are dropped; a per-dot twinkle keeps the dust alive). Loaded as an
// ES module via the `three` importmap declared in app.html.

import * as THREE from 'three';
import { state } from './state.js';

const DOT_VERTEX = `
  attribute float aSize;
  attribute float aSeed;
  attribute vec3 aColor;
  uniform float uPxScale;
  uniform float uTime;
  varying float vTw;
  varying vec3 vColor;
  void main() {
    // Each dot twinkles on its own phase so the cloud shimmers organically.
    float tw = 0.8 + 0.2 * sin(uTime * 1.5 + aSeed * 6.2831);
    vTw = tw;
    vColor = aColor;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    float ps = aSize * uPxScale * tw * (16.0 / -mvPos.z);
    gl_PointSize = clamp(ps, 0.8, 7.0);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const DOT_FRAGMENT = `
  uniform float uOpacity;
  varying float vTw;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.28, d);
    gl_FragColor = vec4(vColor, a * (0.4 + vTw * 0.4) * uOpacity);
  }
`;

export function initThree() {
  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  state.camera.position.z = state.zoomTarget;
  state.renderer = new THREE.WebGLRenderer({ canvas: state.canvas, alpha: true, antialias: true });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.mat = new THREE.ShaderMaterial({
    uniforms: { uPxScale: { value: 1.0 }, uTime: { value: 0 }, uOpacity: { value: 1.0 } },
    vertexShader: DOT_VERTEX,
    fragmentShader: DOT_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// Replace the rendered point cloud with a new set of positions/sizes/seeds.
// `color` (Float32Array n*3) is optional — without it the dots default to the
// house blue (used by the Phase-1 scatter and empty states).
export function buildPoints({ pos, size, seed, color }) {
  if (state.points) {
    state.scene.remove(state.points);
    state.points.geometry.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(color || defaultColor(size.length), 3));
  state.points = new THREE.Points(g, state.mat);
  state.scene.add(state.points);
}

function defaultColor(n) {
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = 0.55;
    c[i * 3 + 1] = 0.85;
    c[i * 3 + 2] = 1.0;
  }
  return c;
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
