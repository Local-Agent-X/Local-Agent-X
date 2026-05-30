// Shared mutable state for the memory brain visual. Every module in this
// folder imports `state` and reads/writes fields directly — same pattern as
// the voice sphere. Phase 0: a brain-shaped dust cloud whose dot count tracks
// the number of stored memories, with scroll-to-zoom.
export const state = {
  container: null,
  canvas: null,

  scene: null,
  camera: null,
  renderer: null,
  points: null,
  mat: null,

  raf: null,
  startTime: 0,

  // Camera dolly target — wheel events nudge this, the tick lerps toward it.
  zoomTarget: 4.2,

  count: 0,
  // Per-dot memory records (index i ↔ point i), so a raycast hit maps to a
  // memory we can show. Empty until the atlas loads.
  items: [],
  // Topic clusters (id, label, color, centroid) for coloring + labels.
  clusters: [],
  // Two position mappings for the same projection: 'map' = raw PCA islands,
  // 'brain' = same data warped into a brain silhouette. Toggled live.
  layoutMode: 'brain',
  rawXyz: null,
  brainXyz: null,
  brainWarp: null,
  // LOD crossfade: dots fade in as you zoom past the cluster-blob view.
  dotOpacity: 1,

  // Auto-spin eases to 0 while the pointer is over the brain so hovered dots
  // hold still long enough to read. spinTarget is the goal, spinFactor lerps.
  spinFactor: 1,
  spinTarget: 1,
};
