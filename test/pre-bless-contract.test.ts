import { describe, it, expect, vi } from "vitest";

// CROSS-SEAM CONTRACT — the pre-bless privacy gate, end to end.
//
// Three seams must agree on one thing: the secret-name KEY.
//   write:    op_submit_async(pre_blessed_secrets) → buildOpFromArgs →
//             op.contextPack.secrets.preBlessed
//   read:     collectPreBlessedSecrets(liveOps) → Set<name>
//   consumer: browser_fill_from_secret normalizes the requested name and does
//             liveSet.has(name)
//
// If any seam normalizes differently, the gate silently fail-closes (the F1 C1
// bug class). This test proves all three route through normalizeSecretName, so
// a name blessed at submit is the EXACT key the gate looks up — and that the
// bless is scoped to a running op.

// buildContextPack is the only disk-touching dep on the submit path. Stub it so
// this contract test is hermetic and never reads the real ~/.lax.
vi.mock("../src/ops/context-pack-builder.js", () => ({
  buildContextPack: async (input: { description: string; lane: string }) => ({
    task: { description: input.description, successCriteria: [], constraints: [], notWhatToRedo: [] },
    context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
    capabilities: {},
    budget: { maxIterations: 30, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
    routing: { lane: input.lane },
    secrets: { allowed: [] },
  }),
}));

import { buildOpFromArgs } from "../src/ops/tools/shared.js";
import { collectPreBlessedSecrets } from "../src/ops/pre-bless.js";
import { normalizeSecretName } from "../src/secrets.js";
import type { Op } from "../src/ops/types.js";

describe("pre-bless contract: submit ↔ gate ↔ fill", () => {
  it("a name pre-blessed at submit is the exact key the fill gate looks up", async () => {
    // User authorizes messy-cased names at delegation time.
    const op = await buildOpFromArgs({ task: "log in and post", pre_blessed_secrets: ["gh-token", "NPM_token"] });

    // WRITE end normalized + de-duped them onto the canonical Op.
    expect(op.contextPack.secrets.preBlessed).toEqual(["GH_TOKEN", "NPM_TOKEN"]);

    // READ end, while the op runs, surfaces exactly those names.
    const live = collectPreBlessedSecrets([{ ...op, status: "running" } as Op]);

    // CONSUMER (secret-fill) normalizes the user's raw request the SAME way → hit.
    expect(live.has(normalizeSecretName("gh-token"))).toBe(true);
    expect(live.has(normalizeSecretName("npm_token"))).toBe(true);
    // A name never blessed is denied.
    expect(live.has(normalizeSecretName("aws-key"))).toBe(false);
  });

  it("the bless evaporates the moment the op is no longer running (liveness)", async () => {
    const op = await buildOpFromArgs({ task: "x", pre_blessed_secrets: ["GH_TOKEN"] });
    const notLive = ["pending", "paused", "completed", "failed", "cancelled", "needs-input"] as const;
    for (const status of notLive) {
      expect(collectPreBlessedSecrets([{ ...op, status } as Op]).size).toBe(0);
    }
    expect(collectPreBlessedSecrets([{ ...op, status: "running" } as Op]).has("GH_TOKEN")).toBe(true);
  });

  it("no pre_blessed_secrets arg → no preBlessed field, gate stays closed", async () => {
    const op = await buildOpFromArgs({ task: "just research something" });
    expect(op.contextPack.secrets.preBlessed).toBeUndefined();
    expect(collectPreBlessedSecrets([{ ...op, status: "running" } as Op]).size).toBe(0);
  });
});
