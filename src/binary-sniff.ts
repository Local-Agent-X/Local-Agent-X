/**
 * NUL-byte detection — the shared "does this contain a NUL byte" check.
 *
 * Binary files almost always carry a NUL in their first bytes; text almost
 * never does, so a NUL is the cheap tell that a buffer isn't decodable text.
 * Folded together from four hand-rolled copies (the read tool's binary guard,
 * the egress attachment sniff, env-var sanitization, and safe text reads) so
 * the heuristic — and the 8 KB sample bound for buffers — can't drift between
 * them.
 *
 * Semantics are preserved per input kind:
 *   - string: full scan (matches the prior `value.includes("\0")` — a security
 *     check on env values must NOT be silently bounded to a sample).
 *   - Buffer: bounded scan of the first `sampleSize` bytes (the prior binary
 *     guards only ever sniffed the head for speed).
 */
export function containsNulByte(data: Buffer | string, sampleSize = 8192): boolean {
  if (typeof data === "string") return data.includes("\0");
  const limit = Math.min(data.length, sampleSize);
  for (let i = 0; i < limit; i++) if (data[i] === 0) return true;
  return false;
}
