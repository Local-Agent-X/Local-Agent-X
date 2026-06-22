/**
 * Shared helpers for the image-tools modules — provider resolution,
 * ToolResult shorthand, recent-local-image fallback for video gen, and
 * the prompt regex that signals the user is referring to an earlier image.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolResult } from "../../types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings } from "../../settings.js";
import type { SecretsStore } from "../../secrets.js";
import { resolveCredential } from "../../auth/resolve.js";

export function ok(content: string): ToolResult { return { content }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

/** Absolute path to a subdir (images/videos/…) of the CANONICAL workspace.
 *  The static file server serves /images, /videos and /files from
 *  resolve(config.workspace, subdir); generated media MUST be written to the
 *  same root or it 404s. The packaged desktop app relocates the workspace to
 *  ~/Documents, so a cwd-relative "workspace/" diverges from where the server
 *  reads — that divergence is exactly what makes generated videos render as a
 *  dead player. Single source of truth: always resolve against config.workspace. */
export function workspaceDir(subdir: string): string {
  return resolve(getRuntimeConfig().workspace, subdir);
}

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

/** Like ok(), but rides a saved video file PATH on `_media` so the
 *  WhatsApp/Telegram bridge reads it off disk and forwards it as a video.
 *  Path, not bytes — videos are too big to base64 onto the result and the
 *  model can't watch them. */
export function okWithVideo(content: string, path: string, mime = "video/mp4"): ToolResult {
  return { content, _media: { kind: "video", path, mime } };
}

let _secretsStore: SecretsStore | undefined;

/** Call this at startup to inject the secrets store for API-based image generation */
export function initImageTools(secrets: SecretsStore) {
  _secretsStore = secrets;
}

/** Resolve the API key for a media backend id. For xai/openai this prefers
 *  the SuperGrok / X Premium+ (or OpenAI) OAuth bearer over a raw API key —
 *  same wire shape, but draws from subscription quota instead of API spend.
 *  `local` needs no key. */
async function keyForProvider(provider: string): Promise<string | undefined> {
  if (provider === "xai" || provider === "openai") {
    return (await resolveCredential(provider))?.credential || undefined;
  }
  return undefined;
}

/** Get the active chat provider + its API key from settings + secrets. */
export async function getActiveProvider(): Promise<{ provider: string; apiKey?: string }> {
  const s = loadSettings() as { provider?: string };
  const provider = s.provider || "local";
  return { provider, apiKey: await keyForProvider(provider) };
}

/** Map a user/model-supplied backend name to a canonical id. Returns null
 *  for unrecognized names so a garbage override is ignored rather than
 *  silently mis-routing. */
function normalizeMediaProvider(name?: string): string | null {
  const n = (name || "").trim().toLowerCase();
  if (!n) return null;
  if (["xai", "grok", "grok-imagine", "imagine", "x"].includes(n)) return "xai";
  if (["openai", "dalle", "dall-e", "dall·e", "gpt"].includes(n)) return "openai";
  if (["local", "sd", "stable-diffusion", "stable", "cogvideox", "cog"].includes(n)) return "local";
  return null;
}

/**
 * Resolve which backend an image/video tool should use, by precedence:
 *   1. explicit per-call override ("generate this with grok") → forced
 *   2. media default: prefer Grok whenever xAI is connected, unless the user
 *      turned off `preferGrokForMedia` in Settings → Media
 *   3. the active chat provider (getActiveProvider)
 *
 * `forced` is true only in case 1 so the caller can surface a clear error
 * when the user explicitly names a backend that isn't connected (rather than
 * silently falling back to local SD).
 */
export async function resolveMediaProvider(
  explicit?: string,
): Promise<{ provider: string; apiKey?: string; forced: boolean }> {
  const forced = normalizeMediaProvider(explicit);
  if (forced) return { provider: forced, apiKey: await keyForProvider(forced), forced: true };

  const s = loadSettings() as { preferGrokForMedia?: boolean };
  if (s.preferGrokForMedia !== false) {
    const apiKey = await keyForProvider("xai");
    if (apiKey) return { provider: "xai", apiKey, forced: false };
  }
  return { ...(await getActiveProvider()), forced: false };
}

/** Find the most recent image across uploads + workspace/images. Used as
 *  an implicit reference fallback when Grok asks to generate a video but
 *  doesn't pass reference_images (xAI's tool-use RLHF is unreliable about
 *  threading attached/generated images into follow-up calls). */
export function findRecentLocalImage(): string | null {
  const candidates: Array<{ path: string; mtime: number }> = [];
  const exts = /\.(png|jpg|jpeg|webp)$/i;
  for (const dir of [workspaceDir("images"), join(getLaxDir(), "uploads")]) {
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
