import { describe, it, expect } from "vitest";
import {
  chunkSkill,
  chunkAgentRole,
  buildChunkTask,
  distillSharpenedContext,
} from "../src/auto-build/skill-mapper.js";
import { parseChunkReport } from "../src/auto-build/chunk-review/report-parser.js";
import type { ParsedChunk } from "../src/auto-build/plan-parser.js";

const reportWith = (fields: { specGaps?: string; note?: string }) =>
  parseChunkReport(
    [
      "STATUS: done",
      "DONE_WHEN: met",
      `SPEC_GAPS: ${fields.specGaps ?? "none"}`,
      `NOTE: ${fields.note ?? "none"}`,
    ].join("\n"),
  );

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

  it("threads distilled prior-chunk outcomes into the task (AB-9: sharpenedContext must not be dead)", () => {
    // The regression: prior chunks' SPEC_GAPS / NOTE learnings never reached
    // the next chunk. distillSharpenedContext turns earlier outcomes into the
    // rolling context that buildChunkTask inlines.
    const sharpenedContext = distillSharpenedContext([
      { chunkNumber: 5, report: reportWith({ note: "Introduced a `BusyBlock` type — reuse it; do not redefine." }) },
      { chunkNumber: 6, report: reportWith({ specGaps: "Plan omitted the DST rollover case; handled it as UTC." }) },
    ]);
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md", sharpenedContext });
    expect(t).toContain("Sharpened context from earlier chunks");
    expect(t).toContain("Chunk 5");
    expect(t).toContain("reuse it; do not redefine");
    expect(t).toContain("Chunk 6");
    expect(t).toContain("DST rollover");
  });

  it("task is much shorter than the old combined prompt (methodology lives in agent def)", () => {
    const t = buildChunkTask({ chunk: baseChunk, totalChunks: 31, planPath: "/proj/spec/plan.md" });
    // The full prompt before migration was 4-5 KB (skill body + discipline + report format).
    // The task-only output should be under 1 KB.
    expect(t.length).toBeLessThan(1500);
  });
});

describe("distillSharpenedContext", () => {
  it("carries SPEC_GAPS and NOTE from each prior chunk, tagged by chunk number", () => {
    const out = distillSharpenedContext([
      { chunkNumber: 2, report: reportWith({ specGaps: "auth token TTL unspecified", note: "chose 15m" }) },
    ]);
    expect(out).toContain("Chunk 2");
    expect(out).toContain("SPEC_GAPS: auth token TTL unspecified");
    expect(out).toContain("NOTE: chose 15m");
  });

  it("returns empty string when no prior chunk carried anything (first chunk / all 'none')", () => {
    expect(distillSharpenedContext([])).toBe("");
    expect(distillSharpenedContext([{ chunkNumber: 1, report: reportWith({}) }])).toBe("");
  });

  it("skips chunks whose SPEC_GAPS and NOTE are both empty", () => {
    const out = distillSharpenedContext([
      { chunkNumber: 3, report: reportWith({}) },
      { chunkNumber: 4, report: reportWith({ note: "kept it" }) },
    ]);
    expect(out).not.toContain("Chunk 3");
    expect(out).toContain("Chunk 4");
  });

  it("clips runaway prose so a rolling context can't bloat the prompt", () => {
    const huge = "x".repeat(2000);
    const out = distillSharpenedContext([{ chunkNumber: 9, report: reportWith({ note: huge }) }]);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(600);
  });
});
