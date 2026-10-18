/**
 * Shared helpers for the image-tools modules — provider resolution,
 * ToolResult shorthand, recent-local-image fallback for video gen, and
 * the prompt regex that signals the user is referring to an earlier image.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolResult } from "../../types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings } from "../../settings.js";
import type { SecretsStore } from "../../secrets.js";
import { resolveCredential } from "../../auth/resolve.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { imageEngineSetting, type ImageEngine } from "./image-engine.js";

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

/** Resolve the credential for a media backend id. For xai this prefers the
 *  SuperGrok / X Premium+ OAuth bearer over a raw API key — same wire shape,
 *  but draws from subscription quota instead of API spend. `codex` is the
 *  ChatGPT sign-in's token (refreshed by src/auth/), `openai` the API key.
 *  `local` needs no key. */
async function keyForProvider(provider: string): Promise<string | undefined> {
  if (provider === "xai" || provider === "openai" || provider === "codex") {
    return (await resolveCredential(provider))?.credential || undefined;
  }
  return undefined;
}

/** A media backend id as the user knows it, for error text. A chat provider
 *  with no media backend of its own reads as OpenAI, the API-key default. */
export function mediaProviderLabel(provider: string): string {
  if (provider === "xai") return "Grok/xAI";
  if (provider === "codex") return "ChatGPT (subscription sign-in)";
  if (provider === "local") return "local Stable Diffusion";
  return "OpenAI (API key)";
}

/** The provider the user chats on (settings.provider). */
function activeChatProvider(): string {
  return (loadSettings() as { provider?: string }).provider || "local";
}

/** The image engine a chat provider belongs to, or null for one with none
 *  (Anthropic, Gemini, local, ...). */
function engineOfChatProvider(provider: string): ImageEngine | null {
  if (provider === "xai") return "grok";
  if (provider === "codex" || provider === "openai") return "chatgpt";
  return null;
}

const ENGINE_NAME: Record<ImageEngine, string> = { grok: "Grok", chatgpt: "ChatGPT" };

type Backend = { provider: string; apiKey: string };

/** The connected backend of an engine, or null. ChatGPT is the subscription
 *  sign-in when there is one, so the image bills the plan rather than API
 *  spend, else the OpenAI API key. */
async function connectedBackend(engine: ImageEngine): Promise<Backend | null> {
  for (const provider of engine === "grok" ? ["xai"] : ["codex", "openai"]) {
    const apiKey = await keyForProvider(provider);
    if (apiKey) return { provider, apiKey };
  }
  return null;
}

/** Map a user/model-supplied backend name to a canonical id. Returns null
 *  for unrecognized names so a garbage override is ignored rather than
 *  silently mis-routing. */
function normalizeMediaProvider(name?: string): string | null {
  const n = (name || "").trim().toLowerCase();
  if (!n) return null;
  if (["xai", "grok", "grok-imagine", "imagine", "x"].includes(n)) return "xai";
  if (["openai", "dalle", "dall-e", "dall·e", "gpt"].includes(n)) return "openai";
  if (["chatgpt", "codex"].includes(n)) return "codex";
  if (["local", "sd", "stable-diffusion", "stable", "cogvideox", "cog"].includes(n)) return "local";
  return null;
}

export type ResolvedMedia = {
  provider: string;
  apiKey?: string;
  forced: boolean;
  /** Set when the default engine wasn't connected and the other one was
   *  used; the tool adds it to its result so the switch is never silent. */
  note?: string;
};

/**
 * Resolve which backend an image or video tool should use.
 *
 * Image, by precedence:
 *   1. explicit per-call override ("generate this with grok") → forced.
 *      Explicit `openai` is always the API key.
 *   2. the engine of the chat provider: Grok for xAI, ChatGPT for the
 *      ChatGPT sign-in or the OpenAI API-key provider (connectedBackend).
 *   3. any other chat provider: the default engine (`imageEngine`, Settings →
 *      Media); when it isn't connected, the other engine, with a `note`.
 *   4. neither engine connected: the chat provider, which the tools treat
 *      as local Stable Diffusion.
 *
 * Video has no ChatGPT backend, so it is Grok whenever xAI is connected and
 * the image setting never moves it; otherwise local CogVideoX.
 *
 * `forced` is true only in case 1 so the caller can surface a clear error
 * when the user explicitly names a backend that isn't connected (rather than
 * silently falling back to local SD).
 */
export async function resolveMediaProvider(
  explicit?: string,
  kind: "image" | "video" = "image",
): Promise<ResolvedMedia> {
  const forced = normalizeMediaProvider(explicit);
  if (forced) return { provider: forced, apiKey: await keyForProvider(forced), forced: true };

  if (kind === "video") {
    const grok = await connectedBackend("grok");
    return grok ? { ...grok, forced: false } : { provider: "local", forced: false };
  }

  const chatProvider = activeChatProvider();
  const chatEngine = engineOfChatProvider(chatProvider);
  const chatBackend = chatEngine && await connectedBackend(chatEngine);
  if (chatBackend) return { ...chatBackend, forced: false };

  const preferred = imageEngineSetting();
  const preferredBackend = await connectedBackend(preferred);
  if (preferredBackend) return { ...preferredBackend, forced: false };
  const other: ImageEngine = preferred === "grok" ? "chatgpt" : "grok";
  const otherBackend = await connectedBackend(other);
  if (otherBackend) {
    return { ...otherBackend, forced: false, note: `Made with ${ENGINE_NAME[other]}; ${ENGINE_NAME[preferred]} isn't connected.` };
  }
  return { provider: chatProvider, forced: false };
}

/** `result` with the resolver's note, if any, as its last line. A failed call
 *  made nothing, so it is not told "Made with …". */
export function withMediaNote(result: ToolResult, note: string | undefined): ToolResult {
  return note && !result.isError ? { ...result, content: `${result.content}\n${note}` } : result;
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

/** Resolve a model/user-supplied image reference to an absolute LOCAL file
 *  path, or null for external URLs / unknown shapes. Accepts a direct
 *  path (resolved with the calling session, as the file-access gate resolved
 *  it), the chat tool-result URL (/images/foo.png), the upload
 *  URL (/uploads/foo.png), the workspace-relative paths Grok sometimes echoes
 *  (workspace/images|uploads/foo.png), and a bare image filename it
 *  hallucinates — checking workspace/images first, then uploads. xAI's
 *  backend can't reach 127.0.0.1 loopback URLs, so callers inline locals as
 *  base64 via imageFileToDataUrl(). */
export function resolveLocalImagePath(u: string, sessionId: string | undefined): string | null {
  const s = (u || "").trim();
  if (!s) return null;
  try {
    const direct = resolveAgentPath(s, sessionId);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
  } catch { /* not a direct path */ }
  const m =
    s.match(/(?:^\/images\/|^workspace\/images\/)([A-Za-z0-9._-]+)/) ||
    s.match(/(?:^\/uploads\/|^workspace\/uploads\/)([A-Za-z0-9._-]+)/) ||
    s.match(/^([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))$/i);
  if (m) {
    const fname = m[1];
    const fromImages = join(workspaceDir("images"), fname);
    if (existsSync(fromImages)) return fromImages;
    const fromUploads = join(getLaxDir(), "uploads", fname);
    if (existsSync(fromUploads)) return fromUploads;
  }
  return null;
}

/** Read a local image file into a `data:` URL, mime guessed from extension. */
export function imageFileToDataUrl(filePath: string): string {
  const ext = (filePath.split(".").pop() || "png").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;
}
