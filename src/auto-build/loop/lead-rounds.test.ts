// A fix round decided by the build's lead, with the engine's guards on it.
// label-check-sol's chunk 1 closed every finding it was given and was set
// aside after three rounds anyway, ending the build (2026-11-24): a lead can
// keep such a chunk going, accept it with follow-ups, or narrow its contract.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { LeadDecision } from "../advisor/lead-decisions.js";
import { planLeadRound } from "./lead-rounds.js";

const chunk = { number: 1, title: "Android foundation", slice: "s", doneWhen: "fixtures prove every gate", scenarios: "—", dependsOn: [] } as unknown as ParsedChunk;
const plan = { chunks: [chunk] } as unknown as ParsedPlan;
const report = { status: "done", doneWhen: "met", note: "", specGaps: "" } as unknown as ChunkReviewOutcome["report"];
const sentBack = (gate: string, reasoning = "the size gate skips root build/") =>
  ({ action: "push_back", reasoning, findings: [{ gate, action: "push_back", reasoning }], report }) as unknown as ChunkReviewOutcome;

function round(decision: LeadDecision | null, outcome = sentBack("skeptic"), final = false) {
  const projectDir = mkdtempSync(join(tmpdir(), "lax-lead-round-"));
  mkdirSync(join(projectDir, "spec"));
  const said: string[] = [];
  const ask = vi.fn(async () => decision);
  const run = planLeadRound({
    lead: { projectDir, originSessionId: "chat-x" }, chunk, plan, outcome, totalChunks: 5, round: 3, earlier: [], repeated: false,
    projectDir, emit: (e) => { said.push(e.message); }, ask, ...(final ? { final } : {}),
  });
  return { run, said, projectDir, ask };
}
const buildState = (dir: string) => readFileSync(join(dir, "spec", "build-state.md"), "utf-8");

