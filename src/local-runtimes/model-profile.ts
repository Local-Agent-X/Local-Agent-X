/**
 * Declared per-model capability profile — the one record every harness knob
 * for a local model reads from (docs/harness/LOCAL_MODEL_HARNESS_BRIEF.md §8).
 *
 * Two kinds of profile exist and they are not the same thing:
 *   - `LocalModelCapabilityProfile` (cache.ts) is OBSERVED: what discovery and
 *     the self-heal latches learned about a (runtime, model) at run time.
 *   - this one is DECLARED: what a model was measured to support and how the
 *     harness should drive it, hand-written from the Phase 0 measurements and
 *     later proposed by the auto-probe. A field changes here only through an
 *     experiment that measured the change.
 *
 * Bundled profiles ship as config/model-profiles/<id>.json (found the way
 * config/system-prompt.md is found, so dev and the installed app agree). A user
 * may add or override one under <data dir>/model-profiles/<id>.json; every
 * field is theirs to change except `kernelPolicy`, which has a tier-derived
 * floor and can only be tightened. The resolved profile carries a `profileId`
 * and a content hash so every trace and log entry names exactly which profile
 * it ran under.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import type { ModelTier } from "../model-tiers.js";

const logger = createLogger("local-runtimes.model-profile");

const BUNDLED_DIR = resolve(import.meta.dirname || ".", "..", "..", "config", "model-profiles");
export const USER_PROFILE_SUBDIR = "model-profiles";

/** Null means "leave it to the runtime and the Modelfile". */
const SamplingSchema = z.object({
  temperature: z.number().nullable(),
  topP: z.number().nullable(),
  topK: z.number().int().nullable(),
  minP: z.number().nullable(),
  repeatPenalty: z.number().nullable(),
}).strict();

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  runtime: z.object({
    name: z.string(),
    version: z.string().nullable(),
    weightQuant: z.string().nullable(),
    kvCacheQuant: z.string().nullable(),
  }).strict(),
  tier: z.enum(["A", "B", "C"]),
  contextWindow: z.number().int().positive(),
  usableContext: z.number().int().positive(),
  nativeToolCalls: z.boolean(),
  structuredOutput: z.enum(["native_tools", "json_schema", "grammar", "prefill", "none"]),
  supportedCombos: z.object({
    toolsAndSchema: z.boolean(),
    schemaAndThinking: z.boolean(),
    toolsAndThinking: z.boolean(),
  }).strict(),
  parallelToolCalls: z.boolean(),
  thinking: z.object({
    supported: z.boolean(),
    mode: z.enum(["planning_only", "all", "off"]),
    budgetTokens: z.number().int().positive().nullable(),
    budgetMechanism: z.enum(["native", "max_tokens"]),
  }).strict(),
  sampling: z.object({
    toolStep: SamplingSchema,
    diverse: SamplingSchema,
    source: z.string(),
  }).strict(),
  maxTokens: z.object({
    toolCall: z.number().int().positive(),
    contentTool: z.number().int().positive(),
    planOrReport: z.number().int().positive(),
  }).strict(),
  /** `message` is today's per-message re-selection; the brief's values are the target. */
  toolRouting: z.enum(["message", "mission", "phase", "step"]),
  maxToolsExposed: z.number().int().positive(),
  toolsPerTurn: z.number().int().positive().nullable(),
  fewShotExamples: z.number().int().min(0),
  stateBlock: z.boolean(),
  stepScopedContext: z.boolean(),
  criticPass: z.object({ plan: z.boolean(), riskyActions: z.boolean() }).strict(),
  bestOfN: z.object({
    toolStep: z.number().int().min(1),
    planning: z.number().int().min(1),
    riskyActions: z.number().int().min(1),
  }).strict(),
  roles: z.object({
    router: z.string().nullable(),
    planner: z.string().nullable(),
    coder: z.string().nullable(),
  }).strict(),
  kernelPolicy: z.string().min(1),
  notes: z.string().optional(),
}).strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export interface ResolvedModelProfile extends ModelProfile {
  profileId: string;
  /** First 12 hex of sha256 over the canonical JSON — changes when any field does. */
  profileHash: string;
  source: "bundled" | "user" | "bundled+user";
}

/** Kernel presets from loosest to strictest. A profile may name one at or
 *  above its tier's floor. Only one preset exists today; the floor is the
 *  invariant the next one lands under. */
