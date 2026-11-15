// AudioWorkletProcessor — plays streaming Int16 PCM frames from a ring
// buffer. Frames arrive from the main thread via postMessage; the process()
// callback pulls samples out at the AudioContext's sample rate.
//
// The incoming rate is set via the "setRate" command (16kHz for mic loopback,
// 22050Hz for TTS). If the AudioContext runs faster (48kHz is common), we
// linearly stretch on read — nearest-neighbor, fine for speech, not hi-fi.

// The ring starts at 10 s and doubles when a write would overflow it. The
// sidecar sends a reply's audio as fast as it synthesizes it, not as fast as
// it plays: Kokoro made 45 s of a long reply in 8 s (2026-11-15), and a fixed
// 20 s ring overwrote the unplayed middle, so whole sentences were never
// heard. Unplayed speech is dropped only past MAX_RING_SECONDS of backlog;
// a barge-in "flush" empties the ring and returns it to its starting size.
const RING_CAPACITY = 48000 * 10;
const MAX_RING_SECONDS = 300;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_CAPACITY);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.available = 0;
    // Default to 24kHz (Kokoro TTS in GPU mode). For CPU-mode Matcha
    // playback (22050Hz) the server still sends a setRate via the
    // voice_ready event before any audio arrives, but if that event is
    // ever missed the playback won't sound badly slowed/sped (24kHz
    // assumption is closer to most TTS rates than the old 16kHz default).
    this.inputRate = 24000;
    this.upsampleFactor = Math.max(1, sampleRate / this.inputRate);
    this.fractional = 0;

    // Diagnostics. Reset by a "resetStats" cmd from the main thread.
    this.underrunSamples = 0;     // samples emitted as silence due to empty ring
    this.peakBufLevel = 0;        // max ring fill seen between resets
    this.minBufLevel = Infinity;  // min ring fill seen (when nonempty)
    this.totalWriteSamples = 0;   // samples written this period
    this.lastStatTick = 0;
    this.statIntervalSamples = 24000; // ~0.5s @ 48k context
    this.tickSamplesAccum = 0;

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.cmd === "pcm") {
        const arr = new Int16Array(e.data.pcm);
        this.writePCM(arr);
      } else if (e.data.cmd === "flush") {
        if (this.ring.length > RING_CAPACITY) this.ring = new Float32Array(RING_CAPACITY);
        this.writeIdx = 0;
        this.readIdx = 0;
        this.available = 0;
        this.fractional = 0;
      } else if (e.data.cmd === "setRate") {
        const rate = Number(e.data.rate);
        if (rate > 0 && rate <= 48000) {
          this.inputRate = rate;
          this.upsampleFactor = Math.max(0.5, sampleRate / rate);
          this.fractional = 0;
        }
      } else if (e.data.cmd === "resetStats") {
        this.underrunSamples = 0;
        this.peakBufLevel = 0;
        this.minBufLevel = Infinity;
        this.totalWriteSamples = 0;
      }
    };
  }

  writePCM(int16) {
    if (this.available + int16.length > this.ring.length) this.grow(this.available + int16.length);
    const cap = this.ring.length;
    for (let i = 0; i < int16.length; i++) {
      if (this.available >= cap) {
        this.readIdx = (this.readIdx + 1) % cap;
        this.available--;
      }
      this.ring[this.writeIdx] = int16[i] / 0x8000;
      this.writeIdx = (this.writeIdx + 1) % cap;
      this.available++;
    }
    this.totalWriteSamples += int16.length;
  }

  /** Double the ring until it holds `needed` samples (up to the backlog
   *  limit), keeping the unplayed samples in play order. */
  grow(needed) {
    const max = Math.max(RING_CAPACITY, Math.ceil(this.inputRate * MAX_RING_SECONDS));
    let size = this.ring.length;
    while (size < needed && size < max) size = Math.min(size * 2, max);
    if (size === this.ring.length) return;
    const next = new Float32Array(size);
    for (let i = 0; i < this.available; i++) next[i] = this.ring[(this.readIdx + i) % this.ring.length];
    this.ring = next;
    this.readIdx = 0;
    this.writeIdx = this.available % size;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const channel = out[0];

    // Track buffer levels at the START of this process tick (before draining
    // it). If we're underrunning into silence here, the ring was empty.
    if (this.available > 0 && this.available < this.minBufLevel) this.minBufLevel = this.available;
    if (this.available > this.peakBufLevel) this.peakBufLevel = this.available;

    for (let i = 0; i < channel.length; i++) {
      if (this.available <= 0) {
        channel[i] = 0;
        this.underrunSamples++;
        continue;
      }
      channel[i] = this.ring[this.readIdx];
      this.fractional += 1 / this.upsampleFactor;
      while (this.fractional >= 1 && this.available > 0) {
        this.readIdx = (this.readIdx + 1) % this.ring.length;
        this.available--;
        this.fractional -= 1;
      }
    }

    for (let ch = 1; ch < out.length; ch++) {
      out[ch].set(channel);
    }

    // Periodic diagnostic post to main thread (~ every 0.5s of context audio).
    this.tickSamplesAccum += channel.length;
    if (this.tickSamplesAccum >= this.statIntervalSamples) {
      this.port.postMessage({
        type: "stats",
        underrun: this.underrunSamples,
        peakBuf: this.peakBufLevel,
        minBuf: this.minBufLevel === Infinity ? 0 : this.minBufLevel,
        currentBuf: this.available,
        wrote: this.totalWriteSamples,
        contextSampleRate: sampleRate,
        inputRate: this.inputRate,
      });
      this.underrunSamples = 0;
      this.peakBufLevel = this.available;
      this.minBufLevel = Infinity;
      this.totalWriteSamples = 0;
      this.tickSamplesAccum = 0;
    }
    return true;
  }
}

registerProcessor("pcm-playback", PlaybackProcessor);
