// Region fly-to: clicking a cluster label flies the camera into that region.
//
// We don't rotate the cloud to face the cluster — we freeze the current
// rotation, read the cluster centroid's live world position, and pan the
// camera in x/y to centre it (the camera looks straight down -z, so centring
// world (x,y) puts it in the middle of the screen) while dollying in. Freezing
// rotation while focused keeps that captured world position valid frame to
// frame. Clearing focus eases the camera back to the centred overview.

import * as THREE from 'three';
import { state } from './state.js';

const FLY_DIST = 1.8;
const v = new THREE.Vector3();

export function flyToCluster(c) {
  if (!state.points || !state.camera) return;
  state.points.updateMatrixWorld();
  const x = c._x ?? c.cx, y = c._y ?? c.cy, z = c._z ?? c.cz;
  v.set(x, y, z).applyMatrix4(state.points.matrixWorld);
  state.focused = true;
  state.panX = v.x;
  state.panY = v.y;
  state.zoomTarget = Math.max(1.3, v.z + FLY_DIST);
  state.spinTarget = 0;
}

export function clearFocus() {
  if (!state.focused) return;
  state.focused = false;
  state.panX = 0;
  state.panY = 0;
  state.zoomTarget = 3.2;
  state.spinTarget = 1;
}

// Eases the camera toward the current pan target every frame. panX/panY are 0
// when not focused, so this doubles as the recentre-on-release motion.
export function updateFocus() {
  if (!state.camera) return;
  state.camera.position.x += (state.panX - state.camera.position.x) * 0.08;
  state.camera.position.y += (state.panY - state.camera.position.y) * 0.08;
}
