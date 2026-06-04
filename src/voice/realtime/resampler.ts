// Minimal Int16 resampler for the OpenAI Realtime bridge.
//
// Browser mic delivers 16kHz Int16 PCM. OpenAI Realtime expects 24kHz Int16
// PCM on input and emits 24kHz Int16 PCM on output. We need exactly one
// conversion direction (16→24); the return path is already 24kHz so we
// pass it through, but we still ship a downsample helper in case a future
// caller wants 24→16 (e.g. piping the model voice into a 16kHz consumer).
//
// Linear interpolation. Quality is fine for speech at this ratio; a proper
// polyphase filter would shave dB off aliasing but adds complexity we
// don't need. Dependency-free on purpose.

/** Resample 16kHz Int16 PCM → 24kHz Int16 PCM (ratio 3/2, linear interp). */
export function upsample16to24(input: Int16Array): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  // Output length = floor(input * 24/16) = floor(input * 1.5)
  const outLen = Math.floor((input.length * 3) / 2);
  const out = new Int16Array(outLen);
  const ratio = input.length / outLen; // ~0.6667
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = i0 + 1 < input.length ? i0 + 1 : i0;
    const frac = srcPos - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    out[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : Math.round(sample);
  }
  return out;
}

/** Pass-through. Output is already 24kHz Int16; here for symmetry/clarity. */
export function passthrough24(input: Int16Array): Int16Array {
  return input;
}

/** Resample 24kHz Int16 PCM → 16kHz Int16 PCM (ratio 2/3, linear interp).
 *  Currently unused by the bridge but documented as the inverse helper
 *  for any future consumer that wants the model voice at 16kHz. */
export function downsample24to16(input: Int16Array): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  const outLen = Math.floor((input.length * 2) / 3);
  const out = new Int16Array(outLen);
  const ratio = input.length / outLen; // ~1.5
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = i0 + 1 < input.length ? i0 + 1 : i0;
    const frac = srcPos - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    out[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : Math.round(sample);
  }
  return out;
}

/** Encode an Int16Array as base64 (little-endian, the wire format used by
 *  OpenAI Realtime's `input_audio_buffer.append`). */
export function int16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

/** Decode base64 → Int16Array (little-endian). The `response.audio.delta`
 *  payload is base64-encoded PCM16. */
export function base64ToInt16(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  // Copy into a freshly aligned buffer — the input Buffer's underlying
  // ArrayBuffer is rarely 2-byte aligned, which would throw on Int16Array
  // construction.
  const aligned = new Int16Array(buf.byteLength / 2);
  for (let i = 0; i < aligned.length; i++) {
    aligned[i] = buf.readInt16LE(i * 2);
  }
  return aligned;
}
