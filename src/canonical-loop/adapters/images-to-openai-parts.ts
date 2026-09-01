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
import { basename } from "node:path";

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
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        dataUrl = `data:${mime};base64,${data.toString("base64")}`;
      } else {
        // Neither inline bytes nor an on-disk path — nothing to read.
        parts.push({ type: "text", text: unreadableNote(img) });
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
      parts.push({ type: "text", text: unreadableNote(img, err) });
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

/** Non-empty stand-in for an attachment whose bytes could not be sent.
 *  Names the file (display name, else path basename) plus the errno code
 *  when there is one; never leaks the absolute path. */
function unreadableNote(img: ImageRef, err?: unknown): string {
  const label = img.name || (img.filePath ? basename(img.filePath) : "image");
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;
  return `[Attachment ${label} could not be read${code ? ` (${code})` : ""}]`;
}
