import { describe, it, expect } from "vitest";

import { dispatchBackgroundModel } from "./llm-dispatch.js";
import { backgroundModelFor } from "./providers/registry.js";

// Import-only: never invoke dispatch() itself (it makes network calls). We only
// assert the helper reads the canonical registry, so the per-provider background
// model can't silently drift away from backgroundModelFor().
describe("dispatchBackgroundModel reads the canonical registry", () => {
  it("resolves each dispatch provider via backgroundModelFor (no hardcoded drift)", () => {
    for (const p of ["xai", "openai", "codex", "anthropic"] as const) {
      expect(dispatchBackgroundModel(p)).toBe(backgroundModelFor(p, ""));
    }
  });
});
