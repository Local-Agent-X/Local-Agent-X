/**
 * Shared helpers for the image-tools modules — provider resolution,
 * ToolResult shorthand, recent-local-image fallback for video gen, and
 * the prompt regex that signals the user is referring to an earlier image.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../../types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { loadSettings } from "../../settings.js";
import type { SecretsStore } from "../../secrets.js";
import { resolveCredential } from "../../auth/resolve.js";

export function ok(content: string): ToolResult { return { content }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

/** Like ok(), but rides the generated image bytes on `_image` so the chat
 *  tool dispatcher harvests them — feeds the model the image AND lets the
 *  WhatsApp/Telegram bridge auto-forward it as a photo. Without this,
 *  generate_image returns only a localhost URL the phone can't open. */
export function okWithImage(
  content: string,
  image: { b64: string; path: string; question: string; mime?: string },
): ToolResult {
  return {
    content,
    _image: { mime: image.mime || "image/png", b64: image.b64, path: image.path, question: image.question },
  };
}

let _secretsStore: SecretsStore | undefined;

/** Call this at startup to inject the secrets store for API-based image generation */
export function initImageTools(secrets: SecretsStore) {
  _secretsStore = secrets;
}

/** Get current provider + API key from settings + secrets. For xai, prefer
 *  the SuperGrok / X Premium+ OAuth bearer over the API key — same wire
 *  shape, but the OAuth bearer draws from subscription quota instead of
 *  API spend. */
export async function getActiveProvider(): Promise<{ provider: string; apiKey?: string }> {
  const s = loadSettings() as { provider?: string };
  const provider = s.provider || "local";

  let apiKey: string | undefined;
  if (provider === "xai") {
    const r = await resolveCredential("xai");
    apiKey = r?.credential || undefined;
  } else if (provider === "openai") {
    const r = await resolveCredential("openai");
    apiKey = r?.credential || undefined;
  }

  return { provider, apiKey };
}

/** Find the most recent image across uploads + workspace/images. Used as
 *  an implicit reference fallback when Grok asks to generate a video but
 *  doesn't pass reference_images (xAI's tool-use RLHF is unreliable about
 *  threading attached/generated images into follow-up calls). */
export function findRecentLocalImage(): string | null {
  const candidates: Array<{ path: string; mtime: number }> = [];
  const exts = /\.(png|jpg|jpeg|webp)$/i;
  for (const dir of [join("workspace", "images"), join(getLaxDir(), "uploads")]) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (!exts.test(f)) continue;
        const p = join(dir, f);
        try { candidates.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* skip */ }
      }
    } catch { /* skip dir */ }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/** Regex for "this photo/image/girl/her/him/they" language in a prompt —
 *  signals the user is referencing something in the chat context. */
export const PROMPT_REFS_EARLIER_IMAGE = /\b(this|the|her|him|they|that)\s+(photo|image|picture|girl|woman|man|guy|person|model|character|pic)\b|\battached\s+(image|photo|picture)\b|\bfrom\s+the\s+(image|photo|picture)\b/i;
