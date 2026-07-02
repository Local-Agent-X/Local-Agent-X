/**
 * Screenshot judge — asks a cheap vision-capable model whether a just-built
 * app's screenshot looks like a working page or a clearly broken render
 * (blank page, stack trace, framework error overlay, raw unstyled dump).
 *
 * Anthropic-only: the shared llm-dispatch layer carries images only on its
 * Anthropic path, so this pins provider "anthropic" and the registry's
 * background model. Missing credential, dispatch failure, and unparseable
 * replies ALL degrade to null ("no verdict — skip the check"), never a throw:
 * a lost free check must not fail a build.
 */

import type { DispatchOptions } from "../../llm-dispatch.js";
import { dispatch, dispatchBackgroundModel } from "../../llm-dispatch.js";

export interface VisionVerdict {
  ok: boolean;
  reason: string;
}

/** Matches how llm-dispatch is invoked — injectable so tests never hit the network. */
export type VisionDispatchFn = (opts: DispatchOptions) => Promise<string | null>;

/**
 * Judge a PNG screenshot (base64, no `data:` prefix) of a freshly built app.
 * Returns null when no verdict could be obtained (no Anthropic credential,
 * dispatch failure, unparseable reply) — the caller treats null as "skip".
 * Never throws.
 */
export async function visionVerdictForScreenshot(
  pngB64: string,
  appDescription: string,
  deps: { dispatch?: VisionDispatchFn } = {},
): Promise<VisionVerdict | null> {
  if (typeof pngB64 !== "string" || !pngB64.trim()) return null;

  // Bias toward ok:true — a wrong "broken" verdict wastes a build retry,
  // while a wrong "ok" only loses a free check.
  const prompt = [
    `You are judging a screenshot of a just-built web app. The app is described as: "${appDescription}".`,
    "",
    'Respond with strict JSON only, no prose: {"ok": boolean, "reason": string}',
    "",
    "Set ok=false ONLY when the screenshot is clearly broken: a blank/empty page, visible stack trace or error text, a framework error overlay, or a completely unstyled raw-text dump.",
    "Set ok=true for anything that plausibly looks like a functioning app UI matching the description. When uncertain, answer ok=true.",
    "Keep reason to one short sentence.",
  ].join("\n");

  const call = deps.dispatch ?? dispatch;
  let raw: string | null;
  try {
    raw = await call({
      prompt,
      provider: "anthropic",
      anthropicModel: dispatchBackgroundModel("anthropic"),
      images: [pngB64],
      temperature: 0,
      maxTokens: 200,
    });
  } catch {
    // The real dispatch never throws (it returns null), but an injected one
    // might — this function's contract is "never throw".
    return null;
  }
  // `raw` is typed string | null, but an injected/misbehaving dispatch can
  // resolve with any shape — guard before parseVerdict does string ops on it,
  // so the "never throw" contract holds across the IPC/type boundary.
  if (typeof raw !== "string" || !raw) return null;
  return parseVerdict(raw);
}

// Models sometimes wrap JSON in ``` fences or pad it with prose despite the
// strict-JSON prompt. Strip fences, then take the FIRST balanced JSON object
// (string-aware, so braces inside "reason" don't derail the scan).
function parseVerdict(raw: string): VisionVerdict | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { ok?: unknown; reason?: unknown };
    if (typeof parsed.ok !== "boolean") return null;
    return { ok: parsed.ok, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
