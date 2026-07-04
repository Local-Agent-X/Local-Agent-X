// Contract test: the /app-build planner methodology (SKILL.md) must keep teaching
// the model to declare per-chunk file footprints, AND its worked example must stay
// in a format the plan parser actually accepts and turns into a footprint.
//
// Why this exists: the parallel build path (S3) only fans chunks out when the plan
// declares disjoint `**Files:**` footprints (S1 parser + S2 conflict-graph). The
// planner learns to emit those from the methodology in
// src/protocols/bundled/app-build/SKILL.md. If that guidance or its example ever
// drifts out of the parseable grammar, parallelism silently reverts to serial with
// no test failure anywhere — this guards that seam.
import { describe, it, expect } from "vitest";
import { loadSkillBody } from "../src/auto-build/skill-bodies.js";
import { parsePlanText } from "../src/auto-build/plan-parser.js";

describe("app-build planner ↔ parser footprint contract", () => {
  const body = loadSkillBody("app-build");

  it("the methodology still instructs the planner to declare per-chunk files", () => {
    expect(body).toMatch(/Declare the files each chunk touches/i);
    // The rationale must survive too — it's why a planner bothers to be accurate.
    expect(body.toLowerCase()).toContain("parallel");
  });

  it("the methodology's chunk example parses into the exact footprint the builder schedules on", () => {
    // Pull the indented worked-example block (starts at the Chunk 3 heading, ends
    // at the first blank line) out of the markdown and dedent it 4 spaces.
    const lines = body.split("\n");
    const start = lines.findIndex((l) => /^\s*### Chunk 3 — User profile page/.test(l));
    expect(start, "example chunk heading present in SKILL.md").toBeGreaterThan(-1);
    const block: string[] = [];
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() === "") break;
      block.push(lines[i].replace(/^ {4}/, "")); // dedent the code-block indent
    }
    const plan = parsePlanText(block.join("\n"));
    const chunk = plan.chunks.find((c) => c.number === 3);
    expect(chunk, "the example must parse into a chunk").toBeDefined();
    // The load-bearing assertion: the example yields a concrete, non-empty footprint
    // (empty would make the conflict-graph serialize it — no parallelism).
    expect(chunk!.footprint).toEqual(["src/routes/profile.tsx", "src/api/profile.ts"]);
    // And the companions the parallel scheduler also reads.
    expect(chunk!.dependsOn).toEqual([1, 2]);
    expect(chunk!.klass).toBe("leaf");
  });
});
