// Wire shape of the ChatGPT Codex backend's image routes, billed to the
// user's ChatGPT plan. Pure: no fetch, no logging. The caller sends it, since
// a tool's outbound HTTP has to go through the egress guard.
//
// Source: openai/codex at 1cc7dc8f (2026-10-17). The CLI's image tool
// (codex-rs/ext/image-generation/src/tool.rs, backend.rs) posts JSON through
// codex-api's ImagesClient (codex-rs/codex-api/src/endpoint/images.rs,
// images.rs) to `<base>/images/generations`, or `<base>/images/edits` when it
// has input images, where <base> is CHATGPT_CODEX_BASE_URL for a ChatGPT
// sign-in (codex-rs/model-provider-info/src/lib.rs). Body: prompt, model
// "gpt-image-2", quality "auto", size "auto", background "opaque" (or
// "transparent"); an edit adds `images: [{ image_url: <data URL> }]`. Reply:
// one JSON object, `data: [{ b64_json }]`; no stream. Cross-checked against
// yuji-hatakeyama/opencode-gpt-imagegen src/codex.ts, which moved to these
// routes for the GPT-5.5 retirement from ChatGPT sign-in (2026-10-14).
// This is not an API OpenAI supports for third-party apps.

import { CODEX_BASE_URL } from "./types.js";
import { buildAuthHeaders } from "./request.js";

/** The model the Codex CLI asks for. */
export const CODEX_IMAGE_MODEL = "gpt-image-2";

export interface CodexImageRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Generate from `prompt`, or edit when `images` (data URLs) are given. */
export function buildCodexImageRequest(
  token: string,
  prompt: string,
  images: readonly string[] = [],
): CodexImageRequest {
  const edit = images.length > 0;
  const body: Record<string, unknown> = {
    prompt,
    background: "opaque",
    model: CODEX_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  };
  if (edit) body.images = images.map((image_url) => ({ image_url }));
  return {
    url: `${CODEX_BASE_URL}/images/${edit ? "edits" : "generations"}`,
    headers: { ...buildAuthHeaders(token), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  };
}

/** The first image's base64 bytes, or null when the reply carries none. */
export function readCodexImageResponse(json: unknown): string | null {
  const data = (json as { data?: Array<{ b64_json?: unknown }> } | null)?.data;
  const b64 = Array.isArray(data) ? data[0]?.b64_json : undefined;
  return typeof b64 === "string" && b64.length > 0 ? b64 : null;
}