describe("planLeadRound", () => {
  it("accept lands the chunk and puts what is left on record", async () => {
    const { run, said, projectDir } = round({ action: "accept", reasoning: "the gates hold for every real layout", followUps: ["root build/ is skipped"] });
    const plan1 = await run;
    expect(plan1).toMatchObject({ kind: "land", outcome: { action: "proceed", reasoning: "Accepted by the build lead: the gates hold for every real layout" } });
    expect(buildState(projectDir)).toContain("- root build/ is skipped");
    expect(said[0]).toBe("build lead: accept — the gates hold for every real layout");
  });

  it("never accepts a chunk whose build, tests or held-out scenarios fail", async () => {
    for (const gate of ["build-exec", "chunk-scenarios"]) {
      const { run, said } = round({ action: "accept", reasoning: "good enough" }, sentBack(gate, "npm test exited 1"));
      expect(await run).toMatchObject({ kind: "rebuild", retryReason: expect.stringContaining("npm test exited 1") });
      expect(said[1]).toContain(`accept refused: the ${gate} check failed`);
    }
  });

  // label-check-sol's chunk 5: a native Android app the judge cannot start, and
  // its lead's "owed" was refused as if a scenario had failed (2026-11-25).
  it("lands a chunk whose scenarios could not be judged only with that owed, never on accept", async () => {
    const why = ".lax-launch.json has no start and ready_url, so the judge cannot start the app";
    const accepted = round({ action: "accept", reasoning: "fine" }, sentBack("chunk-unjudged", why));
    expect(await accepted.run).toMatchObject({ kind: "rebuild", retryReason: expect.stringContaining(why) });
    expect(accepted.said[1]).toContain("accept refused: the held-out scenarios were never judged");

    const owed = round({ action: "owed", reasoning: "native app, no URL", owedCheck: "run the sealed scenarios on the Galaxy" }, sentBack("chunk-unjudged", why));
    expect(await owed.run).toMatchObject({ kind: "land", outcome: { action: "proceed", owed: [{ check: "owed by the build lead", why: "a check is owed to the owner: run the sealed scenarios on the Galaxy" }] } });
  });

  it("narrow rebuilds against the lead's done-when, on record", async () => {
    const { run, projectDir } = round({ action: "narrow", reasoning: "no edge to it", doneWhen: "fixtures prove the size gate for src/" });
    const next = await run;
    expect(next).toMatchObject({ kind: "rebuild", chunk: { doneWhen: "fixtures prove the size gate for src/" } });
    expect(buildState(projectDir)).toContain("narrowed this chunk's done-when to: fixtures prove the size gate for src/");
  });

  it("continue sends the worker the lead's instruction with the finding; park stops on the owner's question", async () => {
    expect(await round({ action: "continue", reasoning: "real", instruction: "check root build/ too" }).run)
      .toMatchObject({ kind: "rebuild", retryReason: expect.stringMatching(/^check root build\/ too[\s\S]*size gate skips root build/) });
    expect(await round({ action: "park", reasoning: "taste", question: "Ship without the Android check?" }).run)
      .toEqual({ kind: "halt", reasoning: "The build lead needs the owner to decide: Ship without the Android check?", parked: true });
  });

  // label-check-sol's chunk 4 (2026-11-25): what was left needed a device and
  // a Firebase project only the owner had; parking set it aside and chunk 5
  // never started.
  it("owed lands the chunk unverified, with the owner's check on record", async () => {
    const { run, projectDir } = round({ action: "owed", reasoning: "all that runs here passes", owedCheck: "live scan on a Gemini Nano device with the owner's Firebase project" });
    const next = await run;
    expect(next).toMatchObject({ kind: "land", outcome: { action: "proceed", owed: [{ check: "owed by the build lead", why: expect.stringContaining("owed to the owner: live scan") }] } });
    expect(buildState(projectDir)).toContain("check owed to the owner: live scan");
  });

  it("owed and overrule are refused past failing tests or scenarios, like accept", async () => {
    for (const decision of [
      { action: "owed", reasoning: "r", owedCheck: "a device" },
      { action: "overrule", reasoning: "r", evidence: "it passes for me" },
    ] as LeadDecision[]) {
      expect(await round(decision, sentBack("build-exec", "npm test exited 1")).run).toMatchObject({ kind: "rebuild" });
    }
  });

  // Chunk 1's rounds were lost to a report-shape check rejecting concrete
  // verify steps three times (2026-11-25).
  it("overrule lands the chunk and records the check it overruled, with the evidence", async () => {
    const { run, said, projectDir } = round({ action: "overrule", reasoning: "the check misread the item", evidence: "the item names adb install and the result to require" }, sentBack("launch-readiness", "LAUNCH_READINESS item lacks a concrete verify step"));
    expect(await run).toMatchObject({ kind: "land", outcome: { action: "proceed" } });
    expect(said).toContainEqual(expect.stringContaining("engine check overruled by the build lead (launch-readiness)"));
    expect(buildState(projectDir)).toContain("Evidence it is wrong: the item names adb install");
  });

  it("a finding that came back unchanged goes to a fresh worker even when the lead says continue", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "lax-lead-round-"));
    const said: string[] = [];
    const next = await planLeadRound({
      lead: { projectDir, originSessionId: "chat-x" }, chunk, plan, outcome: sentBack("skeptic"), totalChunks: 5, round: 3, earlier: [], repeated: true,
      projectDir, emit: (e) => { said.push(e.message); }, ask: vi.fn(async () => ({ action: "continue", reasoning: "r", instruction: "again" }) as LeadDecision),
    });
    expect(next).toMatchObject({ kind: "rebuild", fresh: true });
    expect(said).toContainEqual(expect.stringContaining("goes to a fresh worker"));
  });

  it("split narrows the chunk to what it keeps and adds the rest to the plan as new chunks, on record", async () => {
    const { run, projectDir, said } = round({
      action: "split", reasoning: "the manual flow is done; scanning is its own work", doneWhen: "the manual flow checks names",
      parts: [{ title: "Camera scan", doneWhen: "a scanned label prefills names" }],
    });
    writeFileSync(join(projectDir, "spec", "plan.md"), "# Plan\n## Phase A — Build\n### Chunk 1 — Android foundation\n- **Slice:** s\n- **Depends on:** —\n- **Done when:** d\n");
    const next = await run;
    expect(next).toMatchObject({ kind: "rebuild", chunk: { doneWhen: "the manual flow checks names" } });
    expect(readFileSync(join(projectDir, "spec", "plan.md"), "utf-8")).toContain("### Chunk 101 — Camera scan");
    expect(buildState(projectDir)).toContain("Moved to new chunks: chunk 101 (Camera scan)");
    expect(said).toContainEqual("chunk 1 split: chunk(s) 101 added to the plan");
  });

  // The last word on a chunk whose rounds are spent (label-check-sol chunk 3,
  // 2026-11-25: the engine set it aside at the ceiling without asking).
  describe("once the rounds are spent", () => {
    it("the lead is told so, and its accept lands the chunk", async () => {
      const { run, ask } = round({ action: "accept", reasoning: "the manual flow works; the rest are new kinds of input" }, sentBack("skeptic"), true);
      expect(await run).toMatchObject({ kind: "land", outcome: { action: "proceed" } });
      expect(ask.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ final: true, maxRounds: 8 }), expect.anything()]);
    });

    it("an answer that would build again sets the chunk aside, and a narrowing is not recorded", async () => {
      for (const decision of [
        { action: "continue", reasoning: "one more edge", instruction: "fix it" },
        { action: "fresh", reasoning: "start over", instruction: "fix it" },
        { action: "narrow", reasoning: "smaller", doneWhen: "the manual flow" },
      ] as LeadDecision[]) {
        const { run, projectDir } = round(decision, sentBack("skeptic", "U+2028 splits an entry"), true);
        const next = await run;
        expect(next).toMatchObject({ kind: "halt", reasoning: expect.stringContaining("spent its 8 fix rounds") });
        expect((next as { reasoning: string }).reasoning).toContain("U+2028 splits an entry");
        expect(() => buildState(projectDir)).toThrow();
      }
    });

    it("an accept the engine refuses sets it aside too", async () => {
      const { run } = round({ action: "accept", reasoning: "good enough" }, sentBack("build-exec", "npm test exited 1"), true);
      expect(await run).toMatchObject({ kind: "halt" });
    });
  });

  it("no answer is no plan: the engine's rules decide", async () => {
    const { run, said } = round(null);
    expect(await run).toBeNull();
    expect(said[0]).toContain("no answer in time");
  });
});
