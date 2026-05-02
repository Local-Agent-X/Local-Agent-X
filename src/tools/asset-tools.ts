import { promises as dns } from "node:dns";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, join, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.asset-tools");

const MAX_IMAGES_DEFAULT = 30;
const MAX_BYTES_PER_IMAGE_DEFAULT = 8 * 1024 * 1024;
const TOTAL_BYTES_CAP = 80 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".svg"]);
const ALLOWED_MIME_PREFIX = "image/";

async function dnsPinUrl(url: string): Promise<string | null> {
  try {
    const host = new URL(url).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
    const addrs = await dns.resolve4(host).catch(() => [] as string[]);
    for (const ip of addrs) {
      const parts = ip.split(".").map(Number);
      const [a, b] = parts;
      if (a === 127 || a === 10 || a === 0 || a >= 224) return `Blocked (private/loopback): ${host}`;
      if (a === 192 && b === 168) return `Blocked (private): ${host}`;
      if (a === 172 && b >= 16 && b <= 31) return `Blocked (private): ${host}`;
      if (a === 169 && b === 254) return `Blocked (link-local): ${host}`;
    }
  } catch { /* DNS miss is fine */ }
  return null;
}

function absolutize(url: string, base: string): string | null {
  try { return new URL(url, base).toString(); } catch { return null; }
}

function extractFromHtml(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const push = (raw: string) => {
    const u = absolutize(raw.trim(), baseUrl);
    if (u) out.add(u);
  };

  // <img src="...">
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  // <img data-src="..."> (lazy-load patterns)
  for (const m of html.matchAll(/<img\b[^>]*?\bdata-src\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  // srcset (take the largest URL — first token of each comma-sep entry)
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const entry of m[1].split(",")) {
      const url = entry.trim().split(/\s+/)[0];
      if (url) push(url);
    }
  }
  // <source srcset="..."> inside <picture>
  for (const m of html.matchAll(/<source\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const entry of m[1].split(",")) {
      const url = entry.trim().split(/\s+/)[0];
      if (url) push(url);
    }
  }
  // og:image / twitter:image
  for (const m of html.matchAll(/<meta\b[^>]*?\bproperty\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*?\bcontent\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<meta\b[^>]*?\bname\s*=\s*["'](?:twitter:image|twitter:image:src)["'][^>]*?\bcontent\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  // <link rel="image_src" href="...">
  for (const m of html.matchAll(/<link\b[^>]*?\brel\s*=\s*["']image_src["'][^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  // background-image: url(...) — inline styles only
  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1]);
  // Instagram CDN URLs hiding in JSON/script blobs
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]*?(?:cdninstagram|fbcdn|scontent)[^\s"'<>]*?\.(?:jpg|jpeg|png|webp)/gi)) push(m[0]);

  return Array.from(out);
}

function looksLikeImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const ext = extname(u.pathname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return true;
    // CDNs strip extensions; we'll still try and validate by Content-Type
    if (/cdninstagram|fbcdn|scontent|cloudinary|imgix|akamaized/i.test(u.hostname)) return true;
    return false;
  } catch { return false; }
}

function safeFilename(url: string, fallbackIndex: number, mime?: string): string {
  let name = "";
  try {
    name = basename(new URL(url).pathname);
  } catch { /* fall through */ }
  name = name.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  if (!name || name.length < 3) {
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
    name = `img-${fallbackIndex}-${hash}`;
  }
  if (!extname(name)) {
    const ext = mime?.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg");
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) name += `.${ext}`;
  }
  return name;
}

async function fetchWithTimeout(url: string, accept: string, ms: number): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LocalAgentX/1.0)",
      Accept: accept,
    },
    signal: AbortSignal.timeout(ms),
    redirect: "follow",
  });
}

function ensureInsideCwd(p: string): string {
  const abs = resolvePath(p);
  const cwd = resolvePath(process.cwd());
  if (!abs.startsWith(cwd)) {
    throw new Error(`output_dir must be inside the workspace. Got: ${abs}`);
  }
  return abs;
}

interface DownloadedImage {
  url: string;
  path: string;
  bytes: number;
  mime: string;
}

