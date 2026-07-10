/**
 * Shared image acquisition for content-creation tools.
 *
 * One canonical function — `acquireImages` — fetches/reads, validates,
 * and caches images for every tool that embeds them (pptx, docx, pdf,
 * xlsx, html). All tools call this; no parallel image logic anywhere.
 *
 * Network fetches go through the same hardened SSRF gate as `web_fetch`
 * and `http_request` (`canonicalFetch` in src/tools/web-egress.ts:
 * per-hop literal-IP + DNS-pin + scheme check, fail-closed).
 *
 * URL failures climb a reliability ladder instead of all-or-nothing:
 * try the spec's `fallback_source` automatically, else drop that one
 * image with a note, and only when EVERY spec fails throw — so a single
 * walled host can't zero out a document, and a document that requested
 * images is never quietly created without any. Every degradation is
 * named in the returned notes; nothing is silent, no placeholders.
 *
 * Cache: by sha256(url) under ~/.lax/image-cache/. URL is treated as
 * immutable content for a session; no eviction (TODO: bounded cache).
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readValidatedFile } from "../../security/validated-io.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { workspacePath } from "../../config.js";
import { canonicalFetch, EgressRedirectBlocked, BROWSER_USER_AGENT, BROWSER_ACCEPT_LANGUAGE } from "../web-egress.js";
import { detectMime, parseDimensions, type ImageMimeType } from "./image-binary-meta.js";

export interface ImageSpec {
  /** URL (http(s)://...) or local path (absolute, or relative to workspaceRoot). Auto-detected. */
  source: string;
  /** Alternate URL tried automatically when `source` fails — image_search
   *  returns one per hit (the search engine's own CDN thumbnail, which stays
   *  fetchable when the origin site walls off non-browser clients). The
   *  switch is reported in the outcome notes, never silent. */
  fallback_source?: string;
  /** Optional caption text; tools that support captions use it, tools that don't ignore. */
  caption?: string;
  /** Accessibility alt text (screen readers). Falls back to caption, then a
   *  label derived from the source. */
  alt?: string;
}

export interface AcquiredImage {
  buffer: Buffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  caption?: string;
  alt?: string;
  source: string;
}

/** Accessibility alt text for an embedded image: explicit alt → caption → a
 *  label derived from the source (filename or host). Never empty. */
export function imageAltText(img: { alt?: string; caption?: string; source: string }): string {
  if (img.alt?.trim()) return img.alt.trim();
  if (img.caption?.trim()) return img.caption.trim();
  const s = img.source;
  if (/^https?:\/\//i.test(s)) {
    try { return `Image from ${new URL(s).hostname}`; } catch { /* fall through */ }
  }
  const base = s.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base ? `Image: ${base}` : "Image";
}

