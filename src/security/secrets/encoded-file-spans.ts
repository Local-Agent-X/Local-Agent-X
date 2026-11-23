/**
 * Base64 runs that hold a file, which the entropy pass must not read as keys.
 *
 * An image, an archive or a font in base64 is random-looking bytes by every
 * measure the entropy pass has, and it is everywhere a model writes: a data:
 * URL in a page, an attachment in an API body. The pass walks the base64url
 * alphabet, which has no `/` or `+`, so a standard-base64 file was cut at each
 * one into fragments and each fragment was judged alone: a 3 KB PNG in a JSON
 * body came back as 58 "could be a password" matches (measured 2026-11-22).
 *
 * What says a run is a file is its own first bytes, the format's signature, not
 * the text around it: a `data:image/png;base64,` prefix costs nothing to write
 * in front of a key, so the prefix is never read. A random key opens with a
 * given three-byte signature once in sixteen million.
 *
 * The exemption is from the entropy guess only. The known-shape catalog and the
 * known-value pass still read the run, and the decode engine still peels it and
 * reads what is inside (secret-decode-engine.ts), so a key carried in a file's
 * bytes is found where it was found before.
 */
import { isStdBase64Char, paddedClassRuns } from "./char-runs.js";

/** Shorter than this decodes to under 48 bytes: no file, and the size of a key. */
const MIN_FILE_RUN = 64;

/** A signature: bytes that must appear at `at` in the decoded run. */
interface Signature {
  at: number;
  bytes: readonly number[];
}

const ascii = (text: string, at = 0): Signature => ({ at, bytes: [...text].map((c) => c.charCodeAt(0)) });

// Every signature is three bytes or more. Formats whose signature is shorter
// (BMP's "BM") are left out: two bytes is a match a random key makes by chance.
const FILE_SIGNATURES: ReadonlyArray<readonly Signature[]> = [
  [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }], // PNG
  [{ at: 0, bytes: [0xff, 0xd8, 0xff] }],                               // JPEG
  [ascii("GIF87a")],
  [ascii("GIF89a")],
  [ascii("RIFF"), ascii("WEBP", 8)],
  [ascii("%PDF-")],
  [{ at: 0, bytes: [0x1f, 0x8b, 0x08] }],                               // gzip
  [{ at: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],                         // zip, and the office formats built on it
  [ascii("wOFF")],
  [ascii("wOF2")],
  [ascii("OggS")],
  [ascii("ID3")],                                                       // MP3 with a tag
  [ascii("ftyp", 4)],                                                   // MP4, MOV, HEIC, AVIF
  [{ at: 0, bytes: [0x00, 0x61, 0x73, 0x6d] }],                         // WebAssembly
];

/** The decoded bytes a signature can sit in: the first twelve. */
const HEAD_CHARS = 16;

function opensWithFileSignature(run: string): boolean {
  const head = Buffer.from(run.slice(0, HEAD_CHARS), "base64");
  return FILE_SIGNATURES.some((parts) =>
    parts.every(({ at, bytes }) => bytes.every((byte, i) => head[at + i] === byte)));
}

/** [start, end) of each standard-base64 run that decodes to a known file format. */
export function encodedFileSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const { run, index } of paddedClassRuns(text, isStdBase64Char, MIN_FILE_RUN)) {
    if (opensWithFileSignature(run)) spans.push([index, index + run.length]);
  }
  return spans;
}
