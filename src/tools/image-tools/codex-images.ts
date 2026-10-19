/**
 * The ChatGPT-subscription image backend (`codex` media provider): one call to
 * the Codex backend's image routes, through the egress guard. The wire shape
 * and its source are in src/codex-client/images.ts. Saving and the result
 * text stay with the calling tool, as for the other backends.
 */

import type { ToolResult } from "../../types.js";
import { buildCodexImageRequest, readCodexImageResponse } from "../../codex-client/images.js";
import { canonicalFetch } from "../web-egress.js";
import { err, mediaCallFailed } from "./shared.js";

// Codex's own tool description gives an image a few minutes and its first
// wait 120 s; the generate_image / edit_image policy rows allow for this.
const CODEX_IMAGE_TIMEOUT_MS = 240_000;

/** What the backend's refusal means for the user, by status. */
function refusalHint(status: number): string {
  if (status === 401 || status === 403) return " The ChatGPT sign-in was refused: sign in again in Settings, or this plan does not include image generation.";
  if (status === 429) return " The ChatGPT plan's image limit is reached; try again later.";
  if (status === 404 || status === 410) return " The ChatGPT image route or model is no longer offered.";
  return "";
}

/** Generate (no `images`) or edit (`images` as data URLs). Returns the PNG
 *  bytes, or the tool result to hand back: a refusal is an error naming
 *  ChatGPT, never a quiet switch to another backend. */
export async function requestCodexImage(
  token: string,
  prompt: string,
  images: readonly string[] = [],
): Promise<{ buffer: Buffer } | { result: ToolResult }> {
  const action = images.length > 0 ? "image edit" : "image generation";
  const req = buildCodexImageRequest(token, prompt, images);
  let res;
  try {
    res = await canonicalFetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      timeoutMs: CODEX_IMAGE_TIMEOUT_MS,
    });
  } catch (e) {
    return { result: mediaCallFailed(e, `ChatGPT ${action} failed`) };
  }
  if (!res.ok) {
    const errText = await res.text();
    return { result: err(`ChatGPT ${action} failed (${res.status}): ${errText.slice(0, 300)}${refusalHint(res.status)}`) };
  }
  const b64 = readCodexImageResponse(await res.json().catch(() => null));
  if (!b64) return { result: err(`ChatGPT returned no image for the ${action}.`) };
  return { buffer: Buffer.from(b64, "base64") };
}
