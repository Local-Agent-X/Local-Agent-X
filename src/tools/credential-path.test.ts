import { describe, it, expect } from "vitest";
import { ESSENTIAL_TOOLS_ORDER, maxToolsForTier, shrinkToolsForTier } from "../model-tiers.js";
import type { ToolDefinition } from "../types.js";

// Live failure 2026-09-08 (qwen3.6:27b, medium tier): asked to deploy using a
// vault-stored VERCEL_TOKEN, the model reported "the tools are restricted right
// now — only the core set is available", tried to read ~/.vercel/auth.json
// (which tainted the session and blocked its own egress), and finished with
// "if you're comfortable sharing it directly, paste the token value here".
// The safe capability existed the whole time; the tier filter had removed it,
// so the model's remaining options were both unsafe.
const CREDENTIAL_PATH = ["list_secrets", "clipboard_write_from_secret", "request_secret"] as const;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} does a thing that is described at some length for a strong model to read.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  } as unknown as ToolDefinition;
}

describe("the credential path survives tier shrinking", () => {
  it("keeps every safe-credential tool in the medium set", () => {
    for (const name of CREDENTIAL_PATH) {
      expect(ESSENTIAL_TOOLS_ORDER, `${name} must not be intent-gated`).toContain(name);
    }
  });

  it("still reaches a medium model when the catalog is far larger than the cap", () => {
    const catalog = [
      ...ESSENTIAL_TOOLS_ORDER.map(tool),
      ...Array.from({ length: 80 }, (_, i) => tool(`filler_${i}`)),
    ];
    const kept = shrinkToolsForTier(catalog, "medium", catalog).map((t) => t.name);
    for (const name of CREDENTIAL_PATH) expect(kept).toContain(name);
  });

  it("leaves headroom for message-matched tools after the essentials", () => {
    expect(maxToolsForTier("medium")).toBeGreaterThan(ESSENTIAL_TOOLS_ORDER.length);
  });

  it("does not promote the credential path above the weak-tier cut", () => {
    // Weak models keep the first 8 only; a 3B model cannot drive a deploy and
    // must not lose read/write/edit/bash to make room for the vault.
    const weakCut = ESSENTIAL_TOOLS_ORDER.slice(0, maxToolsForTier("weak"));
    for (const name of CREDENTIAL_PATH) expect(weakCut).not.toContain(name);
  });
});
