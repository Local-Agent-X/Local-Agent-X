// Pack 16-bit PCM samples into a WAV container so cloud STT APIs that expect
// audio/wav (Groq, OpenAI, Mistral) accept them via multipart upload.
//
// The mic pipeline upstream produces Int16Array @ 16kHz mono — we copy the
// samples verbatim into the data chunk (little-endian on every supported
// platform) and prepend a 44-byte canonical RIFF/WAVE header.

const HEADER_SIZE = 44;

/**
 * Build a single-chunk RIFF/WAVE buffer wrapping `pcm` as 16-bit signed
 * little-endian PCM, mono, at `sampleRate` Hz. Returns a fresh Uint8Array
 * that is safe to wrap in a Blob.
 */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const byteRate = sampleRate * 2;          // mono * 2 bytes/sample
  const dataSize = pcm.length * 2;
  const fileSize = HEADER_SIZE - 8 + dataSize;

  const out = new Uint8Array(HEADER_SIZE + dataSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // RIFF header
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, fileSize, true);
  writeAscii(out, 8, "WAVE");

  // fmt subchunk
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);             // PCM fmt chunk size
  view.setUint16(20, 1, true);              // PCM format
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits/sample

  // data subchunk
  writeAscii(out, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM payload
  const dataView = new DataView(out.buffer, out.byteOffset + HEADER_SIZE, dataSize);
  for (let i = 0; i < pcm.length; i++) {
    dataView.setInt16(i * 2, pcm[i], true);
  }

  return out;
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i) & 0x7f;
}
