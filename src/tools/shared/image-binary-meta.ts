// Magic-byte image sniffing — MIME detection + dimension parsing straight
// from the bytes, no decoder library. Split from image-acquire.ts (its only
// consumer besides vision-tools) when that file outgrew the 400-LOC limit.

export type ImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/svg+xml";

/**
 * Sniff MIME type from buffer magic bytes. SVG is text — detected from leading content.
 *
 * Exported so the SAME magic-byte gate guards every image egress sink (view_image,
 * the content-creation tools here): a non-image file renamed `.png` fails the sniff
 * regardless of extension, so it can't base64-ship to the vision provider.
 */
export function detectMime(buf: Buffer): ImageMimeType | null {
  if (buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // WEBP: "RIFF....WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  // SVG: text starts with "<svg" or "<?xml" + later "<svg"
  const head = buf.slice(0, Math.min(buf.length, 512)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/**
 * Is this buffer a text-bearing "image" (SVG, or an unrecognized payload that
 * could be a renamed text file) rather than genuine compressed raster bytes?
 *
 * Used to decide whether a text secret-scan is meaningful: running credential
 * regexes / entropy detection over compressed PNG/JPEG/GIF/WebP bytes only
 * false-positives on binary noise (it can't read rendered pixels anyway), while
 * SVG/unknown payloads ARE text and can legitimately hide a token. Raster →
 * false (don't text-scan); svg or unknown → true (do text-scan).
 */
export function imageIsTextBearing(buf: Buffer): boolean {
  const mime = detectMime(buf);
  return mime === null || mime === "image/svg+xml";
}

/** Parse image dimensions from buffer. Minimal inline parsers — png/jpeg/gif/webp/svg. */
export function parseDimensions(
  buf: Buffer,
  mime: ImageMimeType,
): { width: number; height: number } | null {
  if (mime === "image/png") {
    // IHDR chunk starts at byte 16; width=u32 BE @16, height=u32 BE @20.
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === "image/gif") {
    // Logical screen descriptor: width=u16 LE @6, height=u16 LE @8.
    if (buf.length < 10) return null;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (mime === "image/webp") {
    // Two common chunk forms after the RIFF header (offset 12): "VP8 ", "VP8L", "VP8X".
    if (buf.length < 30) return null;
    const chunk = buf.slice(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      // VP8X canvas width/height stored as 24-bit LE values at bytes 24/27, minus 1.
      const w = buf.readUIntLE(24, 3) + 1;
      const h = buf.readUIntLE(27, 3) + 1;
      return { width: w, height: h };
    }
    if (chunk === "VP8L") {
      // Signature byte at 20 must be 0x2F. Width/height packed 14 bits each, minus 1.
      if (buf[20] !== 0x2f) return null;
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = (((b1 & 0x3f) << 8) | b0) + 1;
      const h = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1;
      return { width: w, height: h };
    }
    if (chunk === "VP8 ") {
      // Frame tag at byte 23 starts the lossy frame. 0x9D 0x01 0x2A marker @23..25.
      // Width/height u16 LE @26 and @28, low 14 bits.
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    // Scan SOF markers to find the frame containing height/width.
    let i = 2; // skip SOI
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) return null;
      // Skip fill bytes (0xFF padding).
      let marker = buf[i + 1];
      while (marker === 0xff && i + 2 < buf.length) {
        i++;
        marker = buf[i + 1];
      }
      // SOF0–SOF15 except DHT(C4), DAC(CC), DRI(DD) and standalone markers
      const isSOF =
        (marker >= 0xc0 && marker <= 0xcf) &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        // After marker: u16 segLen, u8 precision, u16 height, u16 width.
        if (i + 9 >= buf.length) return null;
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height };
      }
      // Standalone markers without length: SOI/EOI/RSTn/TEM.
      if (
        marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2;
        continue;
      }
      // Segment with length.
      if (i + 3 >= buf.length) return null;
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return null;
  }
  if (mime === "image/svg+xml") {
    // Best-effort: read width/height attributes; fall back to viewBox.
    const text = buf.toString("utf8");
    const svgMatch = text.match(/<svg\b[^>]*>/i);
    if (!svgMatch) return null;
    const tag = svgMatch[0];
    const wAttr = tag.match(/\bwidth\s*=\s*["']?\s*([\d.]+)/i);
    const hAttr = tag.match(/\bheight\s*=\s*["']?\s*([\d.]+)/i);
    if (wAttr && hAttr) {
      return { width: Math.round(parseFloat(wAttr[1])), height: Math.round(parseFloat(hAttr[1])) };
    }
    const vb = tag.match(/\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
    if (vb) {
      return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
    }
    return { width: 0, height: 0 };
  }
  return null;
}
