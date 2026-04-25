// AudioWorkletProcessor — plays streaming Int16 PCM frames from a ring
// buffer. Frames arrive from the main thread via postMessage; the process()
// callback pulls samples out at the AudioContext's sample rate.
//
// The incoming rate is set via the "setRate" command (16kHz for mic loopback,
// 22050Hz for TTS). If the AudioContext runs faster (48kHz is common), we
// linearly stretch on read — nearest-neighbor, fine for speech, not hi-fi.

const RING_CAPACITY = 48000 * 10; // 10 seconds headroom at any plausible rate

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
    for (let i = 0; i < int16.length; i++) {
      if (this.available >= RING_CAPACITY) {
        this.readIdx = (this.readIdx + 1) % RING_CAPACITY;
        this.available--;
      }
      this.ring[this.writeIdx] = int16[i] / 0x8000;
      this.writeIdx = (this.writeIdx + 1) % RING_CAPACITY;
      this.available++;
    }
    this.totalWriteSamples += int16.length;
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
        this.readIdx = (this.readIdx + 1) % RING_CAPACITY;
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
