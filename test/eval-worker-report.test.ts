// The worker-report eval's scorer and its public cases. A scorer that passes a
// wrong report turns the eval into a green light for a model that is not fit
// to build, so what it counts as right is pinned here with no model call.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { missed } from "../eval/worker-report/run.js";
import { readChunkReport } from "../src/auto-build/agents/report-tools.js";
import type { ChunkReportCall } from "../src/auto-build/agents/agent-report.js";

const report = (over: Partial<ChunkReportCall> = {}): ChunkReportCall => ({
  status: "done", doneWhen: "met", note: "built it", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "", ...over,
});
const refused = [{ check: "npm run lint:native", reason: "blocked by Application Control policy" }];

describe("missed: what a report gets wrong against a case", () => {
  it("nothing, when every scored field is as the case says", () => {
    expect(missed({ status: ["done", "partial"], machineBlocked: true, ownerQuestion: false }, report({ machineBlocked: refused }))).toEqual([]);
  });

  it("a status or done-when outside the right ones", () => {
    expect(missed({ status: ["done"], doneWhen: ["deferred"] }, report({ status: "blocked", doneWhen: "unmet" }))).toEqual([
      "status blocked (right: done)", "done_when unmet (right: deferred)",
    ]);
  });

  it("a field that must be filled in and is empty, and one that must be empty and is not", () => {
    expect(missed({ machineBlocked: true }, report())).toEqual(["machine_blocked is empty"]);
    expect(missed({ ownerQuestion: false, specGaps: false }, report({ ownerQuestion: "modal or page?", specGaps: "assumed 24h" }))).toEqual([
      "owner_question is filled in with nothing to put there", "spec_gaps is filled in with nothing to put there",
    ]);
  });

  it("a field the case leaves out is not scored", () => {
    expect(missed({}, report({ status: "blocked", doneWhen: "unmet", ownerQuestion: "x", machineBlocked: refused }))).toEqual([]);
  });
});

describe("the public cases", () => {
  const cases = JSON.parse(readFileSync(join(__dirname, "..", "eval", "worker-report", "cases.json"), "utf-8")) as Array<{
    id: string; chunk: { number: number; title: string; slice: string; doneWhen: string }; happened: string;
    expect: Parameters<typeof missed>[0]; why: string;
  }>;

  it("each has a contract, a run, a reason, and at least one scored field", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.chunk.doneWhen && c.happened && c.why, c.id).toBeTruthy();
      expect(Object.keys(c.expect).length, c.id).toBeGreaterThan(0);
    }
  });

  // A case no report can satisfy would fail every model. For each, the report
  // its own expectations describe must be one the tool accepts.
  it("each can be answered right with a report the tool accepts", () => {
    for (const c of cases) {
      const args = {
        status: c.expect.status?.[0] ?? "done",
        done_when: c.expect.doneWhen?.[0] ?? "met",
        note: "what was built and shown",
        ...(c.expect.specGaps ? { spec_gaps: "assumed a rule" } : {}),
        ...(c.expect.ownerQuestion ? { owner_question: "which option?" } : {}),
        ...(c.expect.launchReadiness || c.expect.doneWhen?.[0] === "deferred" ? { launch_readiness: [{ what: "the live check", how_to_verify: "set the keys, run it" }] } : {}),
        ...(c.expect.machineBlocked ? { machine_blocked: [{ check: "npm run x", reason: "blocked by policy" }] } : {}),
      };
      const read = readChunkReport(args);
      expect("error" in read ? read.error : "", c.id).toBe("");
      expect(missed(c.expect, read as ChunkReportCall), c.id).toEqual([]);
    }
  });
});
