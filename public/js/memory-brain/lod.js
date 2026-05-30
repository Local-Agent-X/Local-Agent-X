// Level-of-detail: a layer of soft cluster "blobs" at the topic centroids. As
// you zoom out the blobs fade in and the individual dots fade down, so the far
// view reads as ~20 labeled islands instead of 30k-dot soup; zoom in and the
// dots take over. The blobs share the point cloud's rotation so they stay glued
// to their clusters.

import * as THREE from 'three';
import { state } from './state.js';

const BLOB_VERTEX = `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPxScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uPxScale * (300.0 / -mv.z), 12.0, 170.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const BLOB_FRAGMENT = `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d) * 0.5;
    gl_FragColor = vec4(vColor, a * uOpacity);
  }
`;

let blobs = null;
let blobMat = null;
let labelLayer = null;

// centroids: [{ x, y, z, size, color: [r,g,b] 0-1 }]
export function buildBlobs(centroids) {
  if (blobs) {
    state.scene.remove(blobs);
    blobs.geometry.dispose();
  }
  if (!blobMat) {
    blobMat = new THREE.ShaderMaterial({
      uniforms: { uPxScale: { value: 1 }, uOpacity: { value: 0 } },
      vertexShader: BLOB_VERTEX,
      fragmentShader: BLOB_FRAGMENT,
      transparent: true,
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
  centroids.forEach((c, i) => {
    pos[i * 3] = c.x;
    pos[i * 3 + 1] = c.y;
    pos[i * 3 + 2] = c.z;
    size[i] = 0.45 + 1.1 * (c.size / maxC);
    col[i * 3] = c.color[0];
    col[i * 3 + 1] = c.color[1];
    col[i * 3 + 2] = c.color[2];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  blobs = new THREE.Points(g, blobMat);
  state.scene.add(blobs);
}

export function updateLod() {
  if (!state.camera || !state.points) return;
  // camera.z runs ~2.2 (near) .. 8 (far). t=0 near, 1 far.
  const t = Math.min(1, Math.max(0, (state.camera.position.z - 3.2) / 2.0));
  const dotOp = 1 - 0.85 * t;
  state.dotOpacity = dotOp;
  if (state.mat) state.mat.uniforms.uOpacity.value = dotOp;
  if (blobMat) blobMat.uniforms.uOpacity.value = t;
  if (blobs) blobs.rotation.copy(state.points.rotation);
  // Labels stay readable at every zoom (they're the navigation aid), just a
  // touch brighter when zoomed out to the blob view.
  if (!labelLayer) labelLayer = document.getElementById('mb-labels');
  if (labelLayer) labelLayer.style.opacity = (0.8 + 0.2 * t).toFixed(3);
}
