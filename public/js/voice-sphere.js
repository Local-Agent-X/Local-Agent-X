// Voice-mode 3D sphere visualization. Audio-reactive Jarvis-style core with
// orbiting rings + particle halo. Three.js loaded as an ES module via the
// importmap declared in app.html — `three` resolves to the self-hosted
// /vendor/three/three.module.min.js bundle (the legacy build/three.min.js
// global was removed in r160).
//
// API:
//   VoiceSphere.show(mode)              // 'fullscreen' | 'split' | 'floating'
//   VoiceSphere.hide()
//   VoiceSphere.setMode(mode)
//   VoiceSphere.setState(state)         // 'idle' | 'listening' | 'thinking' | 'speaking'
//   VoiceSphere.attachMicAnalyser(node)
//   VoiceSphere.attachTtsAnalyser(node)
//   VoiceSphere.playStartupChime()
//
// All state is internal — caller just toggles modes/states and pumps audio
// analyser nodes when they have them.
//
// Implementation lives in ./voice-sphere/ — this file is the entrypoint that
// wires the public window.VoiceSphere surface to the focused modules.

import { state } from './voice-sphere/state.js';
import {
  show, hide, setMode, setState,
} from './voice-sphere/lifecycle.js';
import {
  attachMicAnalyser, attachTtsAnalyser, playStartupChime,
} from './voice-sphere/audio.js';
import { handleDirective, morphTo } from './voice-sphere/morph.js';
import { setGateState } from './voice-sphere/dom.js';

window.VoiceSphere = {
  show, hide, setMode, setState,
  attachMicAnalyser, attachTtsAnalyser,
  playStartupChime,
  handleDirective, morphTo,
  setGateState,
  get currentMode() { return state.viewMode; },
  get currentState() { return state.state; },
  get currentGate() { return state.gateState; },
};
