// Shared mutable state for the voice sphere. Every other module in this
// folder imports `state` and reads/writes fields directly. Original code was
// one IIFE with closure-shared locals; this object replaces that closure.
export const state = {
  // Three.js core
  scene: null,
  camera: null,
  renderer: null,
  container: null,
  root: null,

  // Meshes
  core: null,
  halo: null,
  particles: null,
  particles2: null,
  rings: [],        // outer torus rings at various tilts
  wires: [],        // inner wireframe geometries (icosa + octa)

  // Materials
  coreMat: null,
  haloMat: null,
  dotMat: null,

  // Audio analysers + reusable read buffers
  micAnalyser: null,
  ttsAnalyser: null,
  micBuf: null,
  ttsBuf: null,

  // Visual state
  state: 'idle',
  smoothedAmp: 0,
  raf: null,
  visible: false,
  viewMode: 'split',
  startTime: 0,
  materializeT: 0,
  // Push-to-talk gate state. 'open' (or null = N/A) = mic frames flow; the
  // sphere renders at full brightness. 'closed' = mic muted; we dim the
  // canvas so the user has an obvious visual cue that input isn't being
  // captured. Set via setGateState() from the push-to-talk module.
  gateState: null,

  // ── Particle morph engine state ────────────────────────────────────────
  // The inner shell (particles, 2200 pts) is the active "canvas" the LLM
  // can morph via the voice_visual tool. Outer scatter (particles2, 600
  // pts) keeps drifting in its original positions — backdrop, not subject.
  //
  // basePositions: the sphere positions we return to as a fallback.
  // morphFrom/morphTarget: current lerp endpoints (Float32Arrays of len=2200*3).
  // morphStart/morphDuration: animation timing.
  // activeDirective: truthy while a voice_visual is being rendered; rotation
  //                  is suspended so 2D shapes face the camera correctly.
  // directiveReturnTimer: setTimeout id for scheduled return-to-home morph.
  basePositions: null,
  morphFrom: null,
  morphTarget: null,
  morphStart: 0,
  morphDuration: 0,
  activeDirective: null,
  directiveReturnTimer: null,
  // Suspended rotations (so we can restore on directive end)
  suspendedRotation: null,
};
