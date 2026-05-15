/**
 * Submit-time routing decision (PRD §17).
 *
 * Pure-ish function: reads env + settings.json (once per call), no DB writes,
 * no env caching. The flag value at the moment of submission becomes
 * immutable for the op's lifetime (captured on `op.canonical.flagValue` by
 * the caller).
 *
 * Default routing is **canonical** for every lane. Legacy is selected only
 * when (a) the feature flag is explicitly set to a falsy value, or (b) the
 * effective provider has no canonical adapter (see below). Rollback path is
 * `LAX_CANONICAL_LOOP_ALL=0` — see docs/runbooks/canonical-loop-rollback.md.
 *
 * Provider gating: when `LAX_CANONICAL_LOOP_ANTHROPIC_ONLY=1` is set, the
 * canonical route is only taken when the op's effective provider resolves
 * to Anthropic. With the Codex adapter shipped (v1.1), Codex now has
 * canonical support too — the gate is kept as an opt-in safety knob but
 * the *default* (env unset) lets any supported provider take canonical.
 *
 * Supported provider list: anthropic, codex. Other providers (xai, gemini,
 * local, openai-direct) don't have canonical adapters yet and fall through
 * to legacy regardless of the gate.
 *
 * Effective provider precedence:
 *   1. op.contextPack.routing.preferredProvider (caller hint)
 *   2. settings.json `provider` (global default)
 *   3. unknown → treated as unsupported (safer default — falls to legacy)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Op } from "../workers/types.js";
import type { CanonicalLane } from "./types.js";
import { isCanonicalLoopEnabled } from "./feature-flag.js";

export interface SubmitRouting {
  route: "legacy" | "canonical";
  flagValue: boolean;
  lane: CanonicalLane;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readGlobalProvider(): string | null {
  try {
    const sp = join(homedir(), ".lax", "settings.json");
    if (!existsSync(sp)) return null;
    const s = JSON.parse(readFileSync(sp, "utf-8"));
    return typeof s.provider === "string" ? s.provider : null;
  } catch {
    return null;
  }
}

const CANONICAL_SUPPORTED_PROVIDERS = new Set(["anthropic", "codex"]);

export function decideSubmitRouting(op: Pick<Op, "lane"> & { contextPack?: Op["contextPack"] }): SubmitRouting {
  const lane = op.lane as CanonicalLane;
  let flagValue = isCanonicalLoopEnabled(lane);

  if (flagValue) {
    const opProvider = op.contextPack?.routing?.preferredProvider;
    const effective = opProvider ?? readGlobalProvider();

    // Always require a SUPPORTED canonical provider. Without an adapter
    // for the provider, the op would fail-fast on adapter_not_configured;
    // routing to legacy is the safe default.
    if (!effective || !CANONICAL_SUPPORTED_PROVIDERS.has(effective)) {
      flagValue = false;
    }

    // Optional opt-in gate: ANTHROPIC_ONLY narrows further to anthropic.
    // Useful as a safety knob during Codex canary periods. Default unset =
    // both providers go canonical when supported.
    const raw = (process.env.LAX_CANONICAL_LOOP_ANTHROPIC_ONLY ?? "").trim().toLowerCase();
    if (TRUTHY.has(raw) && effective !== "anthropic") {
      flagValue = false;
    }
  }

  return {
    route: flagValue ? "canonical" : "legacy",
    flagValue,
    lane,
  };
}
