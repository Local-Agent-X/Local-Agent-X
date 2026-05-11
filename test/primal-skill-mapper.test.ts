import { describe, it, expect } from "vitest";
import { chunkSkill, buildChunkPrompt } from "../src/primal-auto-build/skill-mapper.js";
import type { ParsedChunk } from "../src/primal-auto-build/plan-parser.js";

const baseChunk: ParsedChunk = {
  number: 7,
  title: "iCloud / CalDAV adapter",
  phase: "Phase B — Calendar reading",
  klass: "trunk",
  slice: "tsdav client, app-specific password walkthrough.",
  dependsOn: [2, 5],
  scenarios: "1, 4 (partial)",
  doneWhen: "Adapter unit tests pass; 401-detection flips to degraded.",
  rawSection: "(unused in skill-mapper tests)",
};

describe("chunkSkill", () => {
  it("trunk → senior-engineer", () => {
    expect(chunkSkill("trunk")).toBe("senior-engineer");
  });
  it("leaf → vibe-code", () => {
    expect(chunkSkill("leaf")).toBe("vibe-code");
  });
  it("mixed → senior-engineer (dispatch rule from design)", () => {
    expect(chunkSkill("mixed")).toBe("senior-engineer");
  });
});

describe("buildChunkPrompt", () => {
  it("opens with the inlined senior-engineer methodology body", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("# Worker methodology — /senior-engineer");
    // body content sanity-check — the senior-engineer SKILL.md has a known phrase
    expect(p).toContain("smallest correct change");
  });

  it("uses /vibe-code body for leaf chunks", () => {
    const leaf = { ...baseChunk, klass: "leaf" as const };
    const p = buildChunkPrompt({ chunk: leaf, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("# Worker methodology — /vibe-code");
    // vibe-code body has a known phrase from its SKILL.md
    expect(p).toMatch(/vibe code in prod responsibly/i);
  });

  it("uses /senior-engineer for mixed chunks (cheaper than splitting)", () => {
    const mixed = { ...baseChunk, klass: "mixed" as const };
    const p = buildChunkPrompt({ chunk: mixed, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("# Worker methodology — /senior-engineer");
    expect(p).toContain("Class:** mixed");
  });

  it("includes chunk number, title, slice, and done-when verbatim", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("chunk 7 of 31");
    expect(p).toContain("iCloud / CalDAV adapter");
    expect(p).toContain("tsdav client, app-specific password walkthrough.");
    expect(p).toContain("Adapter unit tests pass; 401-detection flips to degraded.");
  });

  it("instructs the subprocess to NOT read scenarios/ or twins/", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("Read `spec/` only");
    expect(p).toContain("Do not read `scenarios/`");
    expect(p).toContain("twins");
  });

  it("anchors the core discipline: code matches spec, never the reverse", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toMatch(/Code matches spec, never the reverse/i);
    expect(p).toMatch(/Don't touch `spec\/`/i);
  });

  it("includes the canonical report-format block the reviewer parses", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("STATUS:");
    expect(p).toContain("DONE_WHEN:");
    expect(p).toContain("CHANGED:");
    expect(p).toContain("TESTS:");
    expect(p).toContain("NEW_FAILURES:");
    expect(p).toContain("PRE_EXISTING_FAILURES:");
    expect(p).toContain("SPEC_GAPS:");
    expect(p).toContain("LAUNCH_READINESS:");
    expect(p).toContain("NOTE:");
  });

  it("notes dependencies when present", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("chunks 2, 5");
  });

  it("notes 'no dependencies' for foundation chunks", () => {
    const foundation = { ...baseChunk, dependsOn: [] };
    const p = buildChunkPrompt({ chunk: foundation, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).toContain("foundation chunk");
  });

  it("inlines sharpened context when supplied", () => {
    const p = buildChunkPrompt({
      chunk: baseChunk,
      totalChunks: 31,
      planPath: "/proj/spec/plan.md",
      sharpenedContext: "Chunk 5 introduced a `BusyBlock` type — reuse it; do not redefine.",
    });
    expect(p).toContain("Sharpened context from earlier chunks");
    expect(p).toContain("reuse it; do not redefine");
  });

  it("inlines retry framing when supplied", () => {
    const p = buildChunkPrompt({
      chunk: baseChunk,
      totalChunks: 31,
      planPath: "/proj/spec/plan.md",
      retryReason: "Done-when claimed 'tests pass' but 3 tests for 401-detection were missing.",
    });
    expect(p).toContain("Retry — prior attempt was rejected");
    expect(p).toContain("Done-when claimed");
    expect(p).toContain("Address ONLY the gap the reviewer named");
  });

  it("omits sharpened context block when empty", () => {
    const p = buildChunkPrompt({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(p).not.toContain("Sharpened context");
  });
});
