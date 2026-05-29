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

export interface ImageRef {
  url: string;
  name: string;
  filePath?: string;
}

export type OpenAIVisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export function imagesToOpenAIParts(text: string, images: ImageRef[]): OpenAIVisionPart[] {
  const parts: OpenAIVisionPart[] = [{ type: "text", text }];
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
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
      if (img.filePath) filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch {
      // Skip unreadable attachments rather than fail the whole turn.
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
  return parts;
}
