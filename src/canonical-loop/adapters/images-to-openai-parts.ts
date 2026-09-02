// Shared image → OpenAI vision content-parts builder. All three transports
// (anthropic, codex, openai-compat) hit this single implementation so the
// wire shape — and the on-disk file-path hint — stays identical across
// providers. Pre-dedup, codex-transport had its own copy without the hint,
// so Codex-routed agents saw image bytes but were never told where the
// file lived on disk; recovery from a wrong-image picked the closest-named
// asset in workspace instead of the actual upload. Anthropic CLI/OAuth has
// always relied on the hint because its proxy strips image_url parts and
// the path is the only way the model gets vision (via the `read` tool).

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { unreadableAttachmentNote } from "../../agent-request/attachments.js";

export interface ImageRef {
  url: string;
  name: string;
  filePath?: string;
}

export type OpenAIVisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export function imagesToOpenAIParts(text: string, images: ImageRef[]): OpenAIVisionPart[] {
  const parts: OpenAIVisionPart[] = [];
  // A persisted image-only user row arrives here as content:"". Anthropic
  // rejects `{type:"text", text:""}` with 400 "text content blocks must be
  // non-empty", so the leading text part is emitted only when there is
  // something to say. Non-whitespace text is forwarded verbatim (no trim);
  // whitespace-only counts as empty because the API treats it the same way.
  if (text.trim().length > 0) parts.push({ type: "text", text });
  const filePathHints: string[] = [];
  for (const img of images) {
    try {
      // Tool-emitted images arrive pre-encoded as a data URL on `url`
      // (no on-disk file). User-attached images come with `filePath`
      // pointing at ~/.lax/uploads/... — read + base64-encode at request
      // time and stash the path for the trailing hint.
      let dataUrl: string;
      if (img.url && img.url.startsWith("data:")) {
        dataUrl = img.url;
      } else if (img.filePath) {
        const data = readFileSync(img.filePath);
        // Mime comes from the file's MAGIC BYTES, falling back to the
        // on-disk path's extension — NEVER the display name (an
        // extension-less name like "photo" used to yield the garbage mime
        // "image/photo", and a lying name could smuggle any bytes under a
        // png label). Formats outside the set every provider path accepts
        // inline (gif/svg/bmp/unknown) degrade to a non-empty note plus the
        // on-disk hint instead of a part that 400s the whole request — one
        // rule HERE, inherited by every transport.
        const mime = sniffImageMime(data) ?? mimeFromPathExt(img.filePath);
        if (!mime || !SUPPORTED_INLINE_IMAGE_MIME.has(mime)) {
          parts.push({ type: "text", text: unsupportedFormatNote(img, mime) });
          filePathHints.push(`  - ${img.name} → ${img.filePath}`);
          continue;
        }
        dataUrl = `data:${mime};base64,${data.toString("base64")}`;
      } else {
        // Neither inline bytes nor an on-disk path — nothing to read.
        parts.push({ type: "text", text: unreadableAttachmentNote(img) });
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
      if (img.filePath) filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch (err) {
      // An unreadable upload (pruned ~/.lax/uploads, stale session row,
      // permissions) must not fail the whole turn — but it must not vanish
      // either. Dropping it silently left a caption-less send with zero
      // parts, and the wire-site sanitizer then told the model the user
      // sent "[empty message]" when they had attached an image. Emit an
      // in-order note so the model knows what was attached and that it
      // is unavailable.
      parts.push({ type: "text", text: unreadableAttachmentNote(img, err) });
    }
  }
  // Trailing text part with on-disk paths. Critical for Anthropic
  // OAuth/subscription chats where extractUserPrompt strips image_url
  // (text-only stdin to the CLI) — the model recovers vision by calling
  // `read` on the path. For HTTP API key paths and Codex/OpenAI the bytes
  // already arrived via image_url; the hint just tells the model where
  // to `bash cp` the file when it needs to land as an app asset.
  if (filePathHints.length > 0) {
    parts.push({
      type: "text",
      text:
        `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
        filePathHints.join("\n") +
        `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
    });
  }
  // Nothing to send at all — empty text AND zero images requested. Keep the
  // historical single-text-part shape rather than an empty content array,
  // which providers reject outright. Unreachable once any image was
  // requested: every ref yields either an image part or a non-empty
  // failure note, so the model is never told the user sent nothing.
  if (parts.length === 0) parts.push({ type: "text", text });
  return parts;
}

// The unreadable-attachment note used above is unreadableAttachmentNote —
// single definition in agent-request/attachments.ts, shared with the
// prepare-time dangling-/uploads check so both seams stay byte-identical.

/** The inline-image mimes EVERY provider path accepts (Gemini's inlineData
 *  set is the narrowest). Anything else — gif/svg/bmp/unknown — becomes a
 *  note: one provider rejecting an inline part fails the whole request. */
export const SUPPORTED_INLINE_IMAGE_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Identify an image by its magic bytes; null = unrecognized. */
function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
  const head = data.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}

/** Fallback mime from the ON-DISK path's extension (never the display name). */
function mimeFromPathExt(filePath: string): string | null {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  return ext ? `image/${ext}` : null;
}

/** Non-empty stand-in for an image whose format no provider takes inline. */
function unsupportedFormatNote(img: ImageRef, mime: string | null): string {
  const label = img.name || (img.filePath ? basename(img.filePath) : "image");
  return `[Attachment ${label} was not sent inline: unsupported image format${mime ? ` (${mime})` : ""}]`;
}
