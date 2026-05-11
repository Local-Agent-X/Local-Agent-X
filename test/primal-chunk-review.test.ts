/**
 * /chunk-review fixture tests.
 *
 * Runs the gate logic against the four fixture chunks in
 * test/fixtures/primal-chunk-review/. Each fixture has an expectedAction
 * that the review pass MUST produce. These were lifted from the
 * Calenbella build's real review-pass turns where my manual review
 * caught the issue — they encode the discipline the skill is supposed
 * to enforce.
 *
 * Note on chunk-12: the fixture expects amend_spec, but the mechanical
 * gate alone classifies it as proceed (the agent reports SPEC_GAPS: none,
 * no Constitution mention, no fork phrase). Catching chunk-12
 * mechanically requires an external LLM judgment hook that reads the
 * chunk's CHANGED files against the constitution. The test asserts the
 * mechanical-only verdict (proceed) AND that supplying a synthesized
 * spec-gap surfaces it correctly. Closing the chunk-12 gap fully is a
 * follow-up — wire an LLM hook when one's available.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runChunkReview, runChunkReviewWithJudgment } from "../src/primal-auto-build/chunk-review/index.js";
import type { JudgmentHook } from "../src/primal-auto-build/chunk-review/judgment-hook.js";
import { parseChunkReport } from "../src/primal-auto-build/chunk-review/report-parser.js";
import {
  gateDoneWhen,
  gateAdditiveDiff,
  gateLaunchReadiness,
  gateTestFailures,
  gatePhaseGate,
  gateSpecGapJudgment,
  classifyDiff,
} from "../src/primal-auto-build/chunk-review/gates.js";
import type { ParsedChunk, ParsedPlan } from "../src/primal-auto-build/plan-parser.js";

const FIXTURE_DIR = join(__dirname, "fixtures", "primal-chunk-review");

interface Fixture {
  _comment: string;
  chunkNumber: number;
  chunkTitle: string;
  doneWhen: string;
  agentReport: string;
  expectedAction: "proceed" | "amend_spec" | "push_back" | "halt";
  expectedReasonContains: string;
  specDiff: { filePath: string; additions: string; removalsWithJustification: string[] } | null;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function chunkFromFixture(f: Fixture): ParsedChunk {
  return {
    number: f.chunkNumber,
    title: f.chunkTitle,
    phase: "Phase X — Test",
    klass: "trunk",
    slice: "(synthetic — derived from fixture)",
    dependsOn: [],
    scenarios: "—",
    doneWhen: f.doneWhen,
    rawSection: "",
  };
}

function emptyPlan(chunk: ParsedChunk): ParsedPlan {
  return {
    title: "Test plan",
    chunks: [chunk],
    phaseGatesRawSection: "",
    launchReadinessRows: [],
  };
}

describe("report parser", () => {
  it("parses a full structured report into fields", () => {
    const f = loadFixture("chunk-clean-proceed.json");
    const r = parseChunkReport(f.agentReport);
    expect(r.parsed).toBe(true);
    expect(r.status).toBe("done");
    expect(r.doneWhen).toBe("met");
    expect(r.testsPass).toBe(12);
    expect(r.testsTotal).toBe(12);
    expect(r.newFailures).toEqual([]);
    expect(r.changed).toContain("lib/calendar/adapter.ts");
    expect(r.specGaps).toBe("");
    expect(r.launchReadiness).toBe("");
  });

  it("marks parsed:false on a malformed report", () => {
    const r = parseChunkReport("just some prose with no fields");
    expect(r.parsed).toBe(false);
    expect(r.status).toBe("unknown");
  });

  it("captures multi-line NOTE bodies verbatim", () => {
    const f = loadFixture("chunk-10-silent-fallback.json");
    const r = parseChunkReport(f.agentReport);
    expect(r.note).toContain("Constitution #8 concern");
    expect(r.note.toLowerCase()).toContain("two options");
  });
});

describe("Calenbella fixture: chunk-clean-proceed → proceed", () => {
  it("returns proceed when all gates pass", () => {
    const f = loadFixture("chunk-clean-proceed.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
    });
    expect(outcome.action).toBe("proceed");
    expect(outcome.findings).toEqual([]);
  });
});

describe("Calenbella fixture: chunk-6 silent deferral → halt", () => {
  it("halts when DONE_WHEN: met but NOTE says 'launch-readiness deferred'", () => {
    const f = loadFixture("chunk-06-silent-deferral.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
    });
    expect(outcome.action).toBe("halt");
    expect(outcome.reasoning.toLowerCase()).toMatch(/deferr|integration test|silent/);
    const fired = outcome.findings.find(g => g.gate === "done-when");
    expect(fired).toBeDefined();
  });
});

describe("Calenbella fixture: chunk-10 constitution gray area → halt", () => {
  it("halts when NOTE surfaces a 'two options' fork", () => {
    const f = loadFixture("chunk-10-silent-fallback.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
    });
    expect(outcome.action).toBe("halt");
    const fired = outcome.findings.find(g => g.gate === "spec-gap-judgment");
    expect(fired).toBeDefined();
    expect(fired!.reasoning.toLowerCase()).toMatch(/two options|fork/);
  });
});

describe("Calenbella fixture: chunk-12 stale-data gap → mechanical proceed, amend_spec with LLM hook", () => {
  it("mechanical-only verdict is proceed (no fork phrase, no Constitution ref in NOTE)", () => {
    const f = loadFixture("chunk-12-stale-data-gap.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
    });
    expect(outcome.action).toBe("proceed");
  });

  it("classifies as amend_spec when an LLM judgment hook flags the implicit violation", async () => {
    const f = loadFixture("chunk-12-stale-data-gap.json");
    const chunk = chunkFromFixture(f);
    const mockHook: JudgmentHook = async () => ({
      specGap: f.specDiff?.additions || "Stale-data warning required on degraded connections.",
      reasoning: "Constitution #8 — no silent failures; booking page renders availability without notice on degraded connections.",
    });
    const outcome = await runChunkReviewWithJudgment({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
      projectDir: "/tmp/unused-by-mock",
    }, mockHook);

    expect(outcome.action).toBe("amend_spec");
    expect(outcome.report.specGaps).toContain("Stale-data");
    expect(outcome.reasoning).toContain("Constitution #8");
    expect(outcome.findings.find(f => f.gate === "spec-gap-judgment")).toBeDefined();
  });

  it("hook returning null leaves the mechanical verdict (proceed) intact", async () => {
    const f = loadFixture("chunk-12-stale-data-gap.json");
    const chunk = chunkFromFixture(f);
    const nullHook: JudgmentHook = async () => null;
    const outcome = await runChunkReviewWithJudgment({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
      projectDir: "/tmp/unused",
    }, nullHook);
    expect(outcome.action).toBe("proceed");
  });

  it("hook is NOT called when the mechanical verdict is already halt", async () => {
    const f = loadFixture("chunk-06-silent-deferral.json");
    const chunk = chunkFromFixture(f);
    let hookCalled = false;
    const trackingHook: JudgmentHook = async () => {
      hookCalled = true;
      return { specGap: "should not apply", reasoning: "should not run" };
    };
    const outcome = await runChunkReviewWithJudgment({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
      projectDir: "/tmp/unused",
    }, trackingHook);
    expect(outcome.action).toBe("halt");
    expect(hookCalled).toBe(false);
  });

  it("hook throwing returns the mechanical verdict (fail-open)", async () => {
    const f = loadFixture("chunk-12-stale-data-gap.json");
    const chunk = chunkFromFixture(f);
    const throwingHook: JudgmentHook = async () => { throw new Error("classifier down"); };
    const outcome = await runChunkReviewWithJudgment({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: f.agentReport,
      projectDir: "/tmp/unused",
    }, throwingHook);
    expect(outcome.action).toBe("proceed");
  });
});

describe("Additive-diff gate", () => {
  it("permits pure-addition diffs", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,1 +1,2 @@",
      " existing line",
      "+new constraint: must hash session tokens at rest",
    ].join("\n");
    expect(gateAdditiveDiff(diff)).toBeNull();
  });

  it("halts on a weakening diff (removing a 'must' constraint without replacement)", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,2 +1,1 @@",
      " existing line",
      "-session tokens must be hashed at rest",
    ].join("\n");
    const finding = gateAdditiveDiff(diff);
    expect(finding).not.toBeNull();
    expect(finding!.action).toBe("halt");
    expect(finding!.reasoning.toLowerCase()).toContain("weaken");
  });

  it("permits replacement-with-stricter-equivalent", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,1 +1,1 @@",
      "-session tokens are stored encrypted",
      "+session tokens must be hashed at rest with bcrypt; plaintext storage is forbidden",
    ].join("\n");
    const finding = gateAdditiveDiff(diff);
    expect(finding).toBeNull();
  });

  it("classifyDiff records weakened removals separately from stricter-replaced", () => {
    const diff = [
      "-the old loose rule",
      "+the rule is now must always enforce X",
      "-another constraint silently dropped",
    ].join("\n");
    const findings = classifyDiff(diff);
    expect(findings.weakened.length).toBe(1);
    expect(findings.weakened[0]).toContain("silently dropped");
    expect(findings.stricterReplacements.length).toBe(1);
  });
});

describe("Done-when gate edge cases", () => {
  const baseChunk: ParsedChunk = {
    number: 99,
    title: "Test",
    phase: "Phase X",
    klass: "trunk",
    slice: "",
    dependsOn: [],
    scenarios: "",
    doneWhen: "integration test returns 200",
    rawSection: "",
  };

  it("halts on STATUS: blocked", () => {
    const r = parseChunkReport(
      "STATUS: blocked\nDONE_WHEN: unmet\nCHANGED: none\nTESTS: n/a\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: missing creds"
    );
    expect(gateDoneWhen(baseChunk, r)!.action).toBe("halt");
  });

  it("halts on DONE_WHEN: unmet", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: unmet\nCHANGED: x.ts\nTESTS: 0/0\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: ok"
    );
    expect(gateDoneWhen(baseChunk, r)!.action).toBe("halt");
  });

  it("halts on deferred-to-launch-readiness when done-when names a mechanical contract", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: deferred-to-launch-readiness\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: integration test needs real creds; set X env then run pnpm test Y\nNOTE: ok"
    );
    expect(gateDoneWhen(baseChunk, r)!.action).toBe("halt");
  });

  it("permits 'met' when NOTE has no contradictory phrases", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 10/10\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: clean"
    );
    expect(gateDoneWhen(baseChunk, r)).toBeNull();
  });
});

describe("Launch-readiness gate", () => {
  it("permits an item with concrete verify steps", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: Apple Sign In e2e — set APPLE_* envs, run real OAuth round-trip, assert session cookie issued.\n" +
      "NOTE: clean"
    );
    expect(gateLaunchReadiness(r)).toBeNull();
  });

  it("halts on a vague launch-readiness item", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: something about staging at some point.\nNOTE: clean"
    );
    expect(gateLaunchReadiness(r)!.action).toBe("halt");
  });
});

describe("Test-failure gate", () => {
  it("halts on NEW_FAILURES", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/8\n" +
      "NEW_FAILURES: cancel_returns_409_when_already_cancelled, dst_fall_back\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: oops"
    );
    const f = gateTestFailures(r);
    expect(f!.action).toBe("halt");
    expect(f!.reasoning).toContain("cancel_returns_409");
  });

  it("does not halt when only PRE_EXISTING_FAILURES present", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 8/10\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: old_flaky_test\n" +
      "SPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: ok"
    );
    expect(gateTestFailures(r)).toBeNull();
  });
});

describe("Phase-gate detector", () => {
  it("halts at the last chunk of a phase referenced in phase-gates section", () => {
    const c5: ParsedChunk = {
      number: 5, title: "last", phase: "Phase A — Foundation", klass: "trunk",
      slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "",
    };
    const plan: ParsedPlan = {
      title: "P", chunks: [c5],
      phaseGatesRawSection: "## Phase verification gates\n\nAfter Phase A, drive scenarios at localhost:3000",
      launchReadinessRows: [],
    };
    const f = gatePhaseGate(c5, plan, [c5]);
    expect(f).not.toBeNull();
    expect(f!.action).toBe("halt");
    expect(f!.reasoning).toContain("Phase A");
  });

  it("does NOT halt on a mid-phase chunk", () => {
    const c1: ParsedChunk = { number: 1, title: "first", phase: "Phase A", klass: "trunk", slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "" };
    const c2: ParsedChunk = { number: 2, title: "mid", phase: "Phase A", klass: "trunk", slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "" };
    const plan: ParsedPlan = {
      title: "P", chunks: [c1, c2],
      phaseGatesRawSection: "## Phase verification gates\n\nAfter Phase A",
      launchReadinessRows: [],
    };
    expect(gatePhaseGate(c1, plan, [c1, c2])).toBeNull();
  });
});

describe("Spec-gap judgment gate", () => {
  it("halts on a 'two options' fork in NOTE", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: shipped. but two options for the edge case — A or B, your call."
    );
    expect(gateSpecGapJudgment(r)!.action).toBe("halt");
  });

  it("halts on Constitution + gray-area language", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: shipped. Constitution #8 concern — there's a silent fallback to defaults."
    );
    expect(gateSpecGapJudgment(r)!.action).toBe("halt");
  });

  it("does NOT halt on a clean NOTE", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: shipped cleanly. 5 unit tests pass."
    );
    expect(gateSpecGapJudgment(r)).toBeNull();
  });
});

describe("Fixture directory smoke test", () => {
  it("at least the 4 named fixtures exist", () => {
    const files = readdirSync(FIXTURE_DIR);
    expect(files).toContain("chunk-06-silent-deferral.json");
    expect(files).toContain("chunk-10-silent-fallback.json");
    expect(files).toContain("chunk-12-stale-data-gap.json");
    expect(files).toContain("chunk-clean-proceed.json");
  });
});
