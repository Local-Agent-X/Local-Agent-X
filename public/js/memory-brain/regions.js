// Region graph — the top-level view of the brain. Each k-means cluster renders
// as a ringed circle at its centroid with lines connecting semantically related
// regions (nearest-neighbor edges from the atlas). Zoomed out, the regions own
// the view and the 30k dots recede to faint dust; dive past the crossfade and
// the dots take over. Replaces the old soft-blob LOD layer.

import * as THREE from 'three';
import { state } from './state.js';

const DISC_VERTEX = `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPxScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPxScale * (300.0 / -mv.z), 18.0, 180.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const DISC_FRAGMENT = `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    // Node look: soft fill + bright rim + small core, so each region reads as a
    // deliberate circle rather than a glow.
    float fill = smoothstep(0.5, 0.0, d) * 0.20;
    float ring = smoothstep(0.045, 0.0, abs(d - 0.44)) * 0.85;
    float core = smoothstep(0.10, 0.0, d) * 0.5;
    gl_FragColor = vec4(vColor, (fill + ring + core) * uOpacity);
  }
`;

let discs = null;
let lines = null;
let discMat = null;
let lineMat = null;
// Eased layer opacity so regions fade rather than pop when drilling in/out.
let layerOpacity = 0;
// Pick metadata: [{ cluster, aSize }] aligned with the disc buffer, kept so a
// click can be resolved in screen space (point sprites don't raycast usefully).
let nodes = [];

// centroids: [{ id, x, y, z, size, color: [r,g,b] 0-1 }] — positions already in
// the current layout mode's space (modes.js warps them before calling).
// edges: [[clusterIdA, clusterIdB, weight 0..1], ...] from the atlas.
export function buildRegions(centroids, edges) {
  disposeLayer();
  if (!centroids.length) return;
  if (!discMat) {
    discMat = new THREE.ShaderMaterial({
      uniforms: { uPxScale: { value: 1 }, uOpacity: { value: 0 } },
      vertexShader: DISC_VERTEX,
      fragmentShader: DISC_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  const k = centroids.length;
  const pos = new Float32Array(k * 3);
  const size = new Float32Array(k);
  const col = new Float32Array(k * 3);
  let maxC = 1;
  for (const c of centroids) maxC = Math.max(maxC, c.size);
  nodes = [];
  const byId = new Map();
  centroids.forEach((c, i) => {
    pos[i * 3] = c.x;
    pos[i * 3 + 1] = c.y;
    pos[i * 3 + 2] = c.z;
    size[i] = 0.45 + 1.1 * (c.size / maxC);
    col[i * 3] = c.color[0];
    col[i * 3 + 1] = c.color[1];
    col[i * 3 + 2] = c.color[2];
    byId.set(c.id, c);
    nodes.push({ c, aSize: size[i] });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  discs = new THREE.Points(g, discMat);
  state.scene.add(discs);

  const segs = (edges || []).filter((e) => byId.has(e[0]) && byId.has(e[1]));
  if (segs.length) {
    const lp = new Float32Array(segs.length * 6);
    const lc = new Float32Array(segs.length * 6);
    segs.forEach((e, i) => {
      const a = byId.get(e[0]), b = byId.get(e[1]);
      const w = e[2];
      lp.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      // Additive blending: brightness doubles as per-edge opacity, so closer
      // regions get brighter links. Each endpoint keeps its region's hue.
      const lum = 0.2 + 0.55 * w;
      lc.set([a.color[0] * lum, a.color[1] * lum, a.color[2] * lum,
              b.color[0] * lum, b.color[1] * lum, b.color[2] * lum], i * 6);
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    lines = new THREE.LineSegments(lg, lineMat);
    state.scene.add(lines);
  }
}

function disposeLayer() {
  if (discs) { state.scene.remove(discs); discs.geometry.dispose(); discs = null; }
  if (lines) { state.scene.remove(lines); lines.geometry.dispose(); lines = null; }
  nodes = [];
}

// Per-frame: crossfade regions vs dots by camera distance, sync rotation with
// the point cloud. Regions own z >= 3.0 (the default view); dots own z <= 2.5.
// While a region is isolated the graph fades out entirely so the dive is clean.
export function updateRegions() {
  if (!state.camera || !state.points) return;
  const z = state.camera.position.z;
  let t = Math.min(1, Math.max(0, (z - 2.5) / 0.5));
  if (state.focusCluster >= 0) t = 0;
  layerOpacity += (t - layerOpacity) * 0.12;
  state.regionFactor = layerOpacity;
  // Dots recede to faint dust under the graph — the silhouette stays readable
  // without turning back into 30k-dot soup.
  const dotOp = 1 - 0.92 * layerOpacity;
  state.dotOpacity = dotOp;
  if (state.mat) state.mat.uniforms.uOpacity.value = dotOp;
  if (discMat) discMat.uniforms.uOpacity.value = layerOpacity;
  if (lineMat) lineMat.opacity = layerOpacity * 0.9;
  if (discs) discs.rotation.copy(state.points.rotation);
  if (lines) lines.rotation.copy(state.points.rotation);
}

// Screen-space hit test for region circles (point sprites scale in pixels, so
// raycasting them is unreliable). Mirrors the vertex shader's size math.
// Returns the cluster record or null.
const v = new THREE.Vector3();
export function pickRegion(e) {
  if (!discs || state.regionFactor < 0.4) return null;
  const rect = state.canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  discs.updateMatrixWorld();
  let best = null;
  let bestD = Infinity;
  for (const { c, aSize } of nodes) {
    v.set(c.x, c.y, c.z).applyMatrix4(discs.matrixWorld);
    const viewZ = v.clone().applyMatrix4(state.camera.matrixWorldInverse).z;
    if (viewZ >= 0) continue;
    const pxSize = Math.min(180, Math.max(18, aSize * (300 / -viewZ)));
    v.project(state.camera);
    const sx = (v.x * 0.5 + 0.5) * rect.width;
    const sy = (-v.y * 0.5 + 0.5) * rect.height;
    const d = Math.hypot(px - sx, py - sy);
    if (d <= pxSize / 2 && d < bestD) { bestD = d; best = c; }
  }
  return best;
}
