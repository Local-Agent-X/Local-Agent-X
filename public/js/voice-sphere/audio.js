// Audio side of the voice sphere: analyser attach points, buffer allocation,
// amplitude read, and the startup chime. No Three.js here — pure Web Audio.

import { state } from './state.js';

export function attachMicAnalyser(node) { state.micAnalyser = node || null; }
export function attachTtsAnalyser(node) { state.ttsAnalyser = node || null; }

export function ensureBuffers() {
  if (!state.micBuf) state.micBuf = new Uint8Array(2048);
  if (!state.ttsBuf) state.ttsBuf = new Uint8Array(2048);
}

export function readAmplitude(analyser, buf) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 2.4);
}

let chimeCtx = null;
export function playStartupChime() {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = chimeCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.32);
  } catch {}
}