async function downloadOne(
  url: string,
  outDir: string,
  index: number,
  maxBytes: number,
  usedNames: Set<string>,
): Promise<DownloadedImage | { url: string; error: string }> {
  const pinErr = await dnsPinUrl(url);
  if (pinErr) return { url, error: pinErr };
  let res: Response;
  try {
    res = await fetchWithTimeout(url, "image/*,*/*;q=0.8", FETCH_TIMEOUT_MS);
  } catch (e) {
    return { url, error: `fetch failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { url, error: `HTTP ${res.status}` };
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith(ALLOWED_MIME_PREFIX)) return { url, error: `not an image (mime=${mime})` };
  const len = Number(res.headers.get("content-length") || "0");
  if (len > maxBytes) return { url, error: `too large (${len} > ${maxBytes})` };
  let buf: ArrayBuffer;
  try { buf = await res.arrayBuffer(); } catch (e) { return { url, error: `read failed: ${(e as Error).message}` }; }
  if (buf.byteLength > maxBytes) return { url, error: `too large after read (${buf.byteLength})` };

  let name = safeFilename(url, index, mime);
  while (usedNames.has(name)) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    name = `${stem}-${index}${ext}`;
    index += 1;
  }
  usedNames.add(name);
  const outPath = join(outDir, name);
  writeFileSync(outPath, Buffer.from(buf));
  return { url, path: outPath, bytes: buf.byteLength, mime };
}

export const extractSiteAssetsTool: ToolDefinition = {
  name: "extract_site_assets",
  description:
    "Download images from a source URL (Instagram, business website, restaurant page, etc.) into a local assets directory. " +
    "Use this BEFORE building a website from source material so the build references real photos instead of placeholders. " +
    "Pulls from <img>, srcset, og:image, twitter:image, inline background-image, and Instagram/Facebook CDN URLs hiding in script tags. " +
    "Returns a manifest of downloaded files (relative paths, bytes, mime). For JS-rendered pages where this returns few images, fall back to the `browser` tool with `evaluate` to scrape after render.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Source page URL." },
      output_dir: {
        type: "string",
        description: "Directory to save into. Relative paths resolve from cwd. Defaults to ./assets/. Will be created if missing.",
      },
      max_images: { type: "integer", description: `Max images to download. Default ${MAX_IMAGES_DEFAULT}.` },
      max_bytes_per_image: {
        type: "integer",
        description: `Per-image size cap in bytes. Default ${MAX_BYTES_PER_IMAGE_DEFAULT}.`,
      },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url || "");
    if (!url) return err("url is required");

    const outputDir = String(args.output_dir || "./assets");
    const maxImages = Math.max(1, Math.min(100, Number(args.max_images ?? MAX_IMAGES_DEFAULT)));
    const maxBytesPerImage = Math.max(
      256 * 1024,
      Math.min(50 * 1024 * 1024, Number(args.max_bytes_per_image ?? MAX_BYTES_PER_IMAGE_DEFAULT)),
    );

    const pinErr = await dnsPinUrl(url);
    if (pinErr) return err(pinErr);

    let outDir: string;
    try { outDir = ensureInsideCwd(outputDir); }
    catch (e) { return err((e as Error).message); }
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    let html: string;
    try {
      const res = await fetchWithTimeout(url, "text/html,application/xhtml+xml", FETCH_TIMEOUT_MS);
      if (!res.ok) return err(`Source page returned HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      return err(`Failed to fetch source: ${(e as Error).message}`);
    }

    const candidates = extractFromHtml(html, url).filter(looksLikeImageUrl);
    if (candidates.length === 0) {
      return ok(
        `No image candidates found at ${url}. The page is likely JS-rendered (Instagram profile, SPA). ` +
        `Use the \`browser\` tool: navigate, then evaluate \`Array.from(document.images).map(i => i.src)\`, then re-run extract_site_assets on a different URL or download those URLs directly via web_fetch.`,
      );
    }

    const limited = candidates.slice(0, maxImages);
    const results: DownloadedImage[] = [];
    const errors: Array<{ url: string; error: string }> = [];
    const usedNames = new Set<string>();
    let totalBytes = 0;
    for (let i = 0; i < limited.length; i++) {
      if (totalBytes >= TOTAL_BYTES_CAP) {
        errors.push({ url: limited[i], error: `total cap ${TOTAL_BYTES_CAP} reached` });
        continue;
      }
      try {
        const r = await downloadOne(limited[i], outDir, i, maxBytesPerImage, usedNames);
        if ("error" in r) errors.push(r);
        else { results.push(r); totalBytes += r.bytes; }
      } catch (e) {
        errors.push({ url: limited[i], error: (e as Error).message });
      }
    }

    const cwd = resolvePath(process.cwd());
    const manifest = {
      source: url,
      output_dir: outDir,
      candidates_found: candidates.length,
      downloaded: results.length,
      total_bytes: totalBytes,
      images: results.map((r) => ({
        url: r.url,
        path: r.path.startsWith(cwd) ? r.path.slice(cwd.length).replace(/^[\\/]/, "") : r.path,
        bytes: r.bytes,
        mime: r.mime,
      })),
      errors: errors.slice(0, 10),
    };

    if (results.length === 0) {
      logger.warn(`[extract_site_assets] 0/${candidates.length} downloaded from ${url}`);
      return err(
        `Found ${candidates.length} candidate URLs but downloaded 0. First errors: ${
          errors.slice(0, 3).map((e) => `${e.url}: ${e.error}`).join(" | ")
        }`,
      );
    }

    const lines = [
      `Downloaded ${results.length}/${candidates.length} images from ${url} → ${outDir}`,
      `Total: ${(totalBytes / 1024).toFixed(1)} KB`,
      "",
      "Use these local paths in your HTML (relative to the served root):",
      ...manifest.images.slice(0, 20).map((img, i) => `  ${i + 1}. ${img.path} (${(img.bytes / 1024).toFixed(0)} KB)`),
    ];
    if (manifest.images.length > 20) lines.push(`  ... and ${manifest.images.length - 20} more`);
    if (errors.length > 0) lines.push("", `Skipped ${errors.length} (size/mime/fetch failures).`);
    return { content: lines.join("\n"), metadata: { manifest } };
  },
};