export interface AcquireOptions {
  workspaceRoot?: string;
  maxBytes?: number;
  maxDim?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_DIM = 4096;
export const ALLOWED_MIME = new Set<AcquiredImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

function cacheDir(): string {
  return join(getLaxDir(), "image-cache");
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

function describeSource(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

// Per-image fetch budget. 8s, not the 30s general-fetch default: one dead
// image URL used to stall a whole document_create for 30s and then fail it
// (2026-06-10, six timeouts in one session). A photo host that hasn't
// responded in 8s isn't going to; failing fast lets the model swap that one
// source instead of burning half a minute per retry.
const IMAGE_FETCH_TIMEOUT_MS = 8_000;

async function fetchFromUrl(url: string): Promise<Buffer> {
  const cached = await readCached(url);
  if (cached) return cached;

  // Route through the ONE hardened pinned fetch (per-hop literal-IP + DNS-pin +
  // scheme check, fail-closed) — same SSRF coverage web_fetch gets. This
  // supersedes the old final-only DNS pre-check: every redirect hop is validated
  // BEFORE connecting, so a 302 to a private/metadata host can't slip through.
  //
  // The body read stays INSIDE the wrapping try: the abort timer covers it
  // too, and an unwrapped arrayBuffer() rejection surfaced as a bare
  // "operation was aborted due to timeout" with no URL — the model couldn't
  // tell WHICH image to swap and re-rolled the whole document blind.
  let buf: Buffer;
  try {
    const res = await canonicalFetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/*",
        "Accept-Language": BROWSER_ACCEPT_LANGUAGE,
      },
      timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof EgressRedirectBlocked) {
      throw new Error(`Image fetch blocked for ${describeSource(url)}: ${e.message}`);
    }
    const msg = (e as Error).name === "TimeoutError" || /aborted due to timeout/i.test((e as Error).message)
      ? `timed out after ${IMAGE_FETCH_TIMEOUT_MS / 1000}s — drop or replace this image source`
      : (e as Error).message;
    throw new Error(`Image fetch failed for ${describeSource(url)}: ${msg}`);
  }
  await writeCached(url, buf);
  return buf;
}

function resolveLocalPath(source: string, workspaceRoot: string): string {
  // BOTH absolute and relative sources must resolve to a file UNDER the
  // workspace. The absolute branch previously returned resolve(source) with no
  // containment check — an agent could embed ANY image file from anywhere on
  // disk (a private photo, or past the mime gate an arbitrary file) into a
  // generated document, side-stepping the file-access boundary that gates the
  // document's own path. This helper's contract is "local image, relative to
  // workspaceRoot"; confine both forms to honor it. (External images stay
  // reachable via http(s):// URLs, which route through the egress gate.)
  // realpath BOTH the workspace root and the resolved target before the
  // containment check. The lexical resolve()+startsWith left a symlink hole: a
  // workspace file `logo.png → /private/tmp/secret.txt` passes a lexical check
  // (its NAME is under the workspace) but reads OUTSIDE it. realpathSync follows
  // every symlink/junction segment, so the containment test compares the real
  // on-disk inode against the real workspace root — a link that escapes the
  // workspace fails. This is a READ path, so the target must already exist; if
  // realpath throws (ENOENT/ELOOP/…) the read can't succeed anyway, so reject.
  // Lexical containment FIRST, against the LEXICAL workspace root: a `..`-escape
  // or out-of-tree absolute path is rejected before we ever touch the
  // filesystem, with the explicit traversal message (and without leaking "no
  // such file" for a path that was never allowed to be probed).
  const lexicalBase = resolve(workspaceRoot);
  const lexicalBaseWithSep = lexicalBase.endsWith(sep) ? lexicalBase : lexicalBase + sep;
  const lexical = isAbsolute(source) ? resolve(source) : resolve(lexicalBase, source);
  if (lexical !== lexicalBase && !lexical.startsWith(lexicalBaseWithSep)) {
    throw new Error(`Path traversal blocked for "${source}" — image must resolve under the workspace (${lexicalBase})`);
  }

  // THEN realpath + re-assert containment against the REALPATH'd root: a path
  // whose NAME is under the workspace but whose REALPATH escapes it (logo.png →
  // /private/tmp/secret) is caught here. realpathSync follows every symlink/
  // junction segment, so the containment test compares the real on-disk inode
  // against the real workspace root — and realpath'ing BOTH sides keeps them
  // comparable when the workspace root itself sits under a symlink (macOS temp
  // dirs are /var → /private/var). This is a READ path — the target must exist;
  // if realpath throws (ENOENT for a missing file, ELOOP for a symlink cycle)
  // the read can't succeed anyway, so surface it as a read error.
  let realBase: string;
  try {
    realBase = realpathSync(lexicalBase);
  } catch (e) {
    throw new Error(`Could not resolve workspace root for "${source}": ${(e as Error).message}`);
  }
  const realBaseWithSep = realBase.endsWith(sep) ? realBase : realBase + sep;
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch (e) {
    throw new Error(`Could not read image "${describeSource(source)}": ${(e as Error).message}`);
  }
  if (real !== realBase && !real.startsWith(realBaseWithSep)) {
    throw new Error(`Path traversal blocked for "${source}" — image must resolve under the workspace (${realBase})`);
  }
  return real;
}

function validateImage(buf: Buffer, src: string, spec: ImageSpec, maxBytes: number, maxDim: number): AcquiredImage {
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
    alt: spec.alt,
    source: src,
  };
}

async function acquireLocal(spec: ImageSpec, workspaceRoot: string, maxBytes: number, maxDim: number): Promise<AcquiredImage> {
  const localPath = resolveLocalPath(spec.source, workspaceRoot);
  let buf: Buffer;
  try {
    // Read the realpath'd, contained inode with O_NOFOLLOW on the leaf
    // (readValidatedFile) so a symlink swapped in at the leaf between the
    // realpath containment check above and this read is rejected, not
    // followed — closing the read-leg TOCTOU on the same inode we validated.
    buf = readValidatedFile(localPath);
  } catch (e) {
    throw new Error(`Could not read image "${describeSource(spec.source)}": ${(e as Error).message}`);
  }
  return validateImage(buf, spec.source, spec, maxBytes, maxDim);
}

/** Fetch+validate a URL spec, automatically falling back to `fallback_source`
 *  when the origin fails either step (a fallback can also rescue an origin
 *  that fetched but failed validation — e.g. an original past the size cap
 *  whose CDN thumbnail fits). The switch is reported via the returned note. */
async function acquireFromUrl(spec: ImageSpec, maxBytes: number, maxDim: number): Promise<{ img: AcquiredImage; note?: string }> {
  try {
    return { img: validateImage(await fetchFromUrl(spec.source), spec.source, spec, maxBytes, maxDim) };
  } catch (originErr) {
    const fb = spec.fallback_source;
    if (!fb || !/^https?:\/\//i.test(fb) || fb === spec.source) throw originErr;
    let img: AcquiredImage;
    try {
      img = validateImage(await fetchFromUrl(fb), fb, spec, maxBytes, maxDim);
    } catch (fbErr) {
      throw new Error(`origin: ${(originErr as Error).message}; fallback: ${(fbErr as Error).message}`);
    }
    return { img, note: `used fallback URL for ${describeSource(spec.source)} — origin failed: ${(originErr as Error).message}` };
  }
}

/** Every requested image failed — thrown so a tool can never report success
 *  on a document the caller asked to illustrate. Distinct class so per-slide
 *  callers can degrade THIS case to a note while real caller errors
 *  (traversal, missing local file) still propagate. */
export class AllImagesFailedError extends Error {
  constructor(public readonly failures: string[], specCount: number) {
    super(
      `All ${specCount} image source(s) failed:\n${failures.join("\n")}\n` +
      "Run image_search for replacement URLs (each result includes a fallback URL — pass it as fallback_source), " +
      "or omit images to create the file without them.",
    );
    this.name = "AllImagesFailedError";
  }
}

export interface AcquireOutcome {
  /** Successfully acquired images, in input order (dropped URL specs omitted). */
  images: AcquiredImage[];
  /** Loud per-image reports — fallbacks used, sources dropped. Callers MUST
   *  surface these in the tool result text. */
  notes: string[];
}

/**
 * Acquire a list of images with a reliability ladder instead of
 * all-or-nothing:
 *   1. a URL spec whose origin fails is retried on its `fallback_source`
 *      automatically (noted);
 *   2. a URL spec that fails both ways is dropped with a note naming the
 *      cause — one dead host can't zero out a whole document;
 *   3. if EVERY spec fails, throws AllImagesFailedError.
 * Local-path failures throw immediately: they're deterministic caller errors
 * (or traversal attempts), not flaky hosts.
 */
export async function acquireImages(
  specs: ImageSpec[],
  opts: AcquireOptions = {},
): Promise<AcquireOutcome> {
  if (!Array.isArray(specs) || specs.length === 0) return { images: [], notes: [] };
  const workspaceRoot = opts.workspaceRoot ?? workspacePath();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM;
  const images: AcquiredImage[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  for (const spec of specs) {
    if (!spec?.source || typeof spec.source !== "string") throw new Error("ImageSpec.source must be a non-empty string");
    if (/^https?:\/\//i.test(spec.source)) {
      try {
        const { img, note } = await acquireFromUrl(spec, maxBytes, maxDim);
        images.push(img);
        if (note) notes.push(note);
      } catch (e) {
        const msg = `dropped image ${describeSource(spec.source)}: ${(e as Error).message}`;
        notes.push(msg);
        failures.push(msg);
      }
    } else {
      images.push(await acquireLocal(spec, workspaceRoot, maxBytes, maxDim));
    }
  }
  if (images.length === 0 && failures.length > 0) {
    throw new AllImagesFailedError(failures, specs.length);
  }
  return { images, notes };
}

/** Schema fragment for the `images` field. Identical across all content tools. */
export const IMAGES_PARAM_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      source: { type: "string", description: "URL or local path (absolute or relative to workspace/)" },
      fallback_source: { type: "string", description: "Alternate URL tried automatically if source fails (image_search results include one — always pass it)" },
      caption: { type: "string", description: "Optional caption" },
      alt: { type: "string", description: "Accessibility alt text (screen readers); defaults to the caption" },
    },
    required: ["source"],
  },
  description: "Optional images to embed. Source can be a URL (http(s)://) or a local file path. " +
    "Don't have a URL? Call image_search to find a photo, or create_chart to render a data chart, then pass the path/URL here. " +
    "Pass each image_search result's fallback URL as fallback_source — a blocked origin then auto-falls back to the search CDN copy (reported in the result).",
} as const;
