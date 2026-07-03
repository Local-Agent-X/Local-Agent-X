/**
 * /chunk-review fixture tests.
 *
 * Runs the gate logic against the four fixture chunks in
 * test/fixtures/auto-build-chunk-review/. Each fixture has an expectedAction
 * that the review pass MUST produce. These were lifted from the
 * Bookwell build's real review-pass turns where manual review
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runChunkReview, runChunkReviewWithJudgment } from "../src/auto-build/chunk-review/index.js";
import type { JudgmentHook } from "../src/auto-build/chunk-review/judgment-hook.js";
import type { BuildExecRunner } from "../src/auto-build/chunk-review/gate-build-exec.js";
import { discoverCommands, findStaticEntry } from "../src/auto-build/chunk-review/gate-build-exec.js";
import { parseChunkReport } from "../src/auto-build/chunk-review/report-parser.js";
import {
  gateReportShape,
  gateDoneWhen,
  gateAdditiveDiff,
  gateLaunchReadiness,
  gateTestFailures,
  gatePhaseGate,
  gateSpecGapJudgment,
  classifyDiff,
} from "../src/auto-build/chunk-review/gates.js";
import type { ParsedChunk, ParsedPlan } from "../src/auto-build/plan-parser.js";

const FIXTURE_DIR = join(__dirname, "fixtures", "auto-build-chunk-review");

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

// Regression (2026-07-01 food-truck-tracker chunk 1): the worker did the
// chunk work but ended its run with no parseable report, and the old halt
// killed the build at 0/7. A shape failure must be a push_back (retry once
// with explicit format feedback) and must short-circuit the other gates —
// they would fire spuriously on the empty fields and outrank the retry.
describe("malformed report -> push_back retry, not halt", () => {
  it("returns push_back with only the report-shape finding", () => {
    const f = loadFixture("chunk-clean-proceed.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport: "Wrote app/layout.tsx\n\nTask 123 updated - status: completed",
    });
    expect(outcome.action).toBe("push_back");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0].gate).toBe("report-shape");
    expect(outcome.reasoning).toContain("STATUS:");
  });
});
// Regression: gateReportShape validated STRUCTURE (STATUS + DONE_WHEN buckets
// present → parsed=true) but not the STATUS VALUE. A worker writing a plausible
// synonym — "STATUS: complete" / "success" — coerced to status="unknown" yet
// parsed=true, sailing past the shape gate; paired with "DONE_WHEN: met" it also
// cleared gateDoneWhen (which only halts on blocked/partial) → the chunk
// committed to main on a status nobody can reason about. A mistyped
// "STATUS: blocked!" was worse: status="unknown" silently dropped the
// blocked/partial recovery paths. An unrecognized STATUS token is a shape
// failure → push_back retry, same as a missing report.
describe("unrecognized STATUS token -> push_back retry, not silent proceed", () => {
  it("gateReportShape fires push_back when a parseable report has status=unknown", () => {
    const r = parseChunkReport(
      "STATUS: complete\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: shipped it"
    );
    expect(r.parsed).toBe(true);      // structure is fine…
    expect(r.status).toBe("unknown"); // …but the STATUS token is not recognized
    const finding = gateReportShape(r)!;
    expect(finding.action).toBe("push_back");
    expect(finding.gate).toBe("report-shape");
    expect(finding.reasoning).toMatch(/done.*blocked.*partial/i);
  });

  it("still passes a valid STATUS: done", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: ok"
    );
    expect(gateReportShape(r)).toBeNull();
  });

  it("end-to-end: a 'STATUS: complete, DONE_WHEN: met' report does NOT proceed", () => {
    const f = loadFixture("chunk-clean-proceed.json");
    const chunk = chunkFromFixture(f);
    const outcome = runChunkReview({
      chunk,
      allChunks: [chunk],
      plan: emptyPlan(chunk),
      rawReport:
        "STATUS: complete\nDONE_WHEN: met\nCHANGED: x.ts\nTESTS: 5/5\n" +
        "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
        "LAUNCH_READINESS: none\nNOTE: all good",
    });
    expect(outcome.action).toBe("push_back"); // was silently "proceed" before the fix
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0].gate).toBe("report-shape");
  });
});

describe("Bookwell fixture: chunk-clean-proceed → proceed", () => {
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

describe("Bookwell fixture: chunk-6 silent deferral → halt", () => {
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

describe("Bookwell fixture: chunk-10 constitution gray area → halt", () => {
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

describe("Bookwell fixture: chunk-12 stale-data gap → mechanical proceed, amend_spec with LLM hook", () => {
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

  it("routes an explicit blocking spec gap through bounded advisor recovery", () => {
    const r = parseChunkReport(
      "STATUS: blocked\nDONE_WHEN: unmet\nCHANGED: none\nTESTS: n/a\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: Define the role redirect matrix.\n" +
      "LAUNCH_READINESS: none\nNOTE: stopped instead of guessing"
    );
    const finding = gateDoneWhen(baseChunk, r)!;
    expect(finding.action).toBe("push_back");
    expect(finding.reasoning).toMatch(/advisor/i);
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

describe("Review reasons carry the worker's own words", () => {
  // Regression (Jul 2 2026 food-truck run): chunk 2 halted with only
  // "STATUS=blocked; needs user attention" — the actual blocker lived in the
  // worker's NOTE, which existed nowhere durable. Diagnosis required log
  // spelunking across a transient agent session.
  it("blocked spec-gap recovery includes NOTE and SPEC_GAPS", () => {
    const r = parseChunkReport(
      "STATUS: blocked\nDONE_WHEN: unmet\nCHANGED: none\nTESTS: n/a\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\n" +
      "SPEC_GAPS: spec does not say whether the map may self-host leaflet assets\n" +
      "LAUNCH_READINESS: none\n" +
      "NOTE: write gate rejected leaflet CSS from cdnjs; need self-host guidance"
    );
    const f = gateDoneWhen(chunkFromFixture(loadFixture("chunk-clean-proceed.json")), r)!;
    expect(f.action).toBe("push_back");
    expect(f.reasoning).toContain("write gate rejected leaflet CSS");
    expect(f.reasoning).toContain("self-host leaflet assets");
  });

  it("unmet done-when halt includes NOTE", () => {
    const r = parseChunkReport(
      "STATUS: done\nDONE_WHEN: unmet\nCHANGED: x.ts\nTESTS: 1/2\n" +
      "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
      "LAUNCH_READINESS: none\nNOTE: e2e assertion needs a running dev server"
    );
    const f = gateDoneWhen(chunkFromFixture(loadFixture("chunk-clean-proceed.json")), r)!;
    expect(f.action).toBe("halt");
    expect(f.reasoning).toContain("running dev server");
  });
});

describe("Missing-credentials recovery (the no-Supabase-keys class)", () => {
  // Regression (Jul 2 2026, food-truck chunk 2): worker reported
  // STATUS=partial with "Build fails solely on missing Supabase credentials
  // (runtime infra, not code)" and the loop halted — the user had to type the
  // fake-keys recovery by hand. The gate now automates it as a retry-once.
  const report = (status: string, note: string, launch = "none", doneWhen = "unmet") =>
    parseChunkReport(
      `STATUS: ${status}\nDONE_WHEN: ${doneWhen}\nCHANGED: app/page.tsx\nTESTS: n/a\n` +
      `NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n` +
      `LAUNCH_READINESS: ${launch}\nNOTE: ${note}`
    );

  it("converts a cred-blocked partial into push_back carrying the recovery instruction", () => {
    const f = gateDoneWhen(
      chunkFromFixture(loadFixture("chunk-clean-proceed.json")),
      report("partial", "Build fails solely on missing Supabase credentials (runtime infra, not code). All chunk 2 logic implemented.")
    )!;
    expect(f.action).toBe("push_back");
    expect(f.reasoning).toContain("placeholder");
    expect(f.reasoning).toContain("LAUNCH_READINESS");
    expect(f.reasoning).toContain("missing Supabase credentials"); // worker words travel too
  });

  it("matches the env-var phrasing too", () => {
    const f = gateDoneWhen(
      chunkFromFixture(loadFixture("chunk-clean-proceed.json")),
      report("blocked", "Build fails on missing Supabase env vars.")
    )!;
    expect(f.action).toBe("push_back");
  });

  it("a non-credential block still halts", () => {
    const f = gateDoneWhen(
      chunkFromFixture(loadFixture("chunk-clean-proceed.json")),
      report("blocked", "Spec is ambiguous about whether the detail view is a modal or a page; need a decision.")
    )!;
    expect(f.action).toBe("halt");
  });

  // chunk-06's done-when ("integration test against a real Google dev
  // workspace returns…") IS mechanical per the gate's regex — the right
  // fixture for deferral behavior.
  it("allows a mechanical done-when deferral whose LAUNCH_READINESS names the credentials", () => {
    const f = gateDoneWhen(
      chunkFromFixture(loadFixture("chunk-06-silent-deferral.json")),
      report(
        "done",
        "Placeholder envs in .env.local; app builds and boots without the live service.",
        "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to real project values, then verify realtime map updates end-to-end.",
        "deferred-to-launch-readiness"
      )
    );
    expect(f).toBeNull(); // sanctioned deferral — gateLaunchReadiness enforces concreteness
  });

  it("still halts a mechanical deferral with no credential story", () => {
    const f = gateDoneWhen(
      chunkFromFixture(loadFixture("chunk-06-silent-deferral.json")),
      report("done", "Ran out of steam on the tests.", "verify later", "deferred-to-launch-readiness")
    )!;
    expect(f.action).toBe("halt");
    expect(f.reasoning).toContain("silent-deferral");
  });
});

// Regression (2026-07-03): the "says it's fixed but isn't" class. Every gate
// above reasons over STRINGS THE AGENT TYPED. A chunk that writes a perfectly
// clean report — STATUS: done / DONE_WHEN: met / TESTS: 5/5 / NEW_FAILURES:
// none — about a build that actually fails (or a browser game that renders a
// blank canvas) passed every string gate and committed to main. The
// build-execution gate is the first that OBSERVES behavior; these tests pin
// that a clean report can no longer proceed past an observed failure.
describe("build-exec gate: observed failure overrides a clean report", () => {
  const cleanReport =
    "STATUS: done\nDONE_WHEN: met\nCHANGED: index.html, game.js\nTESTS: 5/5\n" +
    "NEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\n" +
    "LAUNCH_READINESS: none\nNOTE: game builds and plays.";

  const withExec = (chunk: ParsedChunk, exec: BuildExecRunner, hook?: JudgmentHook) =>
    runChunkReviewWithJudgment(
      { chunk, allChunks: [chunk], plan: emptyPlan(chunk), rawReport: cleanReport, projectDir: "/tmp/unused-by-stub" },
      hook,
      undefined,
      exec,
    );

  it("halts a clean report when the build-exec gate observes a real failure", async () => {
    const chunk = chunkFromFixture(loadFixture("chunk-clean-proceed.json"));
    // Sanity: mechanically this report is a clean proceed — the bug is that
    // that USED to be the final verdict.
    expect(runChunkReview({ chunk, allChunks: [chunk], plan: emptyPlan(chunk), rawReport: cleanReport }).action).toBe("proceed");

    const failingExec: BuildExecRunner = async () => ({
      gate: "build-exec",
      action: "halt",
      reasoning: "`npm run build` exited 1 — the report claimed done but the command actually FAILS.",
    });
    const outcome = await withExec(chunk, failingExec);
    expect(outcome.action).toBe("halt"); // was silently "proceed" before the gate
    expect(outcome.findings.find(g => g.gate === "build-exec")).toBeDefined();
    expect(outcome.reasoning).toContain("actually FAILS");
  });

  it("proceeds when the build-exec gate observes success (gate doesn't just halt everything)", async () => {
    const chunk = chunkFromFixture(loadFixture("chunk-clean-proceed.json"));
    const passingExec: BuildExecRunner = async () => null;
    const outcome = await withExec(chunk, passingExec);
    expect(outcome.action).toBe("proceed");
  });

  it("runs BEFORE the LLM hook — a build failure halts even when the hook would proceed", async () => {
    const chunk = chunkFromFixture(loadFixture("chunk-clean-proceed.json"));
    let hookCalled = false;
    const hook: JudgmentHook = async () => { hookCalled = true; return null; };
    const failingExec: BuildExecRunner = async () => ({
      gate: "build-exec", action: "halt", reasoning: "built page renders NOTHING — blank screen.",
    });
    const outcome = await withExec(chunk, failingExec, hook);
    expect(outcome.action).toBe("halt");
    expect(hookCalled).toBe(false); // exec gate short-circuited before the hook
  });

  it("fails open — a crashing build-exec runner leaves the mechanical proceed intact", async () => {
    const chunk = chunkFromFixture(loadFixture("chunk-clean-proceed.json"));
    const throwingExec: BuildExecRunner = async () => { throw new Error("playwright missing"); };
    const outcome = await withExec(chunk, throwingExec);
    expect(outcome.action).toBe("proceed");
  });

  it("does NOT run when the mechanical verdict is already halt", async () => {
    const f = loadFixture("chunk-06-silent-deferral.json");
    const chunk = chunkFromFixture(f);
    let execCalled = false;
    const trackingExec: BuildExecRunner = async () => { execCalled = true; return null; };
    const outcome = await runChunkReviewWithJudgment(
      { chunk, allChunks: [chunk], plan: emptyPlan(chunk), rawReport: f.agentReport, projectDir: "/tmp/unused" },
      undefined, undefined, trackingExec,
    );
    expect(outcome.action).toBe("halt");
    expect(execCalled).toBe(false);
  });
});

describe("build-exec gate: command + entry discovery (pure)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildexec-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("prefers build then test from package.json scripts", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build", test: "vitest run", lint: "eslint" } }));
    expect(discoverCommands(dir)).toEqual(["npm run build", "npm test"]);
  });

  it("returns [] when there's no package.json — nothing to execution-verify", () => {
    expect(discoverCommands(dir)).toEqual([]);
  });

  it("returns only what exists (build without test)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(discoverCommands(dir)).toEqual(["npm run build"]);
  });

  it("finds a dist/index.html static entry to smoke", () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<canvas></canvas>");
    expect(findStaticEntry(dir)).toBe(join(dir, "dist", "index.html"));
  });

  it("returns null when there's no static entry — a server/CLI build has nothing to headless-load", () => {
    expect(findStaticEntry(dir)).toBeNull();
  });
});
