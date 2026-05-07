/**
 * Submit-time routing decision (PRD §17).
 *
 * Pure-ish function: reads env + settings.json (once per call), no DB writes,
 * no env caching. The flag value at the moment of submission becomes
 * immutable for the op's lifetime (captured on `op.canonical.flagValue` by
 * the caller).
 *
 * Provider gating: when `LAX_CANONICAL_LOOP_ANTHROPIC_ONLY=1` is set, the
 * canonical route is only taken when the op's effective provider resolves to
 * Anthropic. Codex/openai/etc. stay on the legacy path (necessary because
 * v1.0 only ships an Anthropic adapter — Codex adapter is v1.1).
 *
 * Effective provider precedence:
 *   1. op.contextPack.routing.preferredProvider (caller hint)
 *   2. settings.json `provider` (global default)
 *   3. unknown → treated as non-anthropic (safer default)
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

export function decideSubmitRouting(op: Pick<Op, "lane"> & { contextPack?: Op["contextPack"] }): SubmitRouting {
  const lane = op.lane as CanonicalLane;
  let flagValue = isCanonicalLoopEnabled(lane);

  if (flagValue) {
    const raw = (process.env.LAX_CANONICAL_LOOP_ANTHROPIC_ONLY ?? "").trim().toLowerCase();
    if (TRUTHY.has(raw)) {
      const opProvider = op.contextPack?.routing?.preferredProvider;
      const effective = opProvider ?? readGlobalProvider();
      if (effective !== "anthropic") flagValue = false;
    }
  }

  return {
    route: flagValue ? "canonical" : "legacy",
    flagValue,
    lane,
  };
}
