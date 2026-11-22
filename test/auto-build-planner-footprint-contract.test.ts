// Contract test: the /greenfield skill must keep teaching the model to declare
// per-chunk file footprints, AND its worked example must stay in a format the
// plan parser actually accepts and turns into a footprint.
//
// Why this exists: the parallel build path only fans chunks out when the plan
// declares disjoint `**Files:**` footprints (the parser + conflict-graph). The
// planner learns to emit those from the skill's plan reference,
// src/protocols/bundled/greenfield/references/spec.md (section 8). If that
// guidance or its example ever drifts out of the parseable grammar, parallelism
// silently reverts to serial with no test failure anywhere — this guards that seam.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_DIR } from "../scripts/check-skill-sync.mjs";
import { parsePlanText } from "../src/auto-build/plan-parser.js";

describe("greenfield planner ↔ parser footprint contract", () => {
  const body = readFileSync(join(BUNDLED_DIR, "greenfield", "references", "spec.md"), "utf-8").replace(/\r\n/g, "\n");

  it("the skill still instructs the planner to declare per-chunk files", () => {
    expect(body).toContain("**Files** is what autonomous mode schedules on.");
    expect(body).toContain("`run_build_plan` parses exactly this shape");
  });

  it("the skill's chunk example parses into the exact footprint the builder schedules on", () => {
    const fence = body.indexOf("```markdown\n## Phase B — Accounts");
    expect(fence, "example chunk present in references/spec.md").toBeGreaterThan(-1);
    const example = body.slice(fence + "```markdown\n".length, body.indexOf("\n```", fence + 3));
    const plan = parsePlanText(example);
    const chunk = plan.chunks.find((c) => c.number === 3);
    expect(chunk, "the example must parse into a chunk").toBeDefined();
    // The load-bearing assertion: a concrete, non-empty footprint (empty would make
    // the conflict-graph serialize it — no parallelism).
    expect(chunk!.footprint).toEqual(["src/routes/profile.tsx", "src/api/profile.ts"]);
    expect(chunk!.dependsOn).toEqual([1, 2]);
    expect(chunk!.klass).toBe("leaf");
    expect(chunk!.scenarios).toBe("4, 5");
  });
});
