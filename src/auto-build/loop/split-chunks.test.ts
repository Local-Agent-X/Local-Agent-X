// A chunk the build lead split keeps part of its contract; the rest becomes
// new chunks of the plan, built in the same run after the plan's own.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlanFile, parsePlanText, type ParsedChunk } from "../plan-parser.js";
import { appendSplitChunks, splitOffsToBuild } from "./split-chunks.js";
import type { LoopOptions, LoopResult } from "./types.js";

const PLAN = [
  "# Plan", "## Phase A — Build",
  "### Chunk 3 — Manual review", "- **Class:** leaf → `/vibe-code`", "- **Slice:** manual entry.", "- **Depends on:** —", "- **Done when:** names check.",
  "### Chunk 4 — Scan", "- **Class:** trunk → `/senior-engineer`", "- **Slice:** camera scan.", "- **Depends on:** 3", "- **Done when:** scan works.",
  "## Phase verification gates", "### Phase A end-of-phase — none",
].join("\n");

function project(): { dir: string; chunk: ParsedChunk } {
  const dir = mkdtempSync(join(tmpdir(), "lax-split-"));
  mkdirSync(join(dir, "spec"));
  writeFileSync(join(dir, "spec", "plan.md"), PLAN);
  return { dir, chunk: parsePlanText(PLAN).chunks[1] };
}

describe("appendSplitChunks", () => {
  it("adds each part as a chunk of the plan, numbered from the chunk and depending on it; a second split takes the next numbers", () => {
    const { dir, chunk } = project();
    expect(appendSplitChunks(dir, chunk, [
      { title: "Spacing variants of listed names", doneWhen: "'Ginkgo  biloba' prefills Ginkgo biloba" },
      { title: "Typographic apostrophes", doneWhen: "St. John’s Wort prefills" },
    ])).toEqual([401, 402]);
    expect(appendSplitChunks(dir, chunk, [{ title: "Vitamin D3", doneWhen: "D3 prefills" }])).toEqual([403]);

    const plan = parsePlanFile(join(dir, "spec", "plan.md"));
    expect(plan.chunks.map((c) => c.number)).toEqual([3, 4, 401, 402, 403]);
    expect(plan.chunks[2]).toMatchObject({ title: "Spacing variants of listed names", dependsOn: [4], klass: "trunk", doneWhen: "'Ginkgo  biloba' prefills Ginkgo biloba" });
    expect(plan.chunks[2].phase).toBe("Split from chunk 4 — Scan");
    // The plan's own phase gates are left as they were.
    expect(plan.phaseGatesRawSection).toContain("Phase A end-of-phase");
  });

  it("grows nothing in a tree with no plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-split-"));
    expect(appendSplitChunks(dir, project().chunk, [{ title: "t", doneWhen: "d" }])).toBeNull();
  });
});

describe("splitOffsToBuild", () => {
  const run = (landed: number[]): LoopResult => ({
    status: "complete", lastChunk: 4, chunksCommitted: landed.length, haltReason: "", events: [],
    outcomes: landed.map((n) => ({ chunkNumber: n, action: "proceed", outcome: {} as never })),
  });

  it("builds what the plan gained when the chunk it came from landed, after the plan's own chunks", () => {
    const { dir, chunk } = project();
    appendSplitChunks(dir, chunk, [{ title: "Spacing", doneWhen: "d" }]);
    const opts = { projectDir: dir, planPath: join(dir, "spec", "plan.md"), plan: parsePlanText(PLAN), startingChunk: 3 } as LoopOptions;
    const grown = splitOffsToBuild(opts, run([3, 4]));
    expect(grown?.chunks.map((c) => c.number)).toEqual([401]);
    expect(grown?.plan.chunks.map((c) => c.number)).toEqual([3, 4, 401]);
    // The chunk it came from did not land: it waits for a resume.
    expect(splitOffsToBuild(opts, run([3]))).toBeNull();
  });
});
