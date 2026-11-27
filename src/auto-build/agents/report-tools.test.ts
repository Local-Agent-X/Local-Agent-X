// The report tools check what a model hands them and say what is wrong, so the
// model corrects the call. Nothing a model types is parsed any more: the text
// block these replace read "NEW_FAILURES: none observed" as a failing test.
import { describe, it, expect } from "vitest";
import { deliverReport, openReportSlot, takeReport } from "./agent-report.js";
import { REPORT_TOOLS, chunkReportTool, readBreakerFindings, readChunkReport, readSkepticVerdict, skepticVerdictTool } from "./report-tools.js";
import { allTools } from "../../tools.js";

describe("readChunkReport", () => {
  const ok = { status: "done", done_when: "met", note: "built it; npm test passes" };

  it("reads a finished chunk, with nothing extra made up", () => {
    expect(readChunkReport(ok)).toEqual({ status: "done", doneWhen: "met", note: "built it; npm test passes", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" });
  });

  it("reads what could not be shown here, what the machine refused, and a question for the owner", () => {
    expect(readChunkReport({
      status: "partial", done_when: "deferred", note: "scan is wired; no phone here",
      launch_readiness: [{ what: "live scan", how_to_verify: "open the app on a Pixel and scan a label" }],
      machine_blocked: [{ check: "npm run check", reason: "An Application Control policy has blocked this file" }],
      owner_question: "Ship without offline mode?",
    })).toMatchObject({
      status: "partial", doneWhen: "deferred",
      launchReadiness: [{ what: "live scan", howToVerify: "open the app on a Pixel and scan a label" }],
      machineBlocked: [{ check: "npm run check", reason: "An Application Control policy has blocked this file" }],
      ownerQuestion: "Ship without offline mode?",
    });
  });

  it.each([
    [{ ...ok, status: "finished" }, "status must be one of"],
    [{ ...ok, done_when: "yes" }, "done_when must be one of"],
    [{ ...ok, note: "  " }, "note is required"],
    [{ ...ok, done_when: "unmet" }, "contradicts itself"],
    [{ ...ok, done_when: "deferred" }, "deferred needs launch_readiness"],
    [{ ...ok, launch_readiness: [{ what: "live scan" }] }, "how_to_verify"],
    [{ ...ok, machine_blocked: [{ check: "npm test" }] }, "what the machine printed"],
  ])("refuses %j, saying why", (args, why) => {
    expect(readChunkReport(args)).toEqual({ error: expect.stringContaining(why) });
  });
});

describe("readSkepticVerdict and readBreakerFindings", () => {
  it("a verdict needs what was shown, and a broken one its ground", () => {
    expect(readSkepticVerdict({ verdict: "holds", finding: "probed the edges" })).toEqual({ verdict: "holds", ground: "", finding: "probed the edges", followUps: [] });
    expect(readSkepticVerdict({ verdict: "broken", ground: "2 — its test passes without the fix", finding: "reverted the fix; the test stayed green", follow_ups: ["long names overflow", ""] }))
      .toEqual({ verdict: "broken", ground: "2 — its test passes without the fix", finding: "reverted the fix; the test stayed green", followUps: ["long names overflow"] });
    expect(readSkepticVerdict({ verdict: "broken", finding: "it double-books" })).toEqual({ error: expect.stringContaining("needs `ground`") });
    expect(readSkepticVerdict({ verdict: "maybe", finding: "x" })).toEqual({ error: expect.stringContaining("verdict must be one of") });
    expect(readSkepticVerdict({ verdict: "holds" })).toEqual({ error: expect.stringContaining("finding is required") });
  });

  it("findings are a list, empty when nothing broke; one that cannot be read is refused, never dropped", () => {
    expect(readBreakerFindings({ findings: [] })).toEqual({ findings: [] });
    const found = { severity: "high", text: "the list drops its last item", reach: "reachable", reach_why: "anyone who saves a second item" };
    expect(readBreakerFindings({ findings: [found] })).toEqual({ findings: [{ severity: "high", text: "the list drops its last item", reach: "reachable", reachWhy: "anyone who saves a second item" }] });
    // Whether a person using the app can cause it is said, never assumed.
    expect(readBreakerFindings({ findings: [{ severity: "high", text: "x" }] })).toEqual({ error: expect.stringContaining("each finding needs `reach`") });
    expect(readBreakerFindings({ findings: [{ ...found, reach: "unreachable", reach_why: "" }] })).toEqual({ error: expect.stringContaining("reach_why") });
    expect(readBreakerFindings({})).toEqual({ error: expect.stringContaining("findings must be a list") });
    expect(readBreakerFindings({ findings: [{ severity: "severe", text: "x" }] })).toEqual({ error: expect.stringContaining("each finding needs") });
    expect(readBreakerFindings({ findings: ["the list drops its last item"] })).toEqual({ error: expect.stringContaining("must be an object") });
  });
});

describe("delivering a report", () => {
  const args = (session: string) => ({ status: "done", done_when: "met", note: "n", _sessionId: session });

  it("reaches the slot the engine opened for that run, and the last call wins", async () => {
    openReportSlot("agent-run-1", "chunk");
    expect((await chunkReportTool.execute({ ...args("agent-run-1"), note: "first" })).isError).toBeFalsy();
    expect((await chunkReportTool.execute({ ...args("agent-run-1"), note: "second" })).content).toContain("Recorded");
    expect(takeReport("agent-run-1", "chunk")?.note).toBe("second");
    expect(takeReport("agent-run-1", "chunk")).toBeUndefined();
  });

  it("is refused for a session no build is waiting on, and for another role's tool", async () => {
    expect(await chunkReportTool.execute(args("chat-main"))).toMatchObject({ isError: true, content: expect.stringContaining("No build is waiting") });
    openReportSlot("agent-run-2", "skeptic");
    expect(await chunkReportTool.execute(args("agent-run-2"))).toMatchObject({ isError: true, content: expect.stringContaining("skeptic report tool") });
    expect((await skepticVerdictTool.execute({ verdict: "holds", finding: "f", _sessionId: "agent-run-2" })).isError).toBeFalsy();
    expect(takeReport("agent-run-2", "skeptic")?.verdict).toBe("holds");
  });

  it("a call the tool refuses records nothing and says how to fix it", async () => {
    openReportSlot("agent-run-3", "chunk");
    const refused = await chunkReportTool.execute({ ...args("agent-run-3"), done_when: "unmet" });
    expect(refused).toMatchObject({ isError: true, content: expect.stringContaining("call chunk_report again") });
    expect(takeReport("agent-run-3", "chunk")).toBeUndefined();
    expect(deliverReport(undefined, "chunk", {} as never)).toContain("No build is waiting");
  });
});

// The slot is in this process. A run whose every tool can be rebuilt in a
// worker process is moved to one (process-execution-backend.ts); allTools are
// registered that way, so the report tools must not be among them.
describe("where the report tools are registered", () => {
  it("not in allTools, so a run that offers one stays in the engine's process", () => {
    const names = REPORT_TOOLS.map((t) => t.name);
    expect(names).toEqual(["chunk_report", "skeptic_verdict", "breaker_findings"]);
    expect(allTools.filter((t) => names.includes(t.name))).toEqual([]);
  });
});
