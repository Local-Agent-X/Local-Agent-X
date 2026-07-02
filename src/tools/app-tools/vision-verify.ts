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
  /** Catastrophic-broken check — biased toward true (see prompt). Unchanged semantics. */
  ok: boolean;
  reason: string;
  /**
   * Graded design assessment from the SAME model call. Optional so old callers
   * and old/partial model replies stay valid. `score` is an integer 0–5
   * (5 = polished, intentional design); `issues` lists concrete problems
   * visible in the screenshot (e.g. low text contrast, emoji used as icons,
   * unstyled/generic look, no visual hierarchy / cramped spacing, overflow).
   */
  design?: { score: number; issues: string[] };
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

  // One dispatch does both jobs: a broken-check (biased toward ok:true — a wrong
  // "broken" verdict wastes a build retry, a wrong "ok" only loses a free check)
  // AND a graded design assessment.
  const prompt = [
    `You are judging a screenshot of a just-built web app. The app is described as: "${appDescription}".`,
    "",
    'Respond with strict JSON only, no prose: {"ok": boolean, "reason": string, "design": {"score": integer, "issues": [string]}}',
    "",
    "1) Broken-check (the `ok` field):",
    "Set ok=false ONLY when the screenshot is clearly broken: a blank/empty page, visible stack trace or error text, a framework error overlay, or a completely unstyled raw-text dump.",
    "Set ok=true for anything that plausibly looks like a functioning app UI matching the description. When uncertain, answer ok=true.",
    "Keep reason to one short sentence.",
    "",
    "2) Design assessment (the `design` field), independent of the broken-check:",
    "Rate `score` from 0 to 5 as an integer, where 5 is polished and intentional and 0 is crude or unstyled. Judge only what is visible against general design and accessibility principles: legible text contrast, a clear visual hierarchy, comfortable and deliberate spacing, real iconography rather than emoji standing in for UI controls, and a layout that reads as designed rather than a default template or an overflowing/broken responsive grid.",
    "List each concrete, visible problem in `issues` as one short phrase (for example: low text contrast, emoji used as icons, generic unstyled look, no visual hierarchy or cramped spacing, content overflow or broken responsive layout). Use an empty list when nothing is wrong.",
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
    const parsed = JSON.parse(json) as { ok?: unknown; reason?: unknown; design?: unknown };
    // A valid `ok` boolean is still the ONLY hard requirement for a verdict.
    if (typeof parsed.ok !== "boolean") return null;
    const verdict: VisionVerdict = {
      ok: parsed.ok,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
    // Design is a bonus signal: parse it tolerantly and never let an absent or
    // garbled `design` block null out an otherwise valid verdict.
    const design = parseDesign(parsed.design);
    if (design) verdict.design = design;
    return verdict;
  } catch {
    return null;
  }
}

// Tolerant parse of the optional design block. Returns undefined (not null,
// never a throw) whenever the block is absent or too malformed to score, so the
// caller keeps a valid ok/reason verdict. When present, `score` is clamped to
// an integer 0–5 and `issues` is coerced to a string array.
function parseDesign(value: unknown): { score: number; issues: string[] } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as { score?: unknown; issues?: unknown };
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) return undefined;
  const score = Math.min(5, Math.max(0, Math.round(obj.score)));
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((x): x is string => typeof x === "string")
    : [];
  return { score, issues };
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
