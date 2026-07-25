/**
 * Screenshot judge — asks the vision-capable model the user is on whether a
 * just-built app's screenshot looks like a working page or a clearly broken render
 * (blank page, stack trace, framework error overlay, raw unstyled dump).
 *
 * Provider-agnostic: dispatches with provider "auto" so it grades with whatever
 * provider the user is on, and — because a screenshot rides along — with that
 * provider's ACTIVE model (grok-4.5 on grok, opus-5 on Claude). The llm-dispatch
 * layer carries the image on both the Anthropic and OpenAI-compat (openai/xai)
 * paths. Missing credential, a provider that can't carry images (Anthropic
 * subscription-OAuth, Codex), dispatch failure, and unparseable replies ALL
 * degrade to null ("no verdict — skip the check"), never a throw: a lost free
 * check must not fail a build.
 */

import { z } from "zod";
import type { DispatchOptions } from "../../llm-dispatch.js";
import { dispatch } from "../../llm-dispatch.js";

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
   * `dimensions` is a per-axis breakdown (each int 0–5) so the refine nudge can
   * lead with the weakest axis ("hierarchy 1/5") instead of one opaque number.
   * Optional and degrade-safe: an old/garbled reply drops it without nulling the
   * verdict, and the aggregate `score` still drives the gate on its own.
   */
  design?: {
    score: number;
    issues: string[];
    dimensions?: { hierarchy: number; spacing: number; color: number; states: number };
  };
}

/** Matches how llm-dispatch is invoked — injectable so tests never hit the network. */
export type VisionDispatchFn = (opts: DispatchOptions) => Promise<string | null>;

/**
 * Judge one or more PNG screenshots (base64, no `data:` prefix) of a freshly
 * built app. A single screenshot is the load-time render; two screenshots are
 * before/after the app's primary action was clicked (the smoke gate's
 * interact-then-re-smoke tier). Returns null when no verdict could be
 * obtained (no Anthropic credential, dispatch failure, unparseable reply) —
 * the caller treats null as "skip". Never throws.
 */
