/**
 * The paid-API switch for images and video (Settings → Media,
 * `allowPaidMediaApis`, off unless the user turns it on). While it is off no
 * image or video call may use a per-use-billed API key: resolveMediaProvider
 * (shared.ts) drops those credentials, http_request refuses a stored secret
 * sent to a provider's image or video route, and secret_env refuses to hand a
 * provider's key to a shell command (the caged shell's proxy sees only the
 * host of a TLS call, never its route). Kept apart from shared.ts so
 * http_request and the shell read it without loading the image tools.
 */
import { loadSettings } from "../../settings.js";
import { PROVIDERS } from "../../providers/registry.js";

/** The Settings → Media label; public/app.html shows the same words. */
export const PAID_MEDIA_SETTING_LABEL = "Allow paid API keys for images and video";

/** What a paid key buys: an OpenAI key images, an xAI key images and video. */
export type PaidMediaKind = "image" | "video" | "image or video";

/** The providers whose API key generate_image, edit_image and generate_video
 *  bill per use, and what each key buys. `codex` is the ChatGPT sign-in, never
 *  a key. Each provider's vault entry is its registry `envKey`. */
export const PAID_MEDIA_KEY_PROVIDERS = { openai: "image", xai: "image or video" } as const satisfies Record<string, PaidMediaKind>;

export type PaidMediaKeyProvider = keyof typeof PAID_MEDIA_KEY_PROVIDERS;

/** True only when the user turned the switch on. */
export function paidMediaApisAllowed(): boolean {
  return loadSettings().allowPaidMediaApis === true;
}

/** The refusal for an explicit paid backend while the switch is off. */
export function paidMediaOffMessage(kind: PaidMediaKind): string {
  return `Paid API ${kind} generation is off — turn on '${PAID_MEDIA_SETTING_LABEL}' in Settings → Media.`;
}

/** The per-use-billed media provider whose API key a vault secret is, or null:
 *  the entry that provider reads, or another entry holding the same value. A
 *  sign-in token is never a vault entry, so it is never one. */
export function paidMediaKeyProvider(
  secretName: string, value: string | undefined, store: { get(name: string): string | undefined } | null,
): PaidMediaKeyProvider | null {
  for (const provider of Object.keys(PAID_MEDIA_KEY_PROVIDERS) as PaidMediaKeyProvider[]) {
    const entry = PROVIDERS[provider].envKey;
    if (secretName === entry || (value !== undefined && store?.get(entry) === value)) return provider;
  }
  return null;
}

/** What to tell the user when no free backend could take the call and the
 *  switch is off: every way to get one. Local Stable Diffusion cannot edit. */
export function noFreeMediaMessage(kind: "image" | "edit" | "video"): string {
  const signIn = kind === "video" ? "sign in with SuperGrok (Settings → Providers)" : "sign in with ChatGPT or SuperGrok (Settings → Providers)";
  const local = kind === "video"
    ? "run local CogVideoX (python workspace/sd-server/video-server.py)"
    : kind === "image" ? "run local Stable Diffusion (python workspace/sd-server/server.py)" : null;
  const what = kind === "edit" ? "image editing" : `${kind} generation`;
  const options = [signIn, ...(local ? [local] : []), `turn on '${PAID_MEDIA_SETTING_LABEL}' in Settings → Media to use an OpenAI or xAI API key, billed per ${kind === "video" ? "video" : "image"}`];
  return `No free ${what} backend is available, and paid API keys are off for images and video. Options: ${options.join("; or ")}.`;
}

/** Which media a URL generates on a per-use-billed provider API, or null.
 *  These are the routes generate_image, edit_image and generate_video call
 *  with an API key; the ChatGPT subscription's image route is not one. */
export function paidMediaEndpointKind(url: string): "image" | "video" | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; } // not a URL, so no provider route
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if ((host === "api.openai.com" || host === "api.x.ai") && path.startsWith("/v1/images")) return "image";
  if (host === "api.x.ai" && path.startsWith("/v1/videos")) return "video";
  return null;
}
