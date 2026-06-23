/**
 * The dream/consolidation agent must persist memory ONLY through the canonical
 * gated tools (Facts DB + profiles). Handing it raw write/edit let it improvise
 * dup .md files + a dead-link MEMORY.md index — the exact drift this fix kills.
 * If a future change reintroduces a raw file-write tool to the dream agent, this
 * test fails before it can ship.
 */
import { describe, it, expect } from "vitest";
import { DREAM_TOOL_NAMES } from "./prompts.js";

describe("dream agent toolset — canonical memory only", () => {
  it("includes the gated memory-mutation + lookup tools", () => {
    for (const t of [
      "remember",
      "update_fact",
      "forget",
      "memory_set_user_field",
      "memory_update_profile",
      "memory_search",
      "read",
    ]) {
      expect(DREAM_TOOL_NAMES).toContain(t);
    }
  });

  it("excludes raw file-write tools that let it improvise free-form memory files", () => {
    for (const t of ["write", "edit", "glob", "grep", "memory_save"]) {
      expect(DREAM_TOOL_NAMES as readonly string[]).not.toContain(t);
    }
  });
});