export async function visionVerdictForScreenshot(
  pngB64: string | string[],
  appDescription: string,
  deps: { dispatch?: VisionDispatchFn } = {},
  designSpec?: string,
): Promise<VisionVerdict | null> {
  const shots = (Array.isArray(pngB64) ? pngB64 : [pngB64])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (shots.length === 0) return null;

  // One dispatch does both jobs: a broken-check (biased toward ok:true — a wrong
  // "broken" verdict wastes a build retry, a wrong "ok" only loses a free check)
  // AND a graded design assessment.
  const prompt = [
    shots.length > 1
      ? `You are judging ${shots.length} screenshots of a just-built web app: the first is the app as it loaded, the next was taken AFTER clicking its primary action (e.g. a Start button). The app is described as: "${appDescription}". Judge the post-interaction state with the same rigor — an app that renders garbage after its Start button is broken.`
      : `You are judging a screenshot of a just-built web app. The app is described as: "${appDescription}".`,
    "",
    'Respond with strict JSON only, no prose: {"ok": boolean, "reason": string, "design": {"score": integer, "dimensions": {"hierarchy": integer, "spacing": integer, "color": integer, "states": integer}, "issues": [string]}}',
    "",
    "1) Broken-check (the `ok` field):",
    "Set ok=false ONLY when the screenshot is clearly broken: a blank/empty page, visible stack trace or error text, a framework error overlay, or a completely unstyled raw-text dump.",
    "Set ok=true for anything that plausibly looks like a functioning app UI matching the description. When uncertain, answer ok=true.",
    "Keep reason to one short sentence.",
    "",
    "2) Design assessment (the `design` field), independent of the broken-check:",
    "Rate `score` from 0 to 5 as an integer, where 5 is polished and intentional and 0 is crude or unstyled. Judge only what is visible against general design and accessibility principles: legible text contrast, a clear visual hierarchy, comfortable and deliberate spacing, real iconography rather than emoji standing in for UI controls, and a layout that reads as designed rather than a default template or an overflowing/broken responsive grid.",
    "Also rate each axis 0–5 as an integer in `dimensions`: `hierarchy` — is there a clear type/size hierarchy with one dominant title and headings distinct from body, or does everything look the same size? `spacing` — consistent rhythm, comfortable padding, content aligned to a grid, or cramped/ragged/arbitrary gaps? `color` — a coherent, deliberate palette with sufficient contrast, or a generic template look? `states` — does it read as designed real content with proper affordances (buttons look clickable, a real empty state rather than a bare void), or an unstyled data dump? The overall `score` should broadly reflect these axes.",
    "List each concrete, visible problem in `issues` as one short phrase (for example: low text contrast, emoji used as icons, generic unstyled look, no visual hierarchy or cramped spacing, content overflow or broken responsive layout). Use an empty list when nothing is wrong.",
    // When the build MANDATED an exact design system, adherence to it is the
    // heaviest factor in the score — a render that ignores the required palette
    // or font is off-spec however tidy it looks. The judge names the specific
    // deviation so the design-verify refine nudge is actionable, not vague.
    ...(designSpec
      ? [
          "",
          "3) MANDATED DESIGN SYSTEM — the build was REQUIRED to implement these EXACT values:",
          designSpec,
          "Weight adherence to this spec HEAVILY in the design `score`: a render that ignores the required palette, substitutes a different font, or drops the specified spacing/radius is off-spec and scores low even if it looks otherwise clean. For each visible deviation add a concrete `issues` entry naming the mismatch (e.g. \"accent is red, spec mandates #2563eb\", \"used a serif; spec mandates the sans stack\", \"flat cards, spec mandates the elevation shadow\").",
        ]
      : []),
  ].join("\n");

  const call = deps.dispatch ?? dispatch;
  let raw: string | null;
  try {
    raw = await call({
      // "auto" resolves the provider the user is on; the screenshot rides along,
      // so the router grades with that provider's ACTIVE model (no per-provider
      // model pin here). Providers that can't carry images degrade to null.
      prompt,
      provider: "auto",
      images: shots,
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

// Zod schema encoding the verdict's tolerance rules. The design block is a
// BONUS signal: a valid finite `score` is clamped to an integer 0–5 and
// `issues` is coerced to its string entries, while an absent or garbled block
// degrades to undefined (via the outer .catch) instead of nulling an
// otherwise valid ok/reason verdict.
// Clamp any finite number to an integer 0–5.
const clamp05 = (n: number): number => Math.min(5, Math.max(0, Math.round(n)));

// Per-axis breakdown. Each field independently degrades to a neutral 3 if the
// model omits or garbles it; the whole block degrades to undefined (via the
// outer .catch in DesignSchema) so a reply without `dimensions` still yields a
// valid design verdict driven by the aggregate `score`.
const DimensionsSchema = z
  .object({
    hierarchy: z.number().finite().catch(3),
    spacing: z.number().finite().catch(3),
    color: z.number().finite().catch(3),
    states: z.number().finite().catch(3),
  })
  .transform((d) => ({
    hierarchy: clamp05(d.hierarchy),
    spacing: clamp05(d.spacing),
    color: clamp05(d.color),
    states: clamp05(d.states),
  }));

const DesignSchema = z
  .object({
    score: z.number().finite(),
    issues: z.array(z.unknown()).catch([]),
    dimensions: DimensionsSchema.optional().catch(undefined),
  })
  .transform((d) => ({
    score: clamp05(d.score),
    issues: d.issues.filter((x): x is string => typeof x === "string"),
    ...(d.dimensions ? { dimensions: d.dimensions } : {}),
  }));

// A valid `ok` boolean is the ONLY hard requirement for a verdict; a missing
// or non-string `reason` coerces to "".
const VisionVerdictSchema = z.object({
  ok: z.boolean(),
  reason: z.string().catch(""),
  design: DesignSchema.optional().catch(undefined),
});

// Models sometimes wrap JSON in ``` fences or pad it with prose despite the
// strict-JSON prompt. Strip fences, take the FIRST balanced JSON object
// (string-aware, so braces inside "reason" don't derail the scan), then
// safeParse it against the schema. NOTE: this stays a LOCAL validation on the
// raw dispatch() reply — the images transport is Anthropic-only and does not
// route through classifySchema.
function parseVerdict(raw: string): VisionVerdict | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  const result = VisionVerdictSchema.safeParse(obj);
  if (!result.success) return null;
  const verdict: VisionVerdict = { ok: result.data.ok, reason: result.data.reason };
  if (result.data.design) verdict.design = result.data.design;
  return verdict;
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