export const KERNEL_POLICY_STRICTNESS: readonly string[] = ["workspace-assistant", "strict"];
export const KERNEL_POLICY_FLOOR_BY_TIER: Readonly<Record<ModelProfile["tier"], string>> = {
  A: "workspace-assistant",
  B: "workspace-assistant",
  C: "workspace-assistant",
};

const TIER_TO_MODEL_TIER: Readonly<Record<ModelProfile["tier"], ModelTier>> = { A: "strong", B: "medium", C: "weak" };

export function profileFileName(modelId: string): string {
  return `${modelId.replace(/[^a-z0-9._-]/gi, "-")}.json`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashProfile(profile: ModelProfile): string {
  return createHash("sha256").update(stableStringify(profile)).digest("hex").slice(0, 12);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Override wins per leaf; nested objects merge, everything else replaces. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function kernelPolicyBelowFloor(profile: ModelProfile): string | null {
  const floor = KERNEL_POLICY_FLOOR_BY_TIER[profile.tier];
  const rank = (p: string) => KERNEL_POLICY_STRICTNESS.indexOf(p);
  if (rank(profile.kernelPolicy) < 0) return `unknown kernelPolicy "${profile.kernelPolicy}"`;
  if (rank(profile.kernelPolicy) < rank(floor)) return `kernelPolicy "${profile.kernelPolicy}" is below the tier-${profile.tier} floor "${floor}"`;
  return null;
}

const cache = new Map<string, ResolvedModelProfile | null>();

/** Test-only: forget every resolved profile (the data dir may have moved). */
export function _resetModelProfilesForTests(): void {
  cache.clear();
}

/**
 * The declared profile for `modelId`, or null when neither a bundled nor a
 * user file exists. A broken bundled file is a developer bug and throws; a
 * broken user override is reported and ignored so a typo can never take the
 * model's routing down with it.
 */
export function resolveModelProfile(modelId: string): ResolvedModelProfile | null {
  if (cache.has(modelId)) return cache.get(modelId)!;
  const resolved = load(modelId);
  cache.set(modelId, resolved);
  return resolved;
}

function load(modelId: string): ResolvedModelProfile | null {
  const name = profileFileName(modelId);
  const bundledPath = join(BUNDLED_DIR, name);
  const userPath = join(getLaxDir(), USER_PROFILE_SUBDIR, name);
  const bundled = existsSync(bundledPath) ? ModelProfileSchema.parse(readJson(bundledPath)) : null;
  if (bundled && bundled.id !== modelId) throw new Error(`bundled profile ${bundledPath} declares id "${bundled.id}", expected "${modelId}"`);

  let merged: ModelProfile | null = bundled;
  let source: ResolvedModelProfile["source"] = "bundled";
  if (existsSync(userPath)) {
    try {
      const candidate = ModelProfileSchema.parse(deepMerge(bundled ?? {}, readJson(userPath)));
      const violation = kernelPolicyBelowFloor(candidate);
      if (violation) throw new Error(violation);
      if (candidate.id !== modelId) throw new Error(`declares id "${candidate.id}"`);
      merged = candidate;
      source = bundled ? "bundled+user" : "user";
    } catch (e) {
      logger.warn(`ignoring user profile ${userPath}: ${(e as Error).message}`);
    }
  }
  if (!merged) return null;
  const floorViolation = kernelPolicyBelowFloor(merged);
  if (floorViolation && source === "bundled") throw new Error(`bundled profile ${bundledPath}: ${floorViolation}`);
  return { ...merged, profileId: merged.id, profileHash: hashProfile(merged), source };
}

/** The declared profile, or null when there is none or it is unreadable —
 *  for callers on the request path, where a profile problem must cost a
 *  warning and a default, never the turn. */
function profileOrNull(modelId: string, fallback: string): ResolvedModelProfile | null {
  try {
    return resolveModelProfile(modelId);
  } catch (e) {
    logger.warn(`profile for ${modelId} unreadable, ${fallback}: ${(e as Error).message}`);
    return null;
  }
}

/** The declared tier as the tool pipeline's ModelTier, or null when the model
 *  has no profile. */
export function modelProfileTier(modelId: string): ModelTier | null {
  const p = profileOrNull(modelId, "falling back to the name heuristic");
  return p ? TIER_TO_MODEL_TIER[p.tier] : null;
}

/** How this model's tool set is re-derived: per `message` (today's default,
 *  and what an unprofiled model gets) or per `mission` — the session's union,
 *  byte-identical between messages until a new tool is needed. */
export function modelToolRouting(modelId: string): ModelProfile["toolRouting"] {
  return profileOrNull(modelId, "tool routing stays per-message")?.toolRouting ?? "message";
}
