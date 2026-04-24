// AudioWorkletProcessor — captures mic PCM at 16kHz mono, ships Int16
// frames (~30ms each) to the main thread via postMessage.
//
// The AudioContext's render quantum is 128 samples. We accumulate until we
// have ~480 samples (30ms @ 16kHz) then emit. Frames are transferred via
// Transferable so there's zero copy overhead.
//
// Downsampling: we ask for a 16kHz context, but browsers only support
// 16k on some platforms. If the AudioContext runs at 48kHz, we downsample
// by decimation (every 3rd sample) on the way out. Quality is acceptable
// for STT (which only wants 16kHz anyway).

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetFrameSize = 480; // 30ms @ 16kHz
    this.buffer = new Int16Array(this.targetFrameSize);
    this.bufferFill = 0;
    this.enabled = false;
    // sampleRate is a global in AudioWorkletGlobalScope — the context's rate.
    // If the context is 48kHz, we need to decimate by 3 to get 16kHz.
    // If it's already 16kHz, decimate factor is 1.
    this.decimateFactor = Math.max(1, Math.round(sampleRate / 16000));

    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === "start") this.enabled = true;
      else if (e.data && e.data.cmd === "stop") this.enabled = false;
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += this.decimateFactor) {
      const v = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.bufferFill++] = v < 0 ? v * 0x8000 : v * 0x7fff;

      if (this.bufferFill >= this.targetFrameSize) {
        // Transfer the filled buffer to the main thread
        const out = this.buffer;
        this.port.postMessage({ type: "pcm", pcm: out.buffer }, [out.buffer]);
        // Start a fresh buffer (the previous one is now owned by the main thread)
        this.buffer = new Int16Array(this.targetFrameSize);
        this.bufferFill = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
