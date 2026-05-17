/**
 * Shared image acquisition for content-creation tools.
 *
 * One canonical function — `acquireImages` — fetches/reads, validates,
 * and caches images for every tool that embeds them (pptx, docx, pdf,
 * xlsx, html). All tools call this; no parallel image logic anywhere.
 *
 * Network fetches go through the same SSRF gate as `web_fetch` and
 * `http_request` (`dnsPinCheck` in src/browser/guards.ts). Blocked
 * fetches throw — callers surface the error to the user; we never
 * fall back to a placeholder.
 *
 * Cache: by sha256(url) under ~/.lax/image-cache/. URL is treated as
 * immutable content for a session; no eviction (TODO: bounded cache).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { dnsPinCheck } from "../../browser/guards.js";

export interface ImageSpec {
  /** URL (http(s)://...) or local path (absolute, or relative to workspaceRoot). Auto-detected. */
  source: string;
  /** Optional caption text; tools that support captions use it, tools that don't ignore. */
  caption?: string;
}

export interface AcquiredImage {
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
  width: number;
  height: number;
  caption?: string;
  source: string;
}

export interface AcquireOptions {
  workspaceRoot?: string;
  maxBytes?: number;
  maxDim?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_DIM = 4096;
const ALLOWED_MIME = new Set<AcquiredImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

function cacheDir(): string {
  return join(homedir(), ".lax", "image-cache");
}

function cachePathFor(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex");
  return join(cacheDir(), hash);
}

async function readCached(url: string): Promise<Buffer | null> {
  const p = cachePathFor(url);
  if (!existsSync(p)) return null;
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

async function writeCached(url: string, buf: Buffer): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePathFor(url), buf);
  } catch {
    // Cache write failure is non-fatal; image already in memory.
  }
}

/** Sniff MIME type from buffer magic bytes. SVG is text — detected from leading content. */
function detectMime(buf: Buffer): AcquiredImage["mimeType"] | null {
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

/** Parse image dimensions from buffer. Minimal inline parsers — png/jpeg/gif/webp/svg. */
function parseDimensions(
  buf: Buffer,
  mime: AcquiredImage["mimeType"],
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

function describeSource(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

async function fetchFromUrl(url: string): Promise<Buffer> {
  const cached = await readCached(url);
  if (cached) return cached;

  const blocked = await dnsPinCheck(url);
  if (blocked) throw new Error(`Image fetch blocked for ${describeSource(url)}: ${blocked}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "LocalAgentX/0.1",
      Accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/*",
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Image fetch failed for ${describeSource(url)}: HTTP ${res.status} ${res.statusText}`);
  }
  // Re-pin final URL after redirects in case the server bounced us to a private host.
  const finalUrl = res.url || url;
  if (finalUrl !== url) {
    const blockedFinal = await dnsPinCheck(finalUrl);
    if (blockedFinal) throw new Error(`Image fetch blocked after redirect for ${describeSource(url)}: ${blockedFinal}`);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  await writeCached(url, buf);
  return buf;
}

function resolveLocalPath(source: string, workspaceRoot: string): string {
  if (isAbsolute(source)) return resolve(source);
  // Block path traversal: resolved file must stay under workspaceRoot.
  const base = resolve(workspaceRoot);
  const resolved = resolve(base, source);
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) {
    throw new Error(`Path traversal blocked for "${source}" — must resolve under ${base}`);
  }
  // Defensive: normalize and check no leading ".." escapes after normalization.
  if (normalize(source).split(sep).includes("..") && !resolved.startsWith(baseWithSep) && resolved !== base) {
    throw new Error(`Path traversal blocked for "${source}"`);
  }
  return resolved;
}

async function acquireOne(spec: ImageSpec, workspaceRoot: string, maxBytes: number, maxDim: number): Promise<AcquiredImage> {
  const src = spec.source;
  if (!src || typeof src !== "string") throw new Error("ImageSpec.source must be a non-empty string");

  let buf: Buffer;
  if (/^https?:\/\//i.test(src)) {
    buf = await fetchFromUrl(src);
  } else {
    const localPath = resolveLocalPath(src, workspaceRoot);
    try {
      buf = await readFile(localPath);
    } catch (e) {
      throw new Error(`Could not read image "${describeSource(src)}": ${(e as Error).message}`);
    }
  }

  if (buf.length > maxBytes) {
    throw new Error(`Image "${describeSource(src)}" exceeds size cap (${buf.length} > ${maxBytes} bytes)`);
  }

  const mime = detectMime(buf);
  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new Error(`Image "${describeSource(src)}" has unsupported or undetectable type (detected: ${mime ?? "unknown"})`);
  }

  const dims = parseDimensions(buf, mime);
  if (!dims) {
    throw new Error(`Could not determine dimensions of image "${describeSource(src)}" (${mime})`);
  }
  if (dims.width > maxDim || dims.height > maxDim) {
    throw new Error(`Image "${describeSource(src)}" exceeds dimension cap (${dims.width}x${dims.height} > ${maxDim}x${maxDim})`);
  }

  return {
    buffer: buf,
    mimeType: mime,
    width: dims.width,
    height: dims.height,
    caption: spec.caption,
    source: src,
  };
}

/**
 * Acquire a list of images. Throws on the first failure (does NOT
 * silently skip — partial success hides bugs). Returns results in
 * the same order as the input specs.
 */
export async function acquireImages(
  specs: ImageSpec[],
  opts: AcquireOptions = {},
): Promise<AcquiredImage[]> {
  if (!Array.isArray(specs) || specs.length === 0) return [];
  const workspaceRoot = opts.workspaceRoot ?? resolve(process.cwd(), "workspace");
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM;
  const out: AcquiredImage[] = [];
  for (const spec of specs) {
    out.push(await acquireOne(spec, workspaceRoot, maxBytes, maxDim));
  }
  return out;
}

/** Schema fragment for the `images` field. Identical across all content tools. */
export const IMAGES_PARAM_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      source: { type: "string", description: "URL or local path (absolute or relative to workspace/)" },
      caption: { type: "string", description: "Optional caption" },
    },
    required: ["source"],
  },
  description: "Optional images to embed. Source can be a URL (http(s)://) or a local file path.",
} as const;
