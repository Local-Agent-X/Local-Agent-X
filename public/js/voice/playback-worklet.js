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
    this.inputRate = 16000; // default; updated via setRate
    this.upsampleFactor = Math.max(1, sampleRate / this.inputRate);
    this.fractional = 0;

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.cmd === "pcm") {
        const arr = new Int16Array(e.data.pcm);
        this.writePCM(arr);
      } else if (e.data.cmd === "flush") {
        // Interrupt: drop everything in the ring so pending TTS doesn't play
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
      }
    };
  }

  writePCM(int16) {
    for (let i = 0; i < int16.length; i++) {
      if (this.available >= RING_CAPACITY) {
        // Overflow — overwrite oldest sample (pop one)
        this.readIdx = (this.readIdx + 1) % RING_CAPACITY;
        this.available--;
      }
      this.ring[this.writeIdx] = int16[i] / 0x8000;
      this.writeIdx = (this.writeIdx + 1) % RING_CAPACITY;
      this.available++;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const channel = out[0];

    for (let i = 0; i < channel.length; i++) {
      if (this.available <= 0) {
        channel[i] = 0; // silence if underrun
        continue;
      }
      channel[i] = this.ring[this.readIdx];
      // Advance by 1/upsampleFactor per output sample (linear stretch)
      this.fractional += 1 / this.upsampleFactor;
      while (this.fractional >= 1 && this.available > 0) {
        this.readIdx = (this.readIdx + 1) % RING_CAPACITY;
        this.available--;
        this.fractional -= 1;
      }
    }

    // Copy to any additional output channels (stereo → mono)
    for (let ch = 1; ch < out.length; ch++) {
      out[ch].set(channel);
    }
    return true;
  }
}

registerProcessor("pcm-playback", PlaybackProcessor);
