import { describe, it, expect } from "vitest";

import { isMutationTool, isProgressTool } from "./tool-mutation-check.js";

describe("tool-mutation-check — critical invariants the loop guards depend on", () => {
  it("bash is NOT a mutation but IS progress (no-progress must still catch bash-spin)", () => {
    // The whole point of the no-progress guard is catching a bash spin
    // (build_app's 96-bash-call kill). bash must never reset no-progress, but it
    // resets the discovery counter (running commands is work, not a lookup spin).
    expect(isMutationTool("bash")).toBe(false);
    expect(isProgressTool("bash")).toBe(true);
  });

  it("browser IS a mutation but NOT progress (the 2026-05-13 PO-entry fix)", () => {
    // browser is network-read by tier but its clicks/fills mutate external
    // systems — it resets no-progress. It does not reset the discovery counter.
    expect(isMutationTool("browser")).toBe(true);
    expect(isProgressTool("browser")).toBe(false);
  });

  it("read-only research tools are neither mutation nor progress (no-progress still fires on read loops)", () => {
    for (const t of ["web_fetch", "web_search", "read", "grep", "glob"]) {
      expect(isMutationTool(t)).toBe(false);
      expect(isProgressTool(t)).toBe(false);
    }
  });

  it("external sends and writes count as mutations", () => {
    for (const t of ["write", "edit", "http_request", "email_send"]) {
      expect(isMutationTool(t)).toBe(true);
    }
  });
});

describe("tool-mutation-check — drift fix (derives from the risk taxonomy, not a hand-list)", () => {
  it("side-effecting tools absent from the old hand-list now auto-count", () => {
    // These were never in the removed MUTATION_TOOLS set; they classify
    // correctly now purely from their risk tier (the latent false-abort bug).
    for (const t of ["project_create", "delete_file", "issue_create", "edit_lines", "multi_edit"]) {
      expect(isMutationTool(t)).toBe(true);
    }
  });
});
