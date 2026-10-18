/**
 * The paid-API switch for images and video (Settings → Media,
 * `allowPaidMediaApis`, off unless the user turns it on). While it is off no
 * image or video call may use a per-use-billed API key: resolveMediaProvider
 * (shared.ts) drops those credentials, and http_request refuses a stored
 * secret sent to a provider's image or video route. Kept apart from shared.ts
 * so http_request reads it without loading the image tools.
 */
import { loadSettings } from "../../settings.js";

/** The Settings → Media label; public/app.html shows the same words. */
export const PAID_MEDIA_SETTING_LABEL = "Allow paid API keys for images and video";

/** True only when the user turned the switch on. */
export function paidMediaApisAllowed(): boolean {
  return loadSettings().allowPaidMediaApis === true;
}

/** The refusal for an explicit paid backend while the switch is off. */
export function paidMediaOffMessage(kind: "image" | "video"): string {
  return `Paid API ${kind} generation is off — turn on '${PAID_MEDIA_SETTING_LABEL}' in Settings → Media.`;
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
