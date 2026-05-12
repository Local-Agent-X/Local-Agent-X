import { describe, it, expect } from "vitest";
import { chunkSkill, chunkAgentRole, buildChunkTask } from "../src/primal-auto-build/skill-mapper.js";
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

describe("chunkAgentRole", () => {
  it("trunk → chunk-runner-trunk", () => {
    expect(chunkAgentRole("trunk")).toBe("chunk-runner-trunk");
  });
  it("mixed → chunk-runner-trunk (dispatch rule)", () => {
    expect(chunkAgentRole("mixed")).toBe("chunk-runner-trunk");
  });
  it("leaf → chunk-runner-leaf", () => {
    expect(chunkAgentRole("leaf")).toBe("chunk-runner-leaf");
  });
});

describe("buildChunkTask", () => {
  it("includes chunk number, title, slice, and done-when verbatim", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).toContain("chunk 7 of 31");
    expect(t).toContain("iCloud / CalDAV adapter");
    expect(t).toContain("tsdav client, app-specific password walkthrough.");
    expect(t).toContain("Adapter unit tests pass; 401-detection flips to degraded.");
  });

  it("notes the assigned skill in the class line", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).toContain("Class:** trunk → /senior-engineer");
  });

  it("notes leaf chunks dispatch to vibe-code", () => {
    const leaf = { ...baseChunk, klass: "leaf" as const };
    const t = buildChunkTask({ chunk: leaf, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).toContain("Class:** leaf → /vibe-code");
  });

  it("notes dependencies when present", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).toContain("chunks 2, 5");
  });

  it("notes 'no dependencies' for foundation chunks", () => {
    const foundation = { ...baseChunk, dependsOn: [] };
    const t = buildChunkTask({ chunk: foundation, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).toContain("foundation chunk");
  });

  it("inlines sharpened context when supplied", () => {
    const t = buildChunkTask({
      chunk: baseChunk,
      totalChunks: 31,
      planPath: "/proj/spec/plan.md",
      sharpenedContext: "Chunk 5 introduced a `BusyBlock` type — reuse it; do not redefine.",
    });
    expect(t).toContain("Sharpened context from earlier chunks");
    expect(t).toContain("reuse it; do not redefine");
  });

  it("inlines retry framing when supplied", () => {
    const t = buildChunkTask({
      chunk: baseChunk,
      totalChunks: 31,
      planPath: "/proj/spec/plan.md",
      retryReason: "Done-when claimed 'tests pass' but 3 tests for 401-detection were missing.",
    });
    expect(t).toContain("Retry — prior attempt was rejected");
    expect(t).toContain("Done-when claimed");
    expect(t).toContain("Address ONLY the gap the reviewer named");
  });

  it("omits sharpened context block when empty", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    expect(t).not.toContain("Sharpened context");
  });

  it("task is much shorter than the old combined prompt (methodology lives in agent def)", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    // The full prompt before migration was 4-5 KB (skill body + discipline + report format).
    // The task-only output should be under 1 KB.
    expect(t.length).toBeLessThan(1500);
  });
});
